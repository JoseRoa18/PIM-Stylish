import {
  openTemplate,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  colToIndex,
  indexToCol,
  downloadZip,
  templateExt,
} from './templateFiller';
import { accessoryKind } from '@/features/templates/api/templates';

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
// Pricing (USD), lead times, availability date, Like Product URL and the
// merchant email are Lowe's-program terms — left for the business to fill.

const attr = (p) => p.attributes || {};
const num = (v) => {
  if (v == null || v === '') return '';
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : '';
};
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const stripHtml = (h) =>
  String(h || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{2,}/g, '\n')
    .trim();
const brandMap = (b) => (/azuni/i.test(b || '') ? 'Azuni' : 'Stylish');

// Lowe's Merchandising Subdivision (Reference Data col A).
// 188 = KITCHEN SINKS & DISPOSERS · 225 = FAUCETS, SHOWERHEADS AND BATH DECOR
// · 155 = VANITIES AND VANITY TOPS (bathroom sinks live with vanities).
const subdivision = (p) => {
  if (p.category === 'bathroom_sink') return 155;
  if (/faucet|pot_filler/.test(p.category ?? '')) return 225;
  if (p.category === 'accessory' && accessoryKind(p) === 'soap dispenser') return 225;
  return 188;
};

// Lowe's Product Category — exact strings from the Reference Data closed list.
const productCategory = (p) => {
  switch (p.category) {
    case 'kitchen_sink': return 'Kitchen Sinks';
    case 'bathroom_sink': return 'Bathroom Sinks';
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

// Keyed by the row-5 tech name. Repeated packaging blocks (.0/.1/.2 = inner
// pack/case/pallet) are intentionally left untouched — we set up EACH only.
export const LOWES_RULES = {
  // ---- CORE ----
  productDesc: (p) => attr(p).general_title_en || p.model_name || p.sku,
  modelNum: (p) => p.sku,
  desc: (p) => stripHtml(p.description),
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

// Merge new cells into an existing <row> element: cells we write replace the
// originals at the same ref, everything else (styles, defaults) is kept, and
// the result stays in column order as OOXML requires.
function mergeRowXml(rowXml, newCellsByCol) {
  const open = rowXml.match(/^<row ([^>]*?)\/?>/);
  const attrs = open[1].replace(/\/\s*$/, '').trim();
  const cells = new Map();
  for (const m of rowXml.matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
    cells.set(colToIndex(m[1]), m[0]);
  }
  for (const [ci, xml] of newCellsByCol) cells.set(ci, xml);
  const body = [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('');
  return `<row ${attrs}>${body}</row>`;
}

// Walk the sheet XML once, splicing merged rows in ascending order.
function mergeRows(sheetXml, cellsByRow) {
  let out = '';
  let cursor = 0;
  for (const rn of [...cellsByRow.keys()].sort((a, b) => a - b)) {
    const start = sheetXml.indexOf(`<row r="${rn}"`, cursor);
    if (start === -1) continue;
    const tagClose = sheetXml.indexOf('>', start);
    const end = sheetXml[tagClose - 1] === '/' ? tagClose + 1 : sheetXml.indexOf('</row>', tagClose) + '</row>'.length;
    out += sheetXml.slice(cursor, start) + mergeRowXml(sheetXml.slice(start, end), cellsByRow.get(rn));
    cursor = end;
  }
  return out + sheetXml.slice(cursor);
}

/**
 * Fill a Lowe's US item setup template (in place) and download it.
 *
 * @param {string} templateStoragePath  path in the `templates` bucket
 * @param {Object[]} products           full product rows
 * @param {string} [fileName]
 */
export async function generateLowesFromTemplate(templateStoragePath, products, fileName = 'Lowes_Export') {
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
  await downloadZip(zip, fileName, templateExt(templateStoragePath));

  return { count: products.length };
}
