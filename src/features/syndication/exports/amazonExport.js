import { AMAZON_RULES } from './amazonMapping';
import {
  openTemplate,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  indexToCol,
  injectRows,
  downloadZip,
  templateExt,
  norm,
  fetchImagesBySku,
  fetchDocsBySku,
} from './templateFiller';

// Fills an Amazon flat-file template ("full-seller" .xlsm/.xlsx) in place.
//
// The template is self-describing: cell A1 holds a settings string declaring
// labelRow, attributeRow and dataRow. Rules are keyed by the label row;
// repeated labels (Bullet Point ×5…) are filled by occurrence from array rules.
// The Valid Values sheet lists "Label - [ TYPE ]" → options per row; values are
// snapped against it, and single-option fields (Product Type) auto-fill.

// Amazon docs keep their PIM type in `raw`; the mapping rules match on it.
const AMAZON_DOC_TYPES = {
  spec_sheet: 'spec_sheet',
  installation_manual: 'installation_manual',
  warranty_file: 'warranty_file',
  owner_manual: 'owner_manual',
};

function parseSettings(a1) {
  const out = {};
  for (const [, k, v] of String(a1 ?? '').matchAll(/([a-zA-Z]+)=([^&]*)/g)) out[k] = decodeURIComponent(v);
  return out;
}

// Valid Values sheet → { label: [options] } (label row format: "Label - [ X ]").
function buildAmazonValidValues(grid) {
  const byLabel = {};
  for (const row of grid) {
    if (!row || !row[0]) continue;
    const m = String(row[0]).match(/^(.*?)\s*-\s*\[[^\]]*\]\s*$/);
    if (!m) continue;
    const options = row.slice(1).filter((v) => v != null && v !== '');
    if (options.length) byLabel[m[1].trim()] = options;
  }
  return byLabel;
}

const snapTo = (value, options) => {
  if (!options || value === '' || value == null) return value;
  const hit = options.find((o) => norm(o) === norm(value));
  return hit ?? value;
};

/**
 * Fill an Amazon flat-file template (in place) and download it.
 * v1 exports each product as a standalone listing (no parent/child variation
 * rows) — the variation theme / parent-SKU convention is account-specific.
 *
 * @param {string} templateStoragePath  path in the `templates` bucket
 * @param {Object[]} products           full product rows
 * @param {string} [fileName]
 */
export async function generateAmazonFromTemplate(templateStoragePath, products, fileName = 'Amazon_Export') {
  if (!products?.length) throw new Error('No products to export.');

  const { zip, shared } = await openTemplate(templateStoragePath);
  const tplPath = await sheetPathByName(zip, 'Template');
  if (!tplPath) throw new Error('The file has no "Template" sheet — is this an Amazon flat file?');
  const sheetXml = await zip.file(tplPath).async('string');
  const grid = sheetToGrid(sheetXml, shared);

  const settings = parseSettings(grid[0]?.[0]);
  const labelRow = Number(settings.labelRow ?? 4);
  const dataRow = Number(settings.dataRow ?? 7);
  // Template context for locale-aware rules (en_CA vs en_US pricing etc.).
  const ctx = { lang: settings.contentLanguageTag ?? 'en_CA' };
  const labels = grid[labelRow - 1] || [];
  if (!labels.filter(Boolean).length) throw new Error('Could not read the template label row.');

  // occurrence index per column (1-based) for repeated labels
  const occurrence = [];
  {
    const seen = {};
    labels.forEach((l, ci) => {
      if (!l) return;
      seen[l] = (seen[l] ?? 0) + 1;
      occurrence[ci] = seen[l];
    });
  }

  const vvPath = await sheetPathByName(zip, 'Valid Values');
  const validValues = vvPath
    ? buildAmazonValidValues(sheetToGrid(await zip.file(vvPath).async('string'), shared))
    : {};
  // Single-option fields (Product Type → "SINK") fill themselves.
  const productType = validValues['Product Type']?.length === 1 ? validValues['Product Type'][0] : '';

  const skus = products.map((p) => p.sku);
  const imgBySku = await fetchImagesBySku(skus);
  const docBySku = await fetchDocsBySku(skus, AMAZON_DOC_TYPES, Object.keys(AMAZON_DOC_TYPES));

  let rowsXml = '';
  products.forEach((p, pi) => {
    const rowNum = dataRow + pi;
    p._images = (imgBySku[p.sku] || []).map((m) => m.storage_path);
    p._docs = docBySku[p.sku] || [];
    const cache = {}; // label → computed value (arrays reused across occurrences)
    let cells = '';
    for (let ci = 0; ci < labels.length; ci++) {
      const label = labels[ci];
      if (!label) continue;
      let v = '';
      if (label === 'Product Type') v = productType;
      else {
        // Rules are keyed with the en_CA compliance-media labels; other
        // locales (en_US…) share the same columns, so normalize the lookup.
        const rule = AMAZON_RULES[label] ?? AMAZON_RULES[label.replace(/\(en_[A-Z]{2}, /, '(en_CA, ')];
        if (!rule) continue;
        if (!(label in cache)) {
          try { cache[label] = rule(p, ctx); } catch { cache[label] = ''; }
        }
        const computed = cache[label];
        v = Array.isArray(computed) ? computed[occurrence[ci] - 1] ?? '' : occurrence[ci] === 1 ? computed : '';
      }
      if (v === '' || v == null) continue;
      v = snapTo(v, validValues[label]);
      cells += buildCell(`${indexToCol(ci + 1)}${rowNum}`, v);
    }
    rowsXml += `<row r="${rowNum}" spans="1:${labels.length}">${cells}</row>`;
  });

  zip.file(tplPath, injectRows(sheetXml, rowsXml, dataRow - 1 + products.length));
  await downloadZip(zip, fileName, templateExt(templateStoragePath));

  return { count: products.length };
}
