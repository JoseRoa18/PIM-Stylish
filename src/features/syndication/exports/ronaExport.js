import { supabase } from '@/lib/supabase';
import { etToday } from '@/features/pricing/lib/promoCalendar';
import { readingCounts } from '@/features/pricing/lib/pageStores';
import { RONA_SUPPLIER } from '@/features/pricing/lib/ronaPromoFill';
import { getMediaUrl } from '@/features/media/api/media';
import {
  buildCell, colToIndex, downloadZip, excelSerial, fetchImagesBySku, mergeRows, norm, openTemplate, sheetPathByName, sheetToGrid, templateExt,
} from './templateFiller';

// Rona's new listing: the "Vendor Quote Sheet" (user, 2026-11-09). One sheet,
// labels on row 3, one row per product from row 4. Columns repeat their labels
// (five boxes, five warehouses), so they are addressed by letter and the labels
// that anchor them are checked first.
const SHEET = 'Vendor Quote Sheet';
const HEADER_ROW = 3;
const FIRST_ROW = 4;
const ANCHORS = { C: 'manufacturerpartnumber', D: 'upc', L: 'invoicecostshippingpaidbyrona', W: 'lengthin', Z: 'boxedweightlbs', AQ: 'shiponskidyn', BK: 'hscode' };
const CATEGORY_SHEET = 'Product Categories';

const BOX_COLUMNS = [['W', 'X', 'Y', 'Z'], ['AA', 'AB', 'AC', 'AD'], ['AE', 'AF', 'AG', 'AH'], ['AI', 'AJ', 'AK', 'AL'], ['AM', 'AN', 'AO', 'AP']];
// The store pages the PIM already reads, by the template's retail price column
// (HomeHardware.ca and CanadianTire.ca are not read).
const COMPETITORS = { P: 'homedepot_ca', R: 'amazon_ca', S: 'walmart_ca', U: 'wayfair_ca', V: 'bestbuy_ca' };
// The one warehouse everything ships from (user, 2026-11-09).
const WAREHOUSE = { address: '85 Thompson Dr, Cambridge, ON, Canada', postalCode: 'N1T 2E4', loadingDock: 'Y' };

// Everything ships from Canada (user, 2026-11-09), so HS Code stays empty: the
// template asks for it only when shipping from the USA.
const KB = 'KITCHENS & BATH||';
const CATEGORY = {
  kitchen_sink: `${KB}Kitchen Sinks`,
  bathroom_sink: `${KB}Bathroom Sinks`,
  bar_prep_sink: `${KB}Bar & Prep Sinks`,
  laundry_sink: `${KB}Utility Sinks`,
  outdoor_sink: 'LAWN & GARDEN||Outdoor Sink Stations',
  kitchen_faucet: `${KB}Kitchen Faucets`,
  kitchen_faucet_combo: `${KB}Kitchen Faucets`,
  cold_water_tap: `${KB}Kitchen Faucets`,
  pot_filler: `${KB}Kitchen Faucets`,
  bathroom_faucet: `${KB}Bathroom Sink Faucets`,
};
// First match wins: a "Cutting Board with Colander" is a board.
const ACCESSORY = [
  [/cutting board|serving board/i, 'DECOR||Cutting Boards'],
  [/\bkit\b/i, `${KB}Kitchen Sink Accessory Kits`],
  [/drain|overflow/i, 'ROUGH PLUMBING||Sink Drains & Stoppers'],
  [/strainer/i, `${KB}Kitchen Sink Strainers & Strainer Baskets`],
  [/colander/i, 'DECOR||Colanders'],
  [/soap|lotion/i, `${KB}Soap & Lotion Dispensers`],
  [/faucet plate|deck plate/i, `${KB}Faucet Accessories`],
  [/hose/i, `${KB}Faucet Sprayers & Hoses`],
  [/disposal/i, `${KB}Garbage Disposal Parts & Tools`],
  [/rack|organizer|basket/i, 'DECOR||Dish Racks & Trays'],
  [/\bmat\b|\bgrid\b/i, `${KB}Sink Grids & Mats`],
];

const attr = (p) => p.attributes ?? {};
const num = (v) => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) ? n : ''; };

function ronaCategory(p) {
  if (CATEGORY[p.category]) return CATEGORY[p.category];
  const name = p.model_name || attr(p).general_title_en || '';
  return ACCESSORY.find(([re]) => re.test(name))?.[1] ?? '';
}

// A set of N ("-2" SKU, "Set of 2" in the title) ships in N boxes; the sheet has room for five.
function boxCount(p) {
  const n = Number(String(attr(p).general_title_en ?? '').match(/\bset of (\d+)\b/i)?.[1] ?? String(p.sku ?? '').match(/-(\d)$/)?.[1] ?? 1);
  return Math.min(Math.max(n, 1), BOX_COLUMNS.length);
}

