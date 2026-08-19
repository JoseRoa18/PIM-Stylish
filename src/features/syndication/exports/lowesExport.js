import {
  loadJSZip,
  openTemplate,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  colToIndex,
  indexToCol,
  downloadZip,
  templateExt,
  mergeRows,
} from './templateFiller';
import { accessoryKind } from '@/features/templates/api/templates';
import { supabase } from '@/lib/supabase';

// Fills the Lowe's US Item Setup template ("Core" sheet) in place.
//
// Layout: rows 1-3 vendor header (VBU, contact — pre-filled by the account),
// row 4 section bands, row 5 tech names (productDesc, modelNum…), row 6
// display labels, data from row 7. Rules are keyed by the ROW-5 tech name.
//
// Unlike every other marketplace file, the sheet ships with ALL 30k data rows
// already present in the XML (styled, with defaults: Selling Country=USA,
// Domestic, importer=No, hierarchy types EACH/INRPK/CASE/PLLT). Rows can't be
// injected — cells are MERGED into the existing <row> elements, preserving
// everything not overwritten. The workbook is macro-enabled (.xlsm): the
// Readiness Score in column A is computed by its VBA on open.
//
// The Reference Data sheet is the closed-list source; category/brand/country
// values below are exact strings from it ("Stylish"/"Azuni" both exist).
//
// Program values (lead times, merchant email, cost structure, MSRP=MAP) were
// verified 2026-08-19 against the coordinator's completed examples
// (108653_V4944896 item export + the SOS SDV188 July submission). Notables:
//   - Lowe's "MSRP" is the competitive suggested retail = our MAP USD, NOT
//     the PIM's msrp_usd (both examples set MSRP = MAP).
//   - Item Description is a SHORT name (max 33 chars, per the SOS
//     instructions sheet) — not the long marketing description.
//   - Non-applicable cost programs get 0.1 dummies; Freight Cost is 0.
// Still manual: Like Product URL (PIM has no ASIN/channel URLs) and the
// 53-ft truckload quantity.

const attr = (p) => p.attributes || {};
const num = (v) => {
  if (v == null || v === '') return '';
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : '';
};
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const brandMap = (b) => (/azuni/i.test(b || '') ? 'Azuni' : 'Stylish');

// Lowe's Merchandising Subdivision (Reference Data col A). Assignments match
// the SOS assortments in Lowe's own Freight Analysis file: 188 = KITCHEN
// SINKS & DISPOSERS · 225 = FAUCETS, SHOWERHEADS AND BATH DECOR · 130 =
// TOILETS & BATHING (SOS bathroom sinks) · 208 = PLUMBING REPAIR (strainers,
// drains).
const subdivision = (p) => {
  if (p.category === 'bathroom_sink') return 130;
  if (/faucet|pot_filler/.test(p.category ?? '')) return 225;
  if (p.category === 'accessory') {
    const kind = accessoryKind(p);
    if (kind === 'soap dispenser') return 225;
    if (kind === 'strainer' || kind === 'drain') return 208;
  }
  return 188;
};

// Lowe's Product Category — exact strings from the Reference Data closed list.
const productCategory = (p) => {
  switch (p.category) {
    case 'kitchen_sink': return 'Kitchen Sinks';
    case 'bathroom_sink': return 'Bathroom Sinks';
    case 'laundry_sink': return 'Utility Sinks';
    case 'bar_prep_sink': return 'Bar & Prep Sinks';
    // No outdoor-sink category at Lowe's; drop-in outdoor/ice-chest sinks list as bar sinks.
    case 'outdoor_sink': return 'Bar & Prep Sinks';
    case 'kitchen_faucet':
    case 'pot_filler': return 'Kitchen Faucets';
    case 'bathroom_faucet': return 'Bathroom Sink Faucets';
    case 'colander_drying_rack':
      return /colander/i.test(`${p.product_type ?? ''} ${attr(p).general_title_en ?? ''}`)
        ? 'Colanders'
        : 'Kitchen Sink Accessories';
    case 'accessory':
      switch (accessoryKind(p)) {
        case 'cutting board': return 'Cutting Boards';
        case 'strainer': return 'Kitchen Sink Strainers & Strainer Baskets';
        case 'soap dispenser': return 'Soap & Lotion Dispensers';
        case 'drain': return 'Sink Drains & Stoppers';
        case 'grid': return 'Sink Grids & Mats';
        default: return 'Kitchen Sink Accessories';
      }
    default: return '';
  }
};

