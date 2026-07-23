import {
  openTemplate,
  listSheetNames,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  indexToCol,
  injectRows,
  downloadZip,
  templateExt,
  fetchImagesBySku,
  fetchDocsBySku,
} from './templateFiller';

// Fills a Walmart Canada "multilocale" spec (Version=3.x) in place.
//
// Layout (data sheet, e.g. "Home Decor, Kitchen, & Other"):
//   R1 = settings string ("Version=3.16,marketplace,…"), R4 = display labels,
//   R5 = attribute XML names (the stable key — labels are cosmetic), R6 = type
//   hints ("[Optional]…"), data starts R7. Bilingual pairs share a label with
//   "(French)" — the _fr XML suffix. Repeated XML names (keyFeatures_en ×3,
//   productSecondaryImageURL ×4) fill by occurrence from array rules.
//   Closed-list values live on the companion "Hidden_*" sheet; rules emit the
//   exact list wording ("UPC", "lb", "Does Not Contain a Battery"…).
//
// French columns are left blank on purpose: the PIM has no French content yet,
// and every _fr column in the spec is [Optional].

const WALMART_DOC_TYPES = {
  spec_sheet: 'spec_sheet',
  installation_manual: 'installation_manual',
  warranty_file: 'warranty_file',
  owner_manual: 'owner_manual',
};

