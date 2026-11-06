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
  labelTask,
  columnStyles,
  excelSerial,
  setFormulaResults,
  recalcOnOpen,
} from './templateFiller';
import { accessoryKind } from '@/features/templates/api/templates';
import { channelCategory, isFaucetCategory } from '@/features/products/lib/categories';
import { findCountry } from '@/features/products/lib/countries';
import { getStockFor } from '@/features/pricing/api/inventory';
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
// Program values (lead times, cost structure, MSRP=MAP) were
// verified 2026-08-19 against the coordinator's completed examples
// (108653_V4944896 item export + the SOS SDV188 July submission). Notables:
//   - Lowe's "MSRP" is the competitive suggested retail = our MAP USD, NOT
//     the PIM's msrp_usd (both examples set MSRP = MAP).
//   - Item Description is a SHORT name (max 33 chars, per the SOS
//     instructions sheet) — not the long marketing description.
//   - Non-applicable cost programs get 0.1 dummies; Freight Cost is 0.
// Still manual: Like Product URL (PIM has no ASIN/channel URLs).

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
  if (isFaucetCategory(p.category)) return 225;
  if (p.category === 'accessory') {
    const kind = accessoryKind(p);
    if (kind === 'soap dispenser') return 225;
    if (kind === 'strainer' || kind === 'drain') return 208;
  }
  return 188;
};

