import { supabase } from '@/lib/supabase';
import {
  WAYFAIR_RULES,
  WAYFAIR_CATEGORY_RULES,
  IMAGE_COL_RE,
  BULLET_COL_RE,
  VARIANT_GROUPING_RE,
  VARIANT_ATTR_NAME_RE,
  WAYFAIR_VARIANT_AXES,
  WAYFAIR_STANDALONE,
  DOC_FILE_RE,
  DOC_TYPE_RE,
  DOC_TYPE_MAP,
  DOC_TYPE_PRIORITY,
} from './wayfairMapping';
import {
  openTemplate,
  sheetPathByName,
  listSheetNames,
  sheetToGrid,
  buildValidMaps,
  snap,
  buildCell,
  indexToCol,
  injectRows,
  downloadZip,
  templateExt,
  fetchImagesBySku,
  fetchDocsBySku,
} from './templateFiller';

// Fills a Wayfair Product Addition template. The generic XLSX machinery lives
// in templateFiller.js; this module holds what's Wayfair-specific: locating the
// product sheet ("NNN - Category") and its header row (row 4), the rule
// dispatch (base + per-category), and the variant-family grouping.

// --- Variant grouping ---------------------------------------------------------
// Wayfair links variants by a shared Group Reference ID, with exactly one row
// flagged Primary. In this catalog a "family" = one collection (model_name) and
// the axis that varies is Finish; a second axis is auto-detected when a finish
// repeats within a family (e.g. Milano varies by Flow Rate too).

const modelKey = (p) => (p.model_name || '').trim();
const finishKey = (p) => (p.finish || '').toLowerCase().trim();
// A real collection's SKUs share a dashed numeric root (K-135G/S/N → "K-135").
// Bundle SKUs (K130NK147N) have no dash, so they never form a variant family.
// The model name is part of the key too: sinks reuse roots across collections
// (S-300TG "Topaz" vs S-300XG — different listings, same numeric root).
const rootKey = (sku) => (String(sku).match(/^[A-Za-z]+-\d+/) || [null])[0];
const familyKey = (p) => {
  // Category-specific standalone SKUs (e.g. bathroom "-2" 2-packs) are always
  // their own listing, never grouped as a variant of the single unit.
  if (WAYFAIR_STANDALONE[p.category]?.test(p.sku)) return `__sku:${p.sku}`;
  return rootKey(p.sku) && modelKey(p) ? `${rootKey(p.sku)}|${modelKey(p)}` : `__sku:${p.sku}`;
};