const isWoodBoard = (p) =>
  accessoryKind(p) === 'cutting board' &&
  /wood|acacia|bamboo|teak|walnut/i.test(`${p.material ?? ''} ${attr(p).material ?? ''} ${attr(p).general_title_en ?? ''}`);

// Lowe's program constants, straight from the coordinator's completed
// examples. One place to update when the program terms change.
const LOWES_PROGRAM = {
  merchantEmail: 'sydney.l.helms@lowes.com',
  customerOrderLeadTimeDays: 4, // Customer Order Lead Time (special order)
  initialLeadTimeDays: 1,
  processingDays: 1,
  statedLeadTimeDays: 1, // freight file: processing + shipping
  dummyCost: 0.1, // programs we don't participate in still need a number
};

// "Item Description" is Lowe's SHORT name (max 33 chars per the SOS
// instructions; theirs look like "Stylish Versa42 Umount GrB w/Bk Acc":
// brand + collection name + abbreviated specs). Automatable approximation:
// brand + model name, then title words until the 33 chars run out. The
// template has NO dedicated product-name field — the name only travels here
// and inside the full Product Description.
const shortDesc = (p) => {
  const seedParts = [brandMap(p.brand)];
  const name = String(p.model_name ?? '').trim();
  if (name) seedParts.push(name);
  let out = seedParts.join(' ');
  const title = String(attr(p).general_title_en ?? '');
  for (const w of title.split(/\s+/)) {
    if (!w || out.toLowerCase().includes(w.toLowerCase())) continue;
    if (out.length + 1 + w.length > 33) break;
    out += ` ${w}`;
  }
  return out.slice(0, 33);
};

