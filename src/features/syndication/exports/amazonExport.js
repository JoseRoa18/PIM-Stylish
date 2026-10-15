import { AMAZON_RULES, AMAZON_LISTING_RULES, AMAZON_KITCHEN_SINK_RULES, AMAZON_UPDATE_RULES } from './amazonMapping';
import { supabase } from '@/lib/supabase';
import { getStockFor } from '@/features/pricing/api/inventory';
import { expectedPricesFor } from '@/features/pricing/api/expectedPrices';
import { amazonTitle } from '@/features/syndication/lib/amazonTitles';
import { channelCategory } from '@/features/products/lib/categories';
import {
  openTemplate,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  indexToCol,
  colToIndex,
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
// Kitchen sinks keep their installation manual per mounting (the
// installation_* slots), not in installation_manual.
const AMAZON_DOC_TYPES = {
  spec_sheet: 'spec_sheet',
  installation_manual: 'installation_manual',
  installation_undermount: 'installation_undermount',
  installation_dual_mount: 'installation_dual_mount',
  installation_drop_in: 'installation_drop_in',
  installation_top_mount: 'installation_top_mount',
  warranty_file: 'warranty_file',
  owner_manual: 'owner_manual',
};

// The Amazon kitchen sink templates (Canada and USA): SINK, and EVERY node it
// offers is a kitchen sink one — Canada's "Recommended Browse Nodes", the
// USA's "Item Type Keyword". The bathroom sink templates are SINKs too and
// list one kitchen node among their bathroom ones.
const isKitchenSinkTemplate = (ctx, validValues) => {
  const nodes = validValues['Recommended Browse Nodes'] ?? validValues['Item Type Keyword'] ?? [];
  return ['en_CA', 'en_US'].includes(ctx.lang) && ctx.productType === 'SINK'
    && nodes.length > 0 && nodes.every((o) => /kitchen sinks/i.test(o));
};

// Seller SKU (and fulfilment) of each product on Amazon Canada or USA — the
// alias the Aliases tab shows, stored in amazon_links per marketplace.
async function amazonLinks(skus, market) {
  const out = {};
  for (let i = 0; i < skus.length; i += 200) {
    const { data, error } = await supabase
      .from('amazon_links')
      .select('sku, seller_sku, fulfillment')
      .eq('marketplace', market)
      .in('sku', skus.slice(i, i + 200));
    if (error) throw error;
    for (const r of data ?? []) out[r.sku] ??= { sellerSku: r.seller_sku, fulfillment: r.fulfillment };
  }
  return out;
}

// SKUs that are color variants: another product of their family (archived
// ones aside) has a different finish. Their Item Name always keeps the color.
async function colorVariantSkus(products) {
  const families = [...new Set(products.map((p) => p.family_number).filter(Boolean))];
  const finishes = {};
  for (let i = 0; i < families.length; i += 200) {
    const { data, error } = await supabase
      .from('products')
      .select('sku, family_number, finish, workflow_status')
      .in('family_number', families.slice(i, i + 200));
    if (error) throw error;
    for (const r of data ?? []) {
      if (r.workflow_status === 'archived') continue;
      (finishes[r.family_number] ??= new Set()).add(String(r.finish ?? '').trim().toLowerCase());
    }
  }
  return new Set(products.filter((p) => (finishes[p.family_number]?.size ?? 0) > 1).map((p) => p.sku));
}

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
  if (isListingsReport(settings)) {
    return fillAmazonUpdate({ zip, shared, tplPath, sheetXml, grid, settings, products, fileName, templateStoragePath });
  }
  const labelRow = Number(settings.labelRow ?? 4);
  const attributeRow = Number(settings.attributeRow ?? 5);
  const dataRow = Number(settings.dataRow ?? 7);
  // Template context for rules that vary by locale (en_CA vs en_US pricing) or
  // by product type (a FAUCET template ships as a case, a SINK as a unit).
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
  ctx.productType = productType;
  ctx.validValues = validValues;
  ctx.market = ctx.lang === 'en_US' ? 'us' : 'ca';
  ctx.kitchenSink = isKitchenSinkTemplate(ctx, validValues);
  // The user's review applies to every Amazon listing; the kitchen sink
  // template adds its sink-only columns.
  const rules = { ...AMAZON_RULES, ...AMAZON_LISTING_RULES, ...(ctx.kitchenSink ? AMAZON_KITCHEN_SINK_RULES : {}) };
  const unitPairs = buildUnitPairs(grid[attributeRow - 1] || []);

  const skus = products.map((p) => p.sku);
  const imgBySku = await fetchImagesBySku(skus);
  const docBySku = await fetchDocsBySku(skus, AMAZON_DOC_TYPES, Object.keys(AMAZON_DOC_TYPES));
  const [linkBySku, stock, variants] = await Promise.all([amazonLinks(skus, ctx.market), getStockFor(skus), colorVariantSkus(products)]);

  const fill = createFillTracker();
  let rowsXml = '';
  products.forEach((p, pi) => {
    const rowNum = dataRow + pi;
    p._images = (imgBySku[p.sku] || []).map((m) => m.storage_path);
    p._docs = docBySku[p.sku] || [];
    p._amazon = linkBySku[p.sku] ?? null;
    p._stock = stock[ctx.market]?.[p.sku] ?? null;
    p._title = amazonTitle(p, { colorVariant: variants.has(p.sku) });
    const values = rowValues({ p, ctx, rules, labels, occurrence, validValues, unitPairs, productType });
    rowsXml += rowXml(values, rowNum, labels, fill);
  });

  zip.file(tplPath, injectRows(sheetXml, rowsXml, dataRow - 1 + products.length));
  await downloadZip(zip, fileName, templateExt(templateStoragePath));

  return { count: products.length, fillReport: fill.report(labels, products.length) };
}