// Given the selected products, pull every sibling that shares a model_name so a
// family is always exported whole, even when only one variant was selected.
async function expandFamilies(selected) {
  const bySku = {};
  for (const p of selected) bySku[p.sku] = p;

  // Only expand products that belong to a real collection (dashed root + model).
  const models = [...new Set(selected.filter((p) => rootKey(p.sku) && modelKey(p)).map(modelKey))];
  const cats = [...new Set(selected.map((p) => p.category).filter(Boolean))];
  for (let i = 0; i < models.length; i += 40) {
    let q = supabase.from('products').select('*').in('model_name', models.slice(i, i + 40));
    if (cats.length) q = q.in('category', cats);
    const { data } = await q;
    for (const p of data ?? []) bySku[p.sku] = bySku[p.sku] || p;
  }

  // Group by SKU root; standalone products (no root, or a bundle) stay solo.
  const groups = new Map();
  for (const p of Object.values(bySku)) {
    const key = familyKey(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return groups;
}

function pickPrimary(rows, imgBySku) {
  let best = rows[0].sku;
  let bestScore = -1;
  for (const p of rows) {
    const imgs = imgBySku[p.sku] || [];
    const score = (imgs.some((i) => i.is_primary) ? 1000 : 0) + imgs.length;
    if (score > bestScore) { bestScore = score; best = p.sku; }
  }
  return best;
}

// Attach `_variant` to each product and return a flat, family-ordered list plus
// any rows we couldn't make unique (duplicate finish with no distinguishing axis).
function assignVariants(groups, imgBySku) {
  const ordered = [];
  const warnings = [];

  for (const [key, rows] of groups) {
    if (rows.length === 1) {
      rows[0]._variant = { type: 'Not Variant', groupId: '', groupings: [] };
      ordered.push(rows[0]);
      continue;
    }

    const axes = WAYFAIR_VARIANT_AXES[rows[0].category] ?? WAYFAIR_VARIANT_AXES.default;
    const groupings = ['Finish'];
    const finishUnique = new Set(rows.map(finishKey)).size === rows.length;
    if (!finishUnique) {
      // add the first axis that increases how many rows we can tell apart
      const baseDistinct = new Set(rows.map(finishKey)).size;
      for (const axis of axes) {
        const distinct = new Set(rows.map((p) => finishKey(p) + '|' + axis.get(p))).size;
        if (distinct > baseDistinct) { groupings.push(axis.name); break; }
      }
    }

    // final uniqueness check → warn on rows still colliding
    const axisGetters = groupings.map((n) =>
      n === 'Finish' ? finishKey : axes.find((a) => a.name === n).get);
    const seen = new Map();
    for (const p of rows) {
      const k = axisGetters.map((g) => g(p)).join('|');
      if (seen.has(k)) warnings.push({ model: key, sku: p.sku, collidesWith: seen.get(k) });
      else seen.set(k, p.sku);
    }

    const primary = pickPrimary(rows, imgBySku);
    rows.sort((a, b) => (a.sku === primary ? -1 : b.sku === primary ? 1 : finishKey(a).localeCompare(finishKey(b))));
    const groupId = modelKey(rows[0]) || key; // human-readable, stable across the family
    for (const p of rows) {
      p._variant = {
        type: p.sku === primary ? 'Primary Variant' : 'Non-Primary Variant',
        groupId,
        groupings,
      };
      ordered.push(p);
    }
  }
  return { ordered, warnings };
}

/**
 * Fill a Wayfair Product Addition template (in place) and download the .xlsx.
 * @param {string} templateStoragePath  path in the `templates` bucket
 * @param {Object[]} products           full product rows
 * @param {string} [fileName]           base name for the download
 */
export async function generateWayfairFromTemplate(templateStoragePath, products, fileName = 'Wayfair_Export') {
  if (!products?.length) throw new Error('No products to export.');

  const { zip, shared } = await openTemplate(templateStoragePath);

  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const mainName = listSheetNames(wbXml).find((n) => /^\d+\s*-/.test(n));
  if (!mainName) throw new Error('Could not find the product sheet in the template.');
  const mainPath = await sheetPathByName(zip, mainName);
  const sheetXml = await zip.file(mainPath).async('string');

  const grid = sheetToGrid(sheetXml, shared);
  const names = grid[3] || []; // display-name header row (row 4)
  const ncols = names.length;
  // Rules may disambiguate by what other columns the template has (axis names).
  const headerSet = new Set(names.filter(Boolean));

  const vvPath = await sheetPathByName(zip, 'Valid Values');
  const validMaps = vvPath ? buildValidMaps(sheetToGrid(await zip.file(vvPath).async('string'), shared)) : {};

  // Expand each selected product into its full variant family, then group.
  const groups = await expandFamilies(products);
  const allSkus = [...groups.values()].flat().map((p) => p.sku);
  const imgBySku = await fetchImagesBySku(allSkus);
  const docBySku = await fetchDocsBySku(allSkus, DOC_TYPE_MAP, DOC_TYPE_PRIORITY);
  const { ordered, warnings } = assignVariants(groups, imgBySku);

  // Data rows start at Excel row 8 (after header rows 1–6 + the example Default Row 7).
  const START = 8;
  let rowsXml = '';
  ordered.forEach((p, pi) => {
    const rowNum = START + pi;
    const images = (imgBySku[p.sku] || []).map((m) => m.storage_path);
    const docs = docBySku[p.sku] || [];
    const bullets = p.attributes?.bullet_points || [];
    const groupings = p._variant?.groupings || [];
    let cells = '';
    for (let ci = 0; ci < ncols; ci++) {
      const nm = names[ci];
      if (!nm) continue;
      let v;
      const img = IMAGE_COL_RE.exec(nm);
      const bul = BULLET_COL_RE.exec(nm);
      const vg = VARIANT_GROUPING_RE.exec(nm);
      const van = VARIANT_ATTR_NAME_RE.exec(nm);
      const docF = DOC_FILE_RE.exec(nm);
      const docT = DOC_TYPE_RE.exec(nm);
      if (img) v = images[Number(img[1]) - 1] || '';
      else if (bul) v = bullets[Number(bul[1]) - 1] || '';
      else if (docF) v = docs[Number(docF[1]) - 1]?.url || '';
      else if (docT) v = docs[Number(docT[1]) - 1]?.type || '';
      else if (nm === 'Variant Type') v = p._variant?.type || '';
      else if (nm === 'Group Reference ID') v = p._variant?.groupId || '';
      else if (vg) v = groupings[Number(vg[1]) - 1] || '';
      else if (van) v = groupings[Number(van[1]) - 1] || '';
      else {
        // Category override first (same display name can mean different things
        // per template, e.g. Product Type on sinks vs faucets).
        const rule = WAYFAIR_CATEGORY_RULES[p.category]?.[nm] ?? WAYFAIR_RULES[nm];
        if (!rule) continue;
        try { v = rule(p, headerSet); } catch { v = ''; }
        if (validMaps[nm]) v = snap(v, validMaps[nm]);
      }
      cells += buildCell(`${indexToCol(ci + 1)}${rowNum}`, v);
    }
    rowsXml += `<row r="${rowNum}" spans="1:${ncols}">${cells}</row>`;
  });
  zip.file(mainPath, injectRows(sheetXml, rowsXml, START - 1 + ordered.length));

  await downloadZip(zip, fileName, templateExt(templateStoragePath));

  if (warnings.length) {
    console.warn(
      `Wayfair export: ${warnings.length} variant(s) share a finish with no distinguishing attribute — set a second "Variant Grouping" for these in Excel before uploading:\n` +
        warnings.map((w) => `  • ${w.model}: ${w.sku} collides with ${w.collidesWith}`).join('\n')
    );
  }

  return { count: ordered.length, families: groups.size, warnings };
}