// Lowe's Product Category — exact strings from the Reference Data closed list.
const productCategory = (p) => {
  switch (channelCategory(p)) {
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
// examples. One place to update when the program terms change. The merchant
// email is not one: it changes often, so the export asks for it every time
// (LowesMerchantDialog, user 2026-11-06).
const LOWES_PROGRAM = {
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

// Today as a real Excel date: the column validates a date, its format shows it
// as mm/dd/yyyy, and the template's Readiness Score only counts a cell that
// passes its validation (text does not).
const todaySerial = (d = new Date()) =>
  excelSerial(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);

// BI Full Truckload Quantity - 53-ft Trailer (user, 2026-11-06): how many of the
// product's shipping boxes fit in a 53-ft dry van, by size alone. The best of
// the box's six orientations, every box laid the same way. Inside the trailer,
// in inches: length, width, height.
const TRAILER_53FT_IN = [630, 100, 108];
function truckloadQty(p) {
  const box = attr(p).shipping_dimensions_in ?? {};
  const [l, w, h] = [num(box.length), num(box.width), num(box.height)];
  if (!(l > 0 && w > 0 && h > 0)) return '';
  const [length, width, height] = TRAILER_53FT_IN;
  const fit = ([a, b, c]) => Math.floor(length / a) * Math.floor(width / b) * Math.floor(height / c);
  return Math.max(...[[l, w, h], [l, h, w], [w, l, h], [w, h, l], [h, l, w], [h, w, l]].map(fit)) || '';
}

// ---- The template's own lists ------------------------------------------------
//
// User rule (2026-11-06): a column with a closed list takes its value from the
// file — its Reference Data sheet, its dropdowns — and a free column goes as the
// PIM has it. The lists are read at every export, so a new version of the file
// rules by itself. A value that is not on its list is left blank and reported.
const REFERENCE_COLUMNS = {
  subDivision: 'Subdivision',
  productCat: 'Product Category',
  brand: 'Brand Name',
  countryofOrig: 'Country of Origin',
  netContentUOM: 'Net Content UOM',
  packagingType: 'Packaging Type',
  shipFromVBU: 'Ship From VBU Number',
};

const decodeXml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const listKey = (v) => String(v).trim().toLowerCase();
const listIndex = (values) => new Map(values.map((v) => [listKey(v), v]));

// 1-based column index → the values of its dropdown ("a,b,c" in the validation).
function dropdownsOf(sheetXml) {
  const out = new Map();
  const from = sheetXml.indexOf('<dataValidations');
  if (from === -1) return out;
  for (const m of sheetXml.slice(from).matchAll(/<dataValidation\b([^>]*?)>\s*<formula1>([^<]*)<\/formula1>/g)) {
    if (!/\btype="list"/.test(m[1])) continue;
    const formula = decodeXml(m[2]);
    if (!formula.startsWith('"')) continue;
    const values = formula.slice(1, -1).split(',').map((v) => v.trim());
    for (const part of (m[1].match(/\bsqref="([^"]+)"/)?.[1] ?? '').split(/\s+/)) {
      const range = part.match(/^([A-Z]+)\d+(?::([A-Z]+)\d+)?$/);
      if (!range) continue;
      for (let c = colToIndex(range[1]); c <= colToIndex(range[2] ?? range[1]); c++) out.set(c, values);
    }
  }
  return out;
}

async function referenceLists(zip, shared) {
  const out = new Map();
  const path = await sheetPathByName(zip, 'Reference Data');
  if (!path) return out;
  const grid = sheetToGrid(await zip.file(path).async('string'), shared);
  const header = grid[0] ?? [];
  for (const [tech, name] of Object.entries(REFERENCE_COLUMNS)) {
    const ci = header.indexOf(name);
    if (ci === -1) continue;
    out.set(tech, grid.slice(1).map((row) => row?.[ci]).filter((v) => v !== '' && v != null));
  }
  return out;
}

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
  // ISO 3-letter code: CHN, VNM… (it was China-only, so Vietnam came out blank).
  countryofOrig: (p) => findCountry(attr(p).country_of_origin || 'China')?.code3 ?? '',
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
  // AV Online - Customer Maximum Order Quantity stays blank (user, 2026-11-06).
  availabilityStartDt: () => todaySerial(),
  intitialLeadTime: () => LOWES_PROGRAM.initialLeadTimeDays, // (sic — Lowe's typo)
  intitialLeadTimeUOM: () => 'Days',
  processingLeadTime: () => LOWES_PROGRAM.processingDays,
  processingLeadTimeUOM: () => 'Days',
  lowesMerchEmail: (_p, { merchantEmail = '' } = {}) => merchantEmail,
  containerQty53ft: truckloadQty,
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
 * @param {object} [task]  a taskProgress reporter (optional)
 */
async function fillItemTemplate(templateStoragePath, products, task = null, { merchantEmail = '' } = {}) {
  if (!products?.length) throw new Error('No products to export.');

  const { zip, shared } = await openTemplate(templateStoragePath, { task: task?.part(0, 0.75) });
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
  const labels = grid[5] || [];
  if (!techNames.filter(Boolean).length) throw new Error('Could not read the Lowe\'s tech-name row.');

  // Data rows hold only the pre-filled cells, so the format is the column's.
  const styles = columnStyles(sheetXml);
  const dropdowns = dropdownsOf(sheetXml);
  const references = await referenceLists(zip, shared);
  const listOf = new Map();
  techNames.forEach((tech, ci) => {
    const values = references.get(String(tech ?? '').trim()) ?? dropdowns.get(ci + 1);
    if (values?.length) listOf.set(ci, listIndex(values));
  });

  const DATA_ROW = 7;
  if (task) {
    task.progress(0.8);
    await task.step(`Filling ${products.length} rows…`);
  }
  const offList = [];
  const cellsByRow = new Map();
  products.forEach((p, pi) => {
    const rowNum = DATA_ROW + pi;
    const cells = new Map();
    techNames.forEach((tech, ci) => {
      const rule = tech && LOWES_RULES[String(tech).trim()];
      if (!rule) return;
      let v;
      try { v = rule(p, { merchantEmail }); } catch { v = ''; }
      if (v === '' || v == null) return;
      const list = listOf.get(ci);
      if (list) {
        const listed = list.get(listKey(v));
        if (listed === undefined) {
          offList.push(`${p.sku} ${labels[ci] ?? tech} "${v}"`);
          return;
        }
        // The file's own spelling; a number stays a number (Subdivision).
        if (typeof v !== 'number') v = listed;
      }
      // 1-based column key — must match colToIndex() used for existing cells.
      cells.set(ci + 1, buildCell(`${indexToCol(ci + 1)}${rowNum}`, v, styles.get(ci + 1) ?? null));
    });
    if (cells.size) cellsByRow.set(rowNum, cells);
  });

  zip.file(tplPath, mergeRows(sheetXml, cellsByRow));
  task?.progress(1);
  return { zip, offList };
}

export async function generateLowesFromTemplate(templateStoragePath, products, fileName = 'Lowes_Export', { merchantEmail = '' } = {}) {
  const { zip, offList } = await fillItemTemplate(templateStoragePath, products, null, { merchantEmail });
  await downloadZip(zip, fileName, templateExt(templateStoragePath));
  return { count: products.length, offList };
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
// agrees, and each is checked against the dropdown it goes in (they depend on
// the Division above them). Costs/MSRP/MAP auto-fill from the PIM's USD pricing,
// the competitive block follows the team's conventions (Wayfair from the audit
// snapshot, "Not Listed Yet" elsewhere), and the stated lead time is a program
// constant. The Wayfair URL and the Additional_INFO contact/ship-point sheet
// remain manual.

// Fixed V6 column letters on "Item Proposal" (verified against row 15 labels
// and the July SDV188 submission). Cost structure per the instructions sheet:
// BE Prepaid = base cost + freight (we don't offer it → 0), BF Collect =
// base cost only (our Lowes/SOD/BBB cost). MSRP = MAP by Lowe's convention.
// BJ-BR = competitive retails/links/item numbers ("Not Listed Yet" when the
// product isn't on that channel — the team's own convention). BS Similar /
// Same Match stays blank (user, 2026-11-06). BU-CA are calculations and CB-CE
// are Décor-only: never write there.
const FREIGHT_COLS = {
  sdvName: 'A', sdvNum: 'B', pgNum: 'C', pgName: 'D', asstNum: 'E', asstName: 'F', marketing: 'G', gtin: 'H',
  model: 'J', desc: 'K', ltl: 'L', boxH: 'M', boxW: 'N', boxL: 'O', boxWgt: 'P',
  prepaidCost: 'BE', collectCost: 'BF', msrp: 'BG', map: 'BH', forecast: 'BI',
  hdRetail: 'BJ', wfRetail: 'BK', azRetail: 'BL',
  hdUrl: 'BM', wfUrl: 'BN', azUrl: 'BO',
  hdItem: 'BP', wfItem: 'BQ', azItem: 'BR',
  leadTime: 'BT',
  prepaidMargin: 'BW', collectMargin: 'BX', collectMarginAfterFreight: 'BY',
};

const FREIGHT_DIVISION = 'KITCHENS & BATH';

// The dropdowns of columns A, D, F and G read these blocks of "Assortments": a
// header row with one column per parent value, the values under it. Rows and
// depths are the ones in the template's own OFFSET formulas.
const ASSORTMENT_BLOCKS = {
  sdvByDivision: [18, 17],
  pgBySdv: [37, 32],
  assortmentByPg: [72, 72],
  marketingByDivision: [162, 500],
};
function blockReader(grid, [headerRow, depth]) {
  const header = grid[headerRow - 1] ?? [];
  return (parent) => {
    const ci = header.indexOf(parent);
    if (ci === -1) return [];
    const out = [];
    for (let r = headerRow; r < headerRow + depth; r++) {
      const v = grid[r]?.[ci];
      if (v !== '' && v != null) out.push(String(v));
    }
    return out;
  };
}

// GTIN = our UPC as it is (user, 2026-11-06); the column is text.
const gtin = (p) => String(attr(p).upc ?? p.upc ?? '').trim();

// 52 Week Unit Forecast (user, 2026-11-06): the USA stock; a product without
// stock takes what is on order for Odoo's Atlanta warehouse (Inventory →
// Reporting → Stock, warehouse ATL, Incoming); with neither, or if Odoo cannot
// be read, the team's default.
const FORECAST_WAREHOUSE = 'ATL';
const FORECAST_DEFAULT = 10;
async function loadForecasts(products) {
  const skus = products.map((p) => p.sku);
  const { us } = await getStockFor(skus);
  const inStock = (sku) => Number(us[sku]?.available) > 0;
  const noStock = skus.filter((sku) => !inStock(sku));
  let odoo = {};
  let odooError = null;
  if (noStock.length) {
    try {
      const { data, error } = await supabase.functions.invoke('odoo-stock', { body: { skus: noStock, warehouse: FORECAST_WAREHOUSE } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      odoo = data?.stock ?? {};
    } catch (err) {
      odooError = err?.message ?? String(err);
    }
  }
  const tally = { stock: 0, odoo: 0, fallback: 0, odooError };
  const bySku = new Map();
  for (const sku of skus) {
    const ordered = Math.round(Number(odoo[sku]?.incoming) || 0);
    if (inStock(sku)) { bySku.set(sku, Number(us[sku].available)); tally.stock += 1; }
    else if (ordered > 0) { bySku.set(sku, ordered); tally.odoo += 1; }
    else { bySku.set(sku, FORECAST_DEFAULT); tally.fallback += 1; }
  }
  return { bySku, tally };
}

// Assortment per product — SOS (special order / drop-ship) assortments, except
// kitchen sinks: SS KITCHEN SINKS, PG KITCHEN SINKS, SDV 188 (user, 2026-11-06).
const freightAssortment = (p) => {
  const t = `${p.product_type ?? ''} ${[attr(p).installation_type ?? []].flat().join(' ')}`;
  switch (channelCategory(p)) {
    case 'kitchen_sink': return 'SS KITCHEN SINKS';
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
 * @param {object} [task]  a taskProgress reporter (optional)
 */
async function fillFreightTemplate(templateStoragePath, products, task = null) {
  if (!products?.length) throw new Error('No products to export.');

  const { zip, shared } = await openTemplate(templateStoragePath, { task: task?.part(0, 0.6) });
  const tplPath = await sheetPathByName(zip, 'Item Proposal');
  if (!tplPath) throw new Error('The file has no "Item Proposal" sheet — is this the Lowe\'s SOS Freight Analysis template?');
  const sheetXml = await zip.file(tplPath).async('string');
  if (!/Supplier Model Number/.test(shared.join(''))) {
    throw new Error('Unexpected Freight Analysis layout — "Supplier Model Number" header not found.');
  }

  // Assortment → its SDV and PG, names and numbers, from the Assortments sheet
  // (same-row triples), and the dropdowns the names have to be on.
  const asstInfo = new Map();
  let aGrid = [];
  const aPath = await sheetPathByName(zip, 'Assortments');
  if (aPath) {
    aGrid = sheetToGrid(await zip.file(aPath).async('string'), shared);
    const headerIdx = aGrid.findIndex((r) => r?.[0] === 'Asst Name');
    for (let r = headerIdx + 1; r >= 1 && r < aGrid.length; r++) {
      const row = aGrid[r];
      if (row?.[0]) asstInfo.set(String(row[0]), { asstNum: row[1], sdv: row[2] ?? '', sdvNum: row[3], pg: row[4] ?? '', pgNum: row[5] });
    }
  }
  const sdvsOf = blockReader(aGrid, ASSORTMENT_BLOCKS.sdvByDivision);
  const pgsOf = blockReader(aGrid, ASSORTMENT_BLOCKS.pgBySdv);
  const assortmentsOf = blockReader(aGrid, ASSORTMENT_BLOCKS.assortmentByPg);
  const divisionSdvs = sdvsOf(FREIGHT_DIVISION);
  const marketingList = new Set(blockReader(aGrid, ASSORTMENT_BLOCKS.marketingByDivision)(FREIGHT_DIVISION));
  const offList = [];

  const put = (cells, rowNum, col, value) => {
    if (value === '' || value == null) return;
    cells.set(colToIndex(col), buildCell(`${col}${rowNum}`, value));
  };

  // Wayfair is the one competitive channel the PIM tracks (audit snapshots);
  // its public URL isn't in the API data, so that one cell stays manual.
  task?.progress(0.65, 'Reading the latest Wayfair snapshot…');
  const { data: wfSnap } = await supabase
    .from('channel_health')
    .select('results')
    .eq('channel', 'wayfair')
    .order('run_at', { ascending: false })
    .limit(1);
  const onWayfair = new Set((wfSnap?.[0]?.results ?? []).map((r) => r.sku));

  task?.progress(0.75, 'Reading the stock and what is on order…');
  const forecasts = await loadForecasts(products);

  const cellsByRow = new Map();
  // Top block: supplier identity + division (labels sit in column A).
  const top3 = new Map(); put(top3, 3, 'B', 'Stylish USA INC'); cellsByRow.set(3, top3);
  const top4 = new Map(); put(top4, 4, 'B', 108653); cellsByRow.set(4, top4);
  const top8 = new Map(); put(top8, 8, 'B', FREIGHT_DIVISION); cellsByRow.set(8, top8);

  const DATA_ROW = 16;
  // The file's cached formula results are empty and a workbook only recalculates
  // when told to, so the numbers the names resolve to are written too.
  const results = new Map([
    [3, new Map([['G', products.length]])],
    [11, new Map([['I', DATA_ROW + products.length - 1]])],
  ]);
  if (task) {
    task.progress(0.85);
    await task.step(`Filling ${products.length} rows…`);
  }
  products.forEach((p, pi) => {
    const rowNum = DATA_ROW + pi;
    const cells = new Map();
    const rowResults = new Map();
    const asst = freightAssortment(p);
    const info = asstInfo.get(asst);
    if (info && divisionSdvs.includes(info.sdv) && pgsOf(info.sdv).includes(info.pg) && assortmentsOf(info.pg).includes(asst)) {
      put(cells, rowNum, FREIGHT_COLS.sdvName, info.sdv);
      put(cells, rowNum, FREIGHT_COLS.pgName, info.pg);
      put(cells, rowNum, FREIGHT_COLS.asstName, asst);
      rowResults.set(FREIGHT_COLS.sdvNum, Number(info.sdvNum));
      rowResults.set(FREIGHT_COLS.pgNum, Number(info.pgNum));
      rowResults.set(FREIGHT_COLS.asstNum, Number(info.asstNum));
    } else {
      offList.push(`${p.sku} Assortment "${asst}" (SDV "${info?.sdv ?? 'not found'}" under ${FREIGHT_DIVISION})`);
    }
    const marketing = productCategory(p);
    if (marketingList.has(marketing)) put(cells, rowNum, FREIGHT_COLS.marketing, marketing);
    else offList.push(`${p.sku} Marketing Category "${marketing}"`);
    put(cells, rowNum, FREIGHT_COLS.gtin, gtin(p));
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
    put(cells, rowNum, FREIGHT_COLS.forecast, forecasts.bySku.get(p.sku));
    const map = num(p.map_usd);
    if (map > 0) {
      const collect = Number(num(p.cost_usd_lowes_sod_bbb)) || 0;
      rowResults.set(FREIGHT_COLS.prepaidMargin, 1); // Prepaid cost is 0
      rowResults.set(FREIGHT_COLS.collectMargin, (map - collect) / map);
      rowResults.set(FREIGHT_COLS.collectMarginAfterFreight, (map - collect) / map);
    }
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
    put(cells, rowNum, FREIGHT_COLS.leadTime, LOWES_PROGRAM.statedLeadTimeDays);
    cellsByRow.set(rowNum, cells);
    results.set(rowNum, rowResults);
  });

  // keepStyle: every row of this file is already formatted (currency, text…).
  zip.file(tplPath, setFormulaResults(mergeRows(sheetXml, cellsByRow, true), results));
  await recalcOnOpen(zip);
  task?.progress(1);
  return { zip, offList, forecast: forecasts.tally };
}

export async function generateLowesFreightFromTemplate(templateStoragePath, products, fileName = 'Lowes_Freight_Analysis') {
  const { zip, offList, forecast } = await fillFreightTemplate(templateStoragePath, products);
  await downloadZip(zip, fileName, templateExt(templateStoragePath));
  return { count: products.length, offList, forecast };
}

/** What an export of the set should tell the person: where the forecast came from, what was left blank. */
export function describeLowesExport({ forecast = null, offList = [] }) {
  const notes = [];
  if (forecast) notes.push(`52-week forecast: ${forecast.stock} from USA stock, ${forecast.odoo} from what is on order at Odoo's ${FORECAST_WAREHOUSE} warehouse, ${forecast.fallback} at ${FORECAST_DEFAULT}.`);
  if (forecast?.odooError) notes.push(`Odoo could not be read (${forecast.odooError}), so products without stock went at ${FORECAST_DEFAULT}.`);
  if (offList.length) notes.push(`Left blank, not on the template's lists: ${offList.slice(0, 6).join('; ')}${offList.length > 6 ? ` and ${offList.length - 6} more` : ''}.`);
  return notes.join(' ');
}

/**
 * Lowe's new-item setup is a two-file package: the Item Template (.xlsm) and
 * the SOS Freight Analysis (.xlsx). Fill every uploaded file and download the
 * whole set as ONE ZIP, each file kept under its original Lowe's name.
 *
 * @param {Object[]} templates  Lowe's template rows ({ file_name, storage_path })
 * @param {Object[]} products
 * @param {string} [baseName]
 * @param {{ task?: object, merchantEmail?: string }} [options]  `task`: a
 *   taskProgress reporter (filling the files 60%, writing them 30%, the ZIP the
 *   rest); `merchantEmail`: the Item Template's Lowes Merchant Email
 */
export async function generateLowesSet(templates, products, baseName = 'Lowes', { task = null, merchantEmail = '' } = {}) {
  const freightTpl = templates.find((t) => /freight|drop.?ship/i.test(t.file_name));
  const itemTpl = templates.find((t) => t !== freightTpl && /item|template|\.xlsm$/i.test(t.file_name));
  if (!itemTpl && !freightTpl) {
    throw new Error("No Lowe's template matched — upload the Item Template and/or the SOS Freight Analysis file.");
  }

  // Each file has its own slice of the bar (filling 0–60%, writing 60–90%)
  // and says which file it is.
  const n = (itemTpl ? 1 : 0) + (freightTpl ? 1 : 0);
  const slice = (i, from, to) => labelTask(
    task?.part(from + ((to - from) * i) / n, from + ((to - from) * (i + 1)) / n),
    n > 1 ? `File ${i + 1} of ${n}` : '',
  );
  const parts = [];
  if (itemTpl) parts.push({ name: itemTpl.file_name, ...(await fillItemTemplate(itemTpl.storage_path, products, slice(0, 0, 0.6), { merchantEmail })) });
  if (freightTpl) parts.push({ name: freightTpl.file_name, ...(await fillFreightTemplate(freightTpl.storage_path, products, slice(parts.length, 0, 0.6))) });

  const JSZip = await loadJSZip();
  const bundle = new JSZip();
  for (const [i, part] of parts.entries()) {
    const writing = slice(i, 0.6, 0.9);
    writing?.progress(0, `Writing ${part.name}…`);
    bundle.file(part.name, await part.zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }, writing ? (meta) => writing.progress(meta.percent / 100) : undefined));
  }
  const zipping = task?.part(0.9, 1);
  zipping?.progress(0, 'Writing the ZIP…');
  const out = await bundle.generateAsync({ type: 'blob', compression: 'DEFLATE' }, zipping ? (meta) => zipping.progress(meta.percent / 100) : undefined);
  const url = URL.createObjectURL(out);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${baseName}_${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return {
    count: products.length,
    files: parts.length,
    forecast: parts.find((part) => part.forecast)?.forecast ?? null,
    offList: parts.flatMap((part) => part.offList ?? []),
  };
}