const attr = (p) => p.attributes || {};
const num = (v) => {
  if (v == null || v === '') return '';
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? m[0] : '';
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
const brandMap = (b) => (/azuni/i.test(b || '') ? 'AZUNI' : 'Stylish');
const docUrl = (p, kind) => (p._docs ?? []).find((d) => d.raw === kind)?.url ?? '';

// Walmart's Color Category closed list (Hidden sheet, 18 fixed values).
const colorCategory = (finish) => {
  const f = String(finish || '');
  if (/stainless|chrome|nickel|silver|steel/i.test(f)) return 'Silver';
  if (/white/i.test(f)) return 'White';
  if (/black|gunmetal/i.test(f)) return 'Black';
  if (/gold|brass/i.test(f)) return 'Gold';
  if (/bronze|copper/i.test(f)) return 'Bronze';
  if (/gr[ae]y|graphite/i.test(f)) return 'Gray';
  if (/brown|walnut|teak|acacia|wood|honey/i.test(f)) return 'Brown';
  if (/beige|cream|bisque|natural/i.test(f)) return 'Beige';
  if (/clear|glass/i.test(f)) return 'Clear';
  if (/blue/i.test(f)) return 'Blue';
  if (/green/i.test(f)) return 'Green';
  if (/red/i.test(f)) return 'Red';
  return '';
};

const sizeString = (p) => {
  const d = attr(p).external_dimensions_in ?? {};
  return d.length && d.width ? `${d.length}"L x ${d.width}"W` : '';
};

// Keyed by the template's attribute XML name (R5). Arrays fill repeated
// columns by occurrence; scalars fill only the first occurrence.
export const WALMART_RULES = {
  sku: (p) => p.sku,
  productIdType: (p) => (attr(p).upc ? 'UPC' : ''),
  productId: (p) => attr(p).upc || '',
  productName_en: (p) => attr(p).general_title_en || p.model_name || p.sku,
  brand_en: (p) => brandMap(p.brand),
  manufacturer_en: () => 'Stylish International Inc.',
  manufacturerPartNumber: (p) => p.sku,
  modelNumber: (p) => p.sku,

  // Walmart CA sells in CAD, so PIM CAD pricing maps directly.
  price: (p) => num(p.msrp_cad),
  msrp: (p) => num(p.msrp_cad),

  countryOfOriginAssembly: (p) =>
    /china|cn/i.test(attr(p).country_of_origin || 'China') ? 'CN - China' : '',
  countryOfOriginTextiles: () => 'Imported',
  // productTaxCode: Walmart-account-specific — left for the business to fill.

  // "Measure/Unit" pair right after tax code = shipping weight.
  measure: (p) => num(p.shipping_weight_lb),
  unit: (p) => (num(p.shipping_weight_lb) ? 'lb' : ''),

  shortDescription_en: (p) => stripHtml(p.description),
  keyFeatures_en: (p) => list(attr(p).bullet_points).slice(0, 3),
  features_en: (p) => list(attr(p).bullet_points).slice(3).join(' | '),
  keywords_en: (p) => [p.category, p.product_type, p.finish, p.brand].filter(Boolean).join(', '),

  mainImageUrl: (p) => (p._images ?? [])[0] ?? '',
  productSecondaryImageURL: (p) => (p._images ?? []).slice(1, 5),

  warrantyText_en: (p) => {
    const parts = [attr(p).warranty_length, attr(p).warranty].filter(Boolean);
    return parts.length ? `${parts.join(' ')} warranty`.replace(/\s+/g, ' ') : '';
  },
  warrantyURL: (p) => docUrl(p, 'warranty_file'),

  // Compliance — constants confirmed for our catalog (no electronics/chemicals).
  electronicsIndicator: () => 'No',
  isChemical: () => 'No',
  isPesticide: () => 'No',
  isAerosol: () => 'No',
  isTemperatureSensitive: () => 'No',
  batteryTechnologyType: () => 'Does Not Contain a Battery',
  smallPartsWarnings: () => '0 - No warning applicable',

  color_en: (p) => p.finish || '',
  colorCategory: (p) => colorCategory(p.finish),
  material_en: (p) => list(attr(p).material ?? p.material).join(', '),
  finish_en: (p) => p.finish || '',
  size_en: sizeString,
  shape_en: (p) => attr(p).overall_shape || attr(p).sink_shape || '',
  collection_en: (p) => p.series || '',

  recommendedRooms_en: (p) => (/bath/i.test(p.category ?? '') ? 'Bathroom' : 'Kitchen'),
  cleaningCareAndMaintenance_en: (p) => list(attr(p).product_care).join(' '),
  isAssemblyRequired: () => 'No',
  assemblyInstructions: (p) => docUrl(p, 'installation_manual'),
  isSet: () => 'No',
  ageGroup: () => 'Adult',
  gender: () => 'Unisex',

  // Assembled-product dimension trio (present in the trailing spec columns).
  assembledProductLength: (p) => num(attr(p).external_dimensions_in?.length),
  assembledProductWidth: (p) => num(attr(p).external_dimensions_in?.width),
  assembledProductHeight: (p) =>
    num(attr(p).external_dimensions_in?.height ?? attr(p).external_dimensions_in?.depth),
};

/**
 * Fill a Walmart CA multilocale template (in place) and download it.
 *
 * @param {string} templateStoragePath  path in the `templates` bucket
 * @param {Object[]} products           full product rows
 * @param {string} [fileName]
 */
export async function generateWalmartFromTemplate(templateStoragePath, products, fileName = 'Walmart_Export') {
  if (!products?.length) throw new Error('No products to export.');

  const { zip, shared } = await openTemplate(templateStoragePath);

  // Data sheet = the one whose A1 carries the "Version=…" settings string
  // (companion "Hidden_*" sheet holds the closed lists).
  let tplPath = null;
  let grid = null;
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  for (const name of listSheetNames(workbookXml)) {
    if (/^hidden/i.test(name)) continue;
    const path = await sheetPathByName(zip, name);
    if (!path) continue;
    const g = sheetToGrid(await zip.file(path).async('string'), shared);
    if (/^Version=/i.test(String(g[0]?.[0] ?? ''))) {
      tplPath = path;
      grid = g;
      break;
    }
  }
  if (!tplPath) throw new Error('No sheet with a Walmart "Version=…" settings row — is this a Walmart spec?');

  const XML_ROW = 5;
  const LABEL_ROW = 4;
  const DATA_ROW = 7;
  const xmlNames = grid[XML_ROW - 1] || [];
  const labels = grid[LABEL_ROW - 1] || [];

  // Column key = XML name; the SKU column has a label but no XML name.
  const colKeys = [];
  const occurrence = [];
  {
    const seen = {};
    for (let ci = 0; ci < Math.max(xmlNames.length, labels.length); ci++) {
      let key = xmlNames[ci] ? String(xmlNames[ci]).trim() : '';
      if (!key && /^sku$/i.test(String(labels[ci] ?? '').trim())) key = 'sku';
      if (!key) continue;
      colKeys[ci] = key;
      seen[key] = (seen[key] ?? 0) + 1;
      occurrence[ci] = seen[key];
    }
  }
  if (!colKeys.filter(Boolean).length) throw new Error('Could not read the Walmart attribute XML-name row.');

  const skus = products.map((p) => p.sku);
  const imgBySku = await fetchImagesBySku(skus);
  const docBySku = await fetchDocsBySku(skus, WALMART_DOC_TYPES, Object.keys(WALMART_DOC_TYPES));

  const sheetXml = await zip.file(tplPath).async('string');
  let rowsXml = '';
  products.forEach((p, pi) => {
    const rowNum = DATA_ROW + pi;
    p._images = (imgBySku[p.sku] || []).map((m) => m.storage_path);
    p._docs = docBySku[p.sku] || [];
    const cache = {};
    let cells = '';
    for (let ci = 0; ci < colKeys.length; ci++) {
      const key = colKeys[ci];
      if (!key) continue;
      const rule = WALMART_RULES[key];
      if (!rule) continue;
      if (!(key in cache)) {
        try { cache[key] = rule(p); } catch { cache[key] = ''; }
      }
      const computed = cache[key];
      const v = Array.isArray(computed)
        ? computed[occurrence[ci] - 1] ?? ''
        : occurrence[ci] === 1 ? computed : '';
      if (v === '' || v == null) continue;
      cells += buildCell(`${indexToCol(ci + 1)}${rowNum}`, v);
    }
    rowsXml += `<row r="${rowNum}" spans="1:${colKeys.length}">${cells}</row>`;
  });

  zip.file(tplPath, injectRows(sheetXml, rowsXml, DATA_ROW - 1 + products.length));
  await downloadZip(zip, fileName, templateExt(templateStoragePath));

  return { count: products.length };
}