// Rona measures a box by its long side, its short side and its height.
function boxSize(p) {
  const d = attr(p).shipping_dimensions_in ?? {};
  const a = num(d.length);
  const b = num(d.width);
  if (a === '' || b === '') return null;
  const height = num(d.height);
  return height === '' ? null : { length: Math.max(a, b), width: Math.min(a, b), height };
}

// The last price read on each store's page, only where Price Alignment would
// trust it: this product, in stock, in CAD. retailer → sku → price.
async function competitorPrices(skus) {
  const out = {};
  for (let i = 0; i < skus.length; i += 100) {
    const { data, error } = await supabase
      .from('where_to_buy_readings')
      .select('sku, retailer, price, currency, in_stock, sku_check, page_model')
      .in('retailer', Object.values(COMPETITORS))
      .in('sku', skus.slice(i, i + 100));
    if (error) throw error;
    for (const r of data ?? []) {
      if (!readingCounts(r) || r.in_stock === false || (r.currency && r.currency !== 'CAD')) continue;
      (out[r.retailer] ??= {})[r.sku] = Number(r.price);
    }
  }
  return out;
}

export async function generateRonaFromTemplate(templateStoragePath, products, fileName = 'Rona_Export', { task = null } = {}) {
  if (!products?.length) throw new Error('No products to export.');
  const { zip, shared } = await openTemplate(templateStoragePath, { task: task?.part(0, 0.15) });
  const path = await sheetPathByName(zip, SHEET);
  if (!path) throw new Error(`This Rona file has no "${SHEET}" sheet. Only the new listing Vendor Quote Sheet can be filled from the catalog.`);
  let xml = await zip.file(path).async('string');
  const header = sheetToGrid(xml, shared)[HEADER_ROW - 1] ?? [];
  for (const [col, label] of Object.entries(ANCHORS)) {
    if (!norm(header[colToIndex(col) - 1] ?? '').startsWith(label)) throw new Error(`Rona changed the Vendor Quote Sheet: column ${col} is no longer "${label}".`);
  }
  const categoriesPath = await sheetPathByName(zip, CATEGORY_SHEET);
  const allowed = new Set(categoriesPath ? sheetToGrid(await zip.file(categoriesPath).async('string'), shared).map((r) => r[0]).filter(Boolean) : []);

  const skus = products.map((p) => p.sku);
  task?.progress(0.2, 'Reading images and store prices…');
  const [images, prices] = await Promise.all([fetchImagesBySku(skus), competitorPrices(skus)]);
  const exportDay = excelSerial(etToday()); // the Availability Date is the day of the export (user, 2026-11-09)
  task?.progress(0.5, 'Filling the sheet…');

  const missingData = [];
  const cellsByRow = new Map();
  products.forEach((p, i) => {
    const row = FIRST_ROW + i;
    const main = images[p.sku]?.[0]?.storage_path;
    const category = ronaCategory(p);
    const inList = allowed.has(category);
    const size = boxSize(p);
    const weight = num(p.shipping_weight_lb ?? attr(p).shipping_weight_lb);
    const values = {
      A: RONA_SUPPLIER.id,
      B: main ? getMediaUrl(main) : '',
      C: p.sku,
      D: String(attr(p).upc ?? ''),
      E: RONA_SUPPLIER.name,
      F: p.brand ?? '',
      G: attr(p).general_title_en || p.model_name || '',
      H: inList ? category : '',
      I: 'Bilingual',
      J: exportDay,
      K: 'CAD',
      L: num(p.cost_cad_rona_hd),
      N: num(p.map_cad), // MSRP = MAP on Rona (user, 2026-11-09)
      O: num(p.map_cad),
      AQ: 'N',
      AR: WAREHOUSE.address,
      AS: WAREHOUSE.postalCode,
      AT: WAREHOUSE.loadingDock,
    };
    for (const [col, retailer] of Object.entries(COMPETITORS)) values[col] = prices[retailer]?.[p.sku] ?? '';
    if (size) {
      for (const [l, w, h, kg] of BOX_COLUMNS.slice(0, boxCount(p))) Object.assign(values, { [l]: size.length, [w]: size.width, [h]: size.height, [kg]: weight });
    }
    const missing = [
      !main && 'image', !values.D && 'UPC', !values.G && 'name', !inList && 'category',
      values.L === '' && 'WC Blue', !size && 'box size', weight === '' && 'box weight',
    ].filter(Boolean);
    if (missing.length) missingData.push(`${p.sku}: ${missing.join(', ')}`);
    const cells = new Map();
    for (const [col, v] of Object.entries(values)) {
      const cell = buildCell(`${col}${row}`, v);
      if (cell) cells.set(colToIndex(col), cell);
    }
    cellsByRow.set(row, cells);
  });
  // keepStyle: the template's pre-formatted rows keep their money and date formats.
  xml = mergeRows(xml, cellsByRow, true);
  zip.file(path, xml);
  await downloadZip(zip, fileName, templateExt(templateStoragePath), { task: task?.part(0.6, 1) });
  if (missingData.length) console.warn('[Rona export] Missing data:', missingData);
  return { count: products.length, missingData };
}