const usDate = (d = new Date()) =>
  `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

// Keyed by the row-5 tech name. Repeated packaging blocks (.0/.1/.2 = inner
// pack/case/pallet) are intentionally left untouched — we set up EACH only.
export const LOWES_RULES = {
  // ---- CORE ----
  productDesc: (p) => attr(p).general_title_en || p.model_name || p.sku,
  modelNum: (p) => p.sku,
  desc: shortDesc,
  subDivision: subdivision,
  productCat: productCategory,
  brand: (p) => brandMap(p.brand),
  countryofOrig: (p) => (/china|^chn?$/i.test(attr(p).country_of_origin || 'China') ? 'CHN' : ''),
  // sellingCty / productShipType / lowesImpOfRec ship pre-filled (USA / Domestic / No).
  availSellingChannel: () => 'Online',
  cAResidentsProp65Warnings: () => 'No',
  compMaterials: (p) => attr(p).material ?? p.material ?? '',
  textileMatInc: () => 'No',
  containsWood: (p) => (isWoodBoard(p) ? 'Yes' : 'No'),
  stateRegChemicalofConcern: () => 'No',

  // ---- PRICING (USD program pricing lives in the PIM since 2026-08) ----
  // MSRP = MAP by Lowe's convention. DTC + DC Collect carry the real
  // Lowes/SOD/BB&B cost; the programs we don't ship get the 0.1 dummy.
  msrp: (p) => num(p.map_usd),
  mapAmt: (p) => num(p.map_usd),
  dtcCost: (p) => num(p.cost_usd_lowes_sod_bbb),
  dcCollCost: (p) => num(p.cost_usd_lowes_sod_bbb),
  dcPPCost: () => LOWES_PROGRAM.dummyCost,
  storeDCCost: () => LOWES_PROGRAM.dummyCost,
  storeDPPCost: () => LOWES_PROGRAM.dummyCost,
  freightCost: () => 0,

  // ---- PROGRAM / AVAILABILITY (from the coordinator's examples) ----
  availableForSpecialOrder: () => 'Yes',
  directDelivery: () => 'Yes',
  exclDirDelivery: () => 'No',
  specialOrderLeadTime: () => LOWES_PROGRAM.customerOrderLeadTimeDays,
  specialOrderLeadTimeUOM: () => 'Days',
  orderMaxQty: () => 1,
  availabilityStartDt: () => usDate(),
  intitialLeadTime: () => LOWES_PROGRAM.initialLeadTimeDays, // (sic — Lowe's typo)
  intitialLeadTimeUOM: () => 'Days',
  processingLeadTime: () => LOWES_PROGRAM.processingDays,
  processingLeadTimeUOM: () => 'Days',
  lowesMerchEmail: () => LOWES_PROGRAM.merchantEmail,
  shipmentType: () => 'Floor Loaded',
  replenishMaxQty: () => 1,
  replenishMinQty: () => 1,
  replenishMultQty: () => 1,

  // ---- FULFILLMENT ----
  orderMinQty: () => 1,
  orderMultQty: () => 1,
  hazmatType: () => 'None of the Above',
  sasRestrictions: () => 'No',
  sellingUOM: () => 'Each',
  containsLiquid: () => 'No',
  multShipFromPoints: () => 'No',
  shipFromVBU: () => '517590', // Stylish USA INC — Reference Data "Ship From VBU"
  vmom: () => 1,
  productNested: () => 'No',
  squeezeClampSafe: () => 'No',
  minOrder: () => 1,
  minOrderUOM: () => 'Units',

  // ---- PACKAGING (EACH level) ----
  availableHierarchy: () => 'EACH',
  consumerUnit: () => 'Yes',
  barcodeType: () => 'UPCA',
  barcode: (p) => String(attr(p).upc ?? p.upc ?? '').replace(/\D/g, ''),
  depth: (p) => num(attr(p).shipping_dimensions_in?.length),
  width: (p) => num(attr(p).shipping_dimensions_in?.width),
  height: (p) => num(attr(p).shipping_dimensions_in?.height),
  dimUOM: () => 'Inches',
  netWgt: (p) => num(attr(p).product_weight_lb ?? p.weight_lb),
  grossWgt: (p) => num(p.shipping_weight_lb ?? attr(p).shipping_weight_lb),
  wgtUOM: () => 'lbs.',
  netContent: () => 1,
  netContentUOM: () => 'Each',
  packagingType: () => 'BOX',
  orderableUnit: () => 'Yes',
  orderUOM: () => 'Each',

  // ---- ENRICHMENT ----
  supplierBullet1: (p) => list(attr(p).bullet_points)[0] ?? '',
  supplierBullet2: (p) => list(attr(p).bullet_points)[1] ?? '',
  supplierBullet3: (p) => list(attr(p).bullet_points)[2] ?? '',
};

/**
 * Fill a Lowe's US item setup template (in place) and download it.
 *
 * @param {string} templateStoragePath  path in the `templates` bucket
 * @param {Object[]} products           full product rows
 * @param {string} [fileName]
 */
async function fillItemTemplate(templateStoragePath, products) {
  if (!products?.length) throw new Error('No products to export.');

  const { zip, shared } = await openTemplate(templateStoragePath);
  const tplPath = await sheetPathByName(zip, 'Core');
  if (!tplPath) throw new Error('The file has no "Core" sheet — is this a Lowe\'s item template?');
  const sheetXml = await zip.file(tplPath).async('string');

  // The sheet holds 30k rows (~10 MB) — parse only the header rows for the
  // tech-name → column map instead of DOM-parsing the whole sheet.
  const headerXml = (() => {
    const start = sheetXml.indexOf('<row r="5"');
    const end = sheetXml.indexOf('</row>', sheetXml.indexOf('<row r="6"')) + '</row>'.length;
    if (start === -1 || end < 6) return null;
    // Strip namespaced attributes (x14ac:dyDescent…) — the wrapper doesn't
    // declare their prefixes and DOMParser would reject the fragment.
    const fragment = sheetXml.slice(start, end).replace(/\s+[a-z0-9]+:[a-zA-Z0-9]+="[^"]*"/g, '');
    return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${fragment}</sheetData></worksheet>`;
  })();
  if (!headerXml) throw new Error('Could not locate the Lowe\'s header rows (5-6).');
  const grid = sheetToGrid(headerXml, shared);
  const techNames = grid[4] || [];
  if (!techNames.filter(Boolean).length) throw new Error('Could not read the Lowe\'s tech-name row.');

  const DATA_ROW = 7;
  const cellsByRow = new Map();
  products.forEach((p, pi) => {
    const rowNum = DATA_ROW + pi;
    const cells = new Map();
    techNames.forEach((tech, ci) => {
      const rule = tech && LOWES_RULES[String(tech).trim()];
      if (!rule) return;
      let v;
      try { v = rule(p); } catch { v = ''; }
      if (v === '' || v == null) return;
      // 1-based column key — must match colToIndex() used for existing cells.
      cells.set(ci + 1, buildCell(`${indexToCol(ci + 1)}${rowNum}`, v));
    });
    if (cells.size) cellsByRow.set(rowNum, cells);
  });

  zip.file(tplPath, mergeRows(sheetXml, cellsByRow));
  return zip;
}