// One row's values by column index. Values are collected first so units can
// be reconciled against their paired value before anything is written out.
function rowValues({ p, ctx, rules, labels, occurrence, validValues, unitPairs, productType }) {
  const cache = {}; // label → computed value (arrays reused across occurrences)
  const values = [];
  for (let ci = 0; ci < labels.length; ci++) {
    const label = labels[ci];
    if (!label) continue;
    let v;
    if (label === 'Product Type') v = productType;
    else {
      // Rules are keyed with the en_CA compliance-media labels; other
      // locales (en_US…) share the same columns, so normalize the lookup.
      const rule = rules[label] ?? rules[label.replace(/\(en_[A-Z]{2}, /, '(en_CA, ')];
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
  return values;
}

function rowXml(values, rowNum, labels, fill, kept = null) {
  let cells = '';
  values.forEach((v, ci) => {
    if (v === '' || v == null) return;
    if (!kept?.has(ci)) fill.hit(ci, v);
    cells += buildCell(`${indexToCol(ci + 1)}${rowNum}`, v);
  });
  return `<row r="${rowNum}" spans="1:${labels.length}">${cells}</row>`;
}

// ---- Update listing: Amazon's Category Listings Report (2026-10-14) --------
// The report Seller Central exports (Inventory Reports → Category Listings
// Report, settings flavor "inventory-report…") is kept in Templates as the
// MASTER: every live listing, every product type in one sheet, one row per
// Seller SKU. An export writes ONLY the selected products' rows — found by
// their Seller SKU (Aliases) — rebuilt from the PIM with the listing rules plus
// AMAZON_UPDATE_RULES, each row with its own product type (SINK, FAUCET…), so
// the report's own 10-06 values never ride along. Parents are not written. A
// product with no Seller SKU, or whose Seller SKU is not in the report, is
// left out and reported.
const isListingsReport = (settings) => /^inventory-report/i.test(settings.flavor ?? '');

// Which product types each column applies to. The template greys a column
// out with the conditional format "ApplicablePTList<n>", a defined name that
// lists the types it does NOT grey: NOT(OR(Template!$D1="SINK", …)). A column
// without one applies to every type.
async function columnApplicability(zip, sheetXml) {
  const wb = await zip.file('xl/workbook.xml').async('string');
  const lists = {};
  for (const m of wb.matchAll(/<definedName name="(ApplicablePTList\d+)"[^>]*>([\s\S]*?)<\/definedName>/g)) {
    lists[m[1]] = new Set([...m[2].matchAll(/\$D\d+=(?:"|&quot;)([A-Z_]+)(?:"|&quot;)/g)].map((x) => x[1]));
  }
  const byCol = new Map();
  for (const m of sheetXml.matchAll(/<conditionalFormatting sqref="([A-Z]+)\d+:[A-Z]+\d+">([\s\S]*?)<\/conditionalFormatting>/g)) {
    const name = m[2].match(/<formula>(ApplicablePTList\d+)<\/formula>/)?.[1];
    const ci = colToIndex(m[1]) - 1;
    if (name && lists[name] && !byCol.has(ci)) byCol.set(ci, lists[name]);
  }
  return (ci, productType) => !byCol.has(ci) || byCol.get(ci).has(productType);
}

// One update row's values: only the columns that apply to the row's product
// type. The report repeats a label for different attributes of different
// types (Item Width Side to Side = item_width_height and
// item_depth_width_height): a scalar fills every ATTRIBUTE it applies to, but
// the numbered slots of one attribute (Generic Keyword #1, #2) only once. A
// measure without its unit takes inches / pounds (converted where the column
// wants other units).
function rowValuesUpdate({ p, ctx, rules, labels, attrs, validValues, unitPairs, productType, applies }) {
  const cache = {};
  const values = [];
  const slot = {};
  const given = new Set();
  for (let ci = 0; ci < labels.length; ci++) {
    const label = labels[ci];
    if (!label || !applies(ci, productType)) continue;
    if (label === 'Product Type') { values[ci] = productType; continue; }
    const rule = rules[label] ?? rules[label.replace(/\(en_[A-Z]{2}, /, '(en_CA, ')];
    if (!rule) continue;
    if (!(label in cache)) {
      try { cache[label] = rule(p, ctx); } catch { cache[label] = ''; }
    }
    const computed = cache[label];
    slot[label] = (slot[label] ?? 0) + 1;
    let v;
    if (Array.isArray(computed)) v = computed[slot[label] - 1] ?? '';
    else {
      const key = `${label}|${String(attrs[ci] ?? '').replace(/#\d+/g, '#')}`;
      if (given.has(key)) continue;
      given.add(key);
      v = computed;
    }
    if (v === '' || v == null) continue;
    values[ci] = snapTo(v, validValues[label]);
  }
  for (const { value: vi, unit: ui } of unitPairs) {
    if (values[vi] === '' || values[vi] == null || (values[ui] !== '' && values[ui] != null)) continue;
    if (!applies(ui, productType)) continue;
    values[ui] = /weight/i.test(String(attrs[vi] ?? '')) ? 'Pounds' : 'Inches';
  }
  reconcileUnits(values, unitPairs, labels, validValues);
  // A unit without the PIM's measure stays out: the report's own measure and
  // unit are then kept together (6.6 Centimeters never turns 6.6 Inches).
  for (const { value: vi, unit: ui } of unitPairs) {
    if ((values[vi] === '' || values[vi] == null) && values[ui] !== '' && values[ui] != null) delete values[ui];
  }
  return values;
}

// A partial update replaces each attribute it names as a whole. Where a row
// fills one member of an attribute that has several (Your Price inside
// purchasable_offer, the height inside item_depth_width_height), the other
// members are copied from the report, so Amazon keeps them: the pricing rule,
// the minimum price, the B2B price, the other sides. A list (bullets,
// keywords, materials: the same member numbered #1, #2…) stays the PIM's.
// Returns the columns it copied.
const attrName = (a) => String(a ?? '').match(/^([a-z0-9_]+)[[#.]/i)?.[1] ?? '';
const memberOf = (a) => String(a ?? '').replace(/#\d+/g, '#');
function keepRestOfAttributes(values, reportCells, attrs) {
  const touched = new Set();
  const members = new Set();
  values.forEach((v, ci) => {
    if (v === '' || v == null || !attrName(attrs[ci])) return;
    touched.add(attrName(attrs[ci]));
    members.add(memberOf(attrs[ci]));
  });
  const kept = new Set();
  attrs.forEach((a, ci) => {
    const v = reportCells?.[ci];
    if (v === '' || v == null || (values[ci] !== '' && values[ci] != null)) return;
    if (!touched.has(attrName(a)) || members.has(memberOf(a))) return;
    values[ci] = v;
    kept.add(ci);
  });
  return kept;
}

// Valid Values per product type: "Label - [ SINK ]" rows, "- [ ]" for all.
function buildAmazonValidValuesByType(grid) {
  const generic = {};
  const byType = {};
  for (const row of grid) {
    if (!row) continue;
    const li = row.findIndex((v) => v != null && v !== '');
    if (li < 0) continue;
    const m = String(row[li]).match(/^(.*?)\s*-\s*\[\s*([^\]]*?)\s*\]\s*$/);
    if (!m) continue;
    const options = row.slice(li + 1).filter((v) => v != null && v !== '');
    if (!options.length) continue;
    if (m[2]) (byType[m[2]] ??= {})[m[1].trim()] = options;
    else generic[m[1].trim()] = options;
  }
  return (pt) => ({ ...generic, ...(byType[pt] ?? {}) });
}

async function fillAmazonUpdate({ zip, shared, tplPath, sheetXml, grid, settings, products, fileName, templateStoragePath }) {
  const labelRow = Number(settings.labelRow ?? 4);
  const attributeRow = Number(settings.attributeRow ?? 5);
  const dataRow = Number(settings.dataRow ?? 7);
  const labels = grid[labelRow - 1] || [];
  const col = (name) => labels.indexOf(name);
  const [skuCol, typeCol, statusCol, levelCol, idTypeCol, idCol] = [col('SKU'), col('Product Type'), col('Status'), col('Parentage Level'), col('Product Id Type'), col('Product Id')];
  if (skuCol < 0 || typeCol < 0) throw new Error('The listings report has no SKU / Product Type columns.');
  const cell = (i, c) => (c < 0 ? '' : String(grid[i]?.[c] ?? '').trim());

  // The report's rows by Seller SKU (parents left aside), with what the
  // listing already is on Amazon: its product type, status and product id.
  const report = new Map();
  for (let i = dataRow - 1; i < grid.length; i++) {
    const seller = cell(i, skuCol);
    if (!seller || /^abc123$/i.test(seller) || cell(i, levelCol) === 'Parent') continue;
    report.set(seller, { productType: cell(i, typeCol), status: cell(i, statusCol), productIdType: cell(i, idTypeCol), productId: cell(i, idCol), cells: grid[i] });
  }
  const applies = await columnApplicability(zip, sheetXml);
  const attrs = grid[attributeRow - 1] || [];

  const vvPath = await sheetPathByName(zip, 'Valid Values');
  const validValuesFor = vvPath ? buildAmazonValidValuesByType(sheetToGrid(await zip.file(vvPath).async('string'), shared)) : () => ({});
  const lang = settings.contentLanguageTag ?? 'en_CA';
  const market = lang === 'en_US' ? 'us' : 'ca';
  const unitPairs = buildUnitPairs(grid[attributeRow - 1] || []);

  const skus = products.map((p) => p.sku);
  const [imgBySku, docBySku, linkBySku, stock, variants, prices] = await Promise.all([
    fetchImagesBySku(skus),
    fetchDocsBySku(skus, AMAZON_DOC_TYPES, Object.keys(AMAZON_DOC_TYPES)),
    amazonLinks(skus, market),
    getStockFor(skus),
    colorVariantSkus(products),
    expectedPricesFor({ priceField: market === 'us' ? 'map_usd' : 'map_cad', market, promoChannel: `amazon_${market}` }),
  ]);

  const skipped = [];
  const fill = createFillTracker();
  let rowsXml = '';
  let rowNum = dataRow;
  for (const p of products) {
    // Amazon USA lists our products under the PIM SKU itself.
    const seller = linkBySku[p.sku]?.sellerSku || (market === 'us' ? p.sku : null);
    if (!seller) { skipped.push(`${p.sku} (no Amazon ${market.toUpperCase()} Seller SKU in Aliases)`); continue; }
    const row = report.get(seller);
    if (!row) { skipped.push(`${p.sku} (${seller} is not in the listings report — list it with New listing)`); continue; }
    p._images = (imgBySku[p.sku] || []).map((m) => m.storage_path);
    p._docs = docBySku[p.sku] || [];
    p._amazon = { ...(linkBySku[p.sku] ?? {}), sellerSku: seller };
    p._stock = stock[market]?.[p.sku] ?? null;
    p._title = amazonTitle(p, { colorVariant: variants.has(p.sku) });
    p._report = row;
    p._sale = prices.promoBySku.get(p.sku) ?? null;
    const validValues = validValuesFor(row.productType);
    const kitchenSink = row.productType === 'SINK' && channelCategory(p) !== 'bathroom_sink';
    const ctx = { lang, market, productType: row.productType, validValues, kitchenSink };
    const rules = { ...AMAZON_RULES, ...AMAZON_LISTING_RULES, ...(kitchenSink ? AMAZON_KITCHEN_SINK_RULES : {}), ...AMAZON_UPDATE_RULES };
    const values = rowValuesUpdate({ p, ctx, rules, labels, attrs, validValues, unitPairs, productType: row.productType, applies });
    const kept = keepRestOfAttributes(values, row.cells, attrs);
    rowsXml += rowXml(values, rowNum, labels, fill, kept);
    rowNum += 1;
  }
  const count = rowNum - dataRow;
  if (!count) throw new Error(`None of these products can be updated on Amazon ${market.toUpperCase()}: ${skipped.join('; ')}.`);

  // The report's own rows go; Amazon's example row and the headers stay.
  const cleared = sheetXml.replace(/<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g, (m, r) => (Number(r) >= dataRow ? '' : m));
  zip.file(tplPath, injectRows(cleared, rowsXml, dataRow - 1 + count));
  await downloadZip(zip, fileName, templateExt(templateStoragePath));
  return { count, skipped, skippedReason: 'left out', fillReport: fill.report(labels, count) };
}
