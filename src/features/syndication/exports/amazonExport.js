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
  createFillTracker,
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
// The label does NOT live in column A: the sheet opens with a narrow spacer
// column, so the label sits in B and the options start in C. Locate the first
// non-empty cell instead of assuming a column — reading A gave an empty map,
// which silently disabled snapping across every Amazon template.
function buildAmazonValidValues(grid) {
  const byLabel = {};
  for (const row of grid) {
    if (!row) continue;
    const li = row.findIndex((v) => v != null && v !== '');
    if (li < 0) continue;
    const m = String(row[li]).match(/^(.*?)\s*-\s*\[[^\]]*\]\s*$/);
    if (!m) continue;
    const options = row.slice(li + 1).filter((v) => v != null && v !== '');
    if (options.length) byLabel[m[1].trim()] = options;
  }
  return byLabel;
}

// The product type ("SINK", "FAUCET"…) is the keystone of the whole sheet:
// every list validation is an INDIRECT() that prefixes the attribute's named
// range with the value of column B — e.g. B7="SINK" resolves
// "SINKstyle…1.value". Leave B empty and every INDIRECT points at a name that
// doesn't exist, so Excel shows NO dropdown options anywhere in the row.
// Resolve it from the Valid Values sheet (it lists exactly one option) and fall
// back to the base64 `ptds` field of the A1 settings string.
function resolveProductType(validValues, settings) {
  const listed = validValues['Product Type'];
  if (listed?.length === 1) return listed[0];
  try {
    const ptds = atob(settings.ptds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ptds.length === 1) return ptds[0];
  } catch { /* not base64 — fall through */ }
  return '';
}

const snapTo = (value, options) => {
  if (!options || value === '' || value == null) return value;
  const hit = options.find((o) => norm(o) === norm(value));
  return hit ?? value;
};

// The PIM stores lengths in inches and weights in pounds, but a template can
// demand something else COLUMN BY COLUMN: Amazon CA accepts only centimeters on
// item_depth_width_height while keeping the package block in inches, and the
// accessory templates mix both in a single file. So the rules keep emitting the
// PIM's native units and the generator converts each value/unit PAIR to
// whatever that unit column's Valid Values list actually allows.
const UNIT_FACTORS = {
  inches: {
    inches: 1, centimeters: 2.54, millimeters: 25.4, meters: 0.0254,
    feet: 1 / 12, yards: 1 / 36, hundredthsinches: 100,
  },
  pounds: {
    pounds: 1, ounces: 16, kilograms: 0.45359237, grams: 453.59237,
    milligrams: 453592.37, hundredthspounds: 100,
  },
};

// Pair up "<attribute>.value" / "<attribute>.unit" columns using the template's
// attribute row — the only place that states which unit belongs to which value.
function buildUnitPairs(attrs) {
  const byPrefix = {};
  attrs.forEach((a, ci) => {
    const m = String(a ?? '').match(/^(.*)\.(value|unit)$/);
    if (!m) return;
    (byPrefix[m[1]] ??= {})[m[2]] = ci;
  });
  return Object.values(byPrefix).filter((p) => p.value != null && p.unit != null);
}

// Rewrite value+unit pairs whose unit isn't accepted by the template.
function reconcileUnits(values, pairs, labels, validValues) {
  for (const { value: vi, unit: ui } of pairs) {
    const from = values[ui];
    const amount = Number(values[vi]);
    if (!from || !Number.isFinite(amount)) continue;
    const options = validValues[labels[ui]];
    if (!options || options.some((o) => norm(o) === norm(from))) continue;

    const table = UNIT_FACTORS[norm(from)];
    const target = table && options.find((o) => table[norm(o)] != null);
    if (!target) continue; // nothing we know how to convert into — leave as is
    values[vi] = String(Math.round(amount * table[norm(target)] * 100) / 100);
    values[ui] = target;
  }
}

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
  const attributeRow = Number(settings.attributeRow ?? 5);
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
  const productType = resolveProductType(validValues, settings);
  const unitPairs = buildUnitPairs(grid[attributeRow - 1] || []);

  const skus = products.map((p) => p.sku);
  const imgBySku = await fetchImagesBySku(skus);
  const docBySku = await fetchDocsBySku(skus, AMAZON_DOC_TYPES, Object.keys(AMAZON_DOC_TYPES));

  const fill = createFillTracker();
  let rowsXml = '';
  products.forEach((p, pi) => {
    const rowNum = dataRow + pi;
    p._images = (imgBySku[p.sku] || []).map((m) => m.storage_path);
    p._docs = docBySku[p.sku] || [];
    const cache = {}; // label → computed value (arrays reused across occurrences)
    // Values are collected first so units can be reconciled against their
    // paired value before anything is written out.
    const values = [];
    for (let ci = 0; ci < labels.length; ci++) {
      const label = labels[ci];
      if (!label) continue;
      let v;
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
      values[ci] = snapTo(v, validValues[label]);
    }
    reconcileUnits(values, unitPairs, labels, validValues);

    let cells = '';
    values.forEach((v, ci) => {
      if (v === '' || v == null) return;
      fill.hit(ci, v);
      cells += buildCell(`${indexToCol(ci + 1)}${rowNum}`, v);
    });
    rowsXml += `<row r="${rowNum}" spans="1:${labels.length}">${cells}</row>`;
  });

  zip.file(tplPath, injectRows(sheetXml, rowsXml, dataRow - 1 + products.length));
  await downloadZip(zip, fileName, templateExt(templateStoragePath));

  return { count: products.length, fillReport: fill.report(labels, products.length) };
}