export async function generateLowesFromTemplate(templateStoragePath, products, fileName = 'Lowes_Export') {
  const zip = await fillItemTemplate(templateStoragePath, products);
  await downloadZip(zip, fileName, templateExt(templateStoragePath));
  return { count: products.length };
}

// ---- SOS Drop Ship Freight Analysis (New Assortment V6) ---------------------
//
// Second Lowe's file: the new-item PROPOSAL — assortment placement, GTIN,
// box dimensions and the freight/pricing questionnaire. "Item Proposal" holds
// data from row 16; every row pre-carries VLOOKUP formulas that resolve
// SDV # / PG # / Asst # from the names in A/D/F, so cells are merged the same
// way as the item template. The "Assortments" sheet lists every assortment
// with its SDV and PG on the same row (header "Asst Name" ~row 664) — SDV and
// PG names are looked up there from our chosen assortment so the trio always
// agrees. Costs/MSRP/MAP auto-fill from the PIM's USD pricing, the
// competitive block follows the team's conventions (Wayfair from the audit
// snapshot, "Not Listed Yet" elsewhere), and the stated lead time is a
// program constant. Only the 52-week forecast and the Wayfair URL remain
// manual — plus the Additional_INFO contact/ship-point sheet.

// Fixed V6 column letters on "Item Proposal" (verified against row 15 labels
// and the July SDV188 submission). Cost structure per the instructions sheet:
// BE Prepaid = base cost + freight (we don't offer it → 0), BF Collect =
// base cost only (our Lowes/SOD/BBB cost). MSRP = MAP by Lowe's convention.
// BJ-BR = competitive retails/links/item numbers ("Not Listed Yet" when the
// product isn't on that channel — the team's own convention). BU-CA are
// calculations and CB-CE are Décor-only: never write there.
const FREIGHT_COLS = {
  sdvName: 'A', pgName: 'D', asstName: 'F', marketing: 'G', gtin: 'H',
  model: 'J', desc: 'K', ltl: 'L', boxH: 'M', boxW: 'N', boxL: 'O', boxWgt: 'P',
  prepaidCost: 'BE', collectCost: 'BF', msrp: 'BG', map: 'BH',
  hdRetail: 'BJ', wfRetail: 'BK', azRetail: 'BL',
  hdUrl: 'BM', wfUrl: 'BN', azUrl: 'BO',
  hdItem: 'BP', wfItem: 'BQ', azItem: 'BR',
  match: 'BS', leadTime: 'BT',
};

const gtin14 = (p) => {
  const upc = String(attr(p).upc ?? p.upc ?? '').replace(/\D/g, '');
  return upc ? upc.padStart(14, '0') : '';
};

// Assortment per product — SOS (special order / drop-ship) assortments only.
const freightAssortment = (p) => {
  const t = `${p.product_type ?? ''} ${[attr(p).installation_type ?? []].flat().join(' ')}`;
  switch (p.category) {
    case 'kitchen_sink':
    case 'bar_prep_sink':
    case 'outdoor_sink':
    case 'laundry_sink': return 'SOS SINKS';
    case 'bathroom_sink':
      if (/vessel/i.test(t)) return 'SOS VESSEL SINKS';
      if (/pedestal/i.test(t)) return 'SOS PEDESTAL SINKS';
      if (/wall/i.test(t)) return 'SOS WALL HUNG SINKS';
      if (/drop|top.?mount|dual/i.test(t)) return 'SOS DROP IN SINKS';
      return 'SOS UNDERMOUNT SINKS';
    case 'kitchen_faucet':
    case 'pot_filler': return 'SOS KITCHEN FAUCETS OTHER';
    case 'bathroom_faucet': return 'SOS FAUCETS OTHER';
    case 'accessory':
      switch (accessoryKind(p)) {
        case 'strainer': return 'SOS KITCHEN SINK STRAINERS';
        case 'drain': return 'SOS BATH SINK DRAINS';
        default: return 'SOS KITCHEN ACCESSORIES';
      }
    default: return 'SOS KITCHEN ACCESSORIES'; // colanders, racks & the rest
  }
};

/**
 * Fill the Lowe's SOS Drop Ship Freight Analysis template (in place).
 *
 * @param {string} templateStoragePath  path in the `templates` bucket
 * @param {Object[]} products           full product rows
 * @param {string} [fileName]
 */
async function fillFreightTemplate(templateStoragePath, products) {
  if (!products?.length) throw new Error('No products to export.');

  const { zip, shared } = await openTemplate(templateStoragePath);
  const tplPath = await sheetPathByName(zip, 'Item Proposal');
  if (!tplPath) throw new Error('The file has no "Item Proposal" sheet — is this the Lowe\'s SOS Freight Analysis template?');
  const sheetXml = await zip.file(tplPath).async('string');
  if (!/Supplier Model Number/.test(shared.join(''))) {
    throw new Error('Unexpected Freight Analysis layout — "Supplier Model Number" header not found.');
  }

  // Assortment → { sdv, pg } from the Assortments sheet (same-row triples).
  const asstInfo = new Map();
  const aPath = await sheetPathByName(zip, 'Assortments');
  if (aPath) {
    const aGrid = sheetToGrid(await zip.file(aPath).async('string'), shared);
    const headerIdx = aGrid.findIndex((r) => r?.[0] === 'Asst Name');
    for (let r = headerIdx + 1; r >= 1 && r < aGrid.length; r++) {
      const row = aGrid[r];
      if (row?.[0]) asstInfo.set(String(row[0]), { sdv: row[2] ?? '', pg: row[4] ?? '' });
    }
  }

  const put = (cells, rowNum, col, value) => {
    if (value === '' || value == null) return;
    cells.set(colToIndex(col), buildCell(`${col}${rowNum}`, value));
  };

  // Wayfair is the one competitive channel the PIM tracks (audit snapshots);
  // its public URL isn't in the API data, so that one cell stays manual.
  const { data: wfSnap } = await supabase
    .from('channel_health')
    .select('results')
    .eq('channel', 'wayfair')
    .order('run_at', { ascending: false })
    .limit(1);
  const onWayfair = new Set((wfSnap?.[0]?.results ?? []).map((r) => r.sku));

  const cellsByRow = new Map();
  // Top block: supplier identity + division (labels sit in column A).
  const top3 = new Map(); put(top3, 3, 'B', 'Stylish USA INC'); cellsByRow.set(3, top3);
  const top4 = new Map(); put(top4, 4, 'B', 108653); cellsByRow.set(4, top4);
  const top8 = new Map(); put(top8, 8, 'B', 'KITCHENS & BATH'); cellsByRow.set(8, top8);

  const DATA_ROW = 16;
  products.forEach((p, pi) => {
    const rowNum = DATA_ROW + pi;
    const cells = new Map();
    const asst = freightAssortment(p);
    const info = asstInfo.get(asst);
    put(cells, rowNum, FREIGHT_COLS.sdvName, info?.sdv ?? '');
    put(cells, rowNum, FREIGHT_COLS.pgName, info?.pg ?? '');
    put(cells, rowNum, FREIGHT_COLS.asstName, asst);
    put(cells, rowNum, FREIGHT_COLS.marketing, productCategory(p));
    put(cells, rowNum, FREIGHT_COLS.gtin, gtin14(p));
    put(cells, rowNum, FREIGHT_COLS.model, p.sku);
    put(cells, rowNum, FREIGHT_COLS.desc, shortDesc(p)); // max 33 chars
    const wgt = num(p.shipping_weight_lb ?? attr(p).shipping_weight_lb);
    put(cells, rowNum, FREIGHT_COLS.ltl, wgt !== '' && wgt >= 150 ? 'Yes' : 'No');
    put(cells, rowNum, FREIGHT_COLS.boxH, num(attr(p).shipping_dimensions_in?.height));
    put(cells, rowNum, FREIGHT_COLS.boxW, num(attr(p).shipping_dimensions_in?.width));
    put(cells, rowNum, FREIGHT_COLS.boxL, num(attr(p).shipping_dimensions_in?.length));
    put(cells, rowNum, FREIGHT_COLS.boxWgt, wgt);
    put(cells, rowNum, FREIGHT_COLS.prepaidCost, 0);
    put(cells, rowNum, FREIGHT_COLS.collectCost, num(p.cost_usd_lowes_sod_bbb));
    put(cells, rowNum, FREIGHT_COLS.msrp, num(p.map_usd)); // MSRP = MAP at Lowe's
    put(cells, rowNum, FREIGHT_COLS.map, num(p.map_usd));
    const NOT_LISTED = 'Not Listed Yet';
    const wf = onWayfair.has(p.sku);
    put(cells, rowNum, FREIGHT_COLS.hdRetail, NOT_LISTED);
    put(cells, rowNum, FREIGHT_COLS.wfRetail, wf ? num(p.map_usd) : NOT_LISTED);
    put(cells, rowNum, FREIGHT_COLS.azRetail, NOT_LISTED);
    put(cells, rowNum, FREIGHT_COLS.hdUrl, NOT_LISTED);
    if (!wf) put(cells, rowNum, FREIGHT_COLS.wfUrl, NOT_LISTED); // listed → paste URL by hand
    put(cells, rowNum, FREIGHT_COLS.azUrl, NOT_LISTED);
    put(cells, rowNum, FREIGHT_COLS.hdItem, NOT_LISTED);
    put(cells, rowNum, FREIGHT_COLS.wfItem, wf ? p.sku : NOT_LISTED);
    put(cells, rowNum, FREIGHT_COLS.azItem, NOT_LISTED);
    if (wf) put(cells, rowNum, FREIGHT_COLS.match, 'Same Match');
    put(cells, rowNum, FREIGHT_COLS.leadTime, LOWES_PROGRAM.statedLeadTimeDays);
    cellsByRow.set(rowNum, cells);
  });

  zip.file(tplPath, mergeRows(sheetXml, cellsByRow));
  return zip;
}

export async function generateLowesFreightFromTemplate(templateStoragePath, products, fileName = 'Lowes_Freight_Analysis') {
  const zip = await fillFreightTemplate(templateStoragePath, products);
  await downloadZip(zip, fileName, templateExt(templateStoragePath));
  return { count: products.length };
}

/**
 * Lowe's new-item setup is a two-file package: the Item Template (.xlsm) and
 * the SOS Freight Analysis (.xlsx). Fill every uploaded file and download the
 * whole set as ONE ZIP, each file kept under its original Lowe's name.
 *
 * @param {Object[]} templates  Lowe's template rows ({ file_name, storage_path })
 * @param {Object[]} products
 * @param {string} [baseName]
 */
export async function generateLowesSet(templates, products, baseName = 'Lowes') {
  const freightTpl = templates.find((t) => /freight|drop.?ship/i.test(t.file_name));
  const itemTpl = templates.find((t) => t !== freightTpl && /item|template|\.xlsm$/i.test(t.file_name));
  if (!itemTpl && !freightTpl) {
    throw new Error("No Lowe's template matched — upload the Item Template and/or the SOS Freight Analysis file.");
  }

  const parts = [];
  if (itemTpl) parts.push({ name: itemTpl.file_name, zip: await fillItemTemplate(itemTpl.storage_path, products) });
  if (freightTpl) parts.push({ name: freightTpl.file_name, zip: await fillFreightTemplate(freightTpl.storage_path, products) });

  const JSZip = await loadJSZip();
  const bundle = new JSZip();
  for (const part of parts) {
    bundle.file(part.name, await part.zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }));
  }
  const out = await bundle.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const url = URL.createObjectURL(out);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${baseName}_${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return { count: products.length, files: parts.length };
}
