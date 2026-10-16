import { supabase } from '@/lib/supabase';
import { SUGGEST_COLUMNS, SUGGEST_ATTRS, SUGGEST_FROM } from '@/features/products/lib/suggestFields';
import { STRAINER_TYPE, DECK_PLATE_TYPE, DRAIN_TYPE } from '@/features/products/lib/fieldOptions';
import { FIELD_DEFS } from '@/features/import/lib/importSchema';

// What stays free text in the PIM's Excel: what is one product's own (its
// SKU, names, titles, texts, codes, links, a retailer's id for it) and the
// multi-value lists ("a; b").
const FREE_TEXT = new Set([
  'sku', 'model_name', 'quickbooks_description', 'description', 'upc', 'hs_code', 'hs_code_ca',
  'general_title_en', 'general_title_fr', 'description_fr', 'marketing_copy', 'product_care',
  'warranty_text_us', 'warranty_text_ca', 'product_url', 'alias',
  'bbb_ca_upc', 'asin', 'amazon_fnsku', 'homedepot_ca_sku', 'bbb_ca_sku', 'rona_ca_sku', 'bestbuy_ca_sku',
  'bbb_com_sku', 'lowes_sku', 'wayfair_sku',
]);
// The part-number pickers list the catalog's SKUs of that type (the product
// page narrows them to the product's brand; the sheet lists both brands').
const SKU_PICKERS = { strainer_model: STRAINER_TYPE, compatible_deck_plate: DECK_PLATE_TYPE, compatible_drain_assembly: DRAIN_TYPE };

/**
 * The values the catalog already uses for each field typed by hand — the
 * dropdowns of the PIM's Excel for the fields with no fixed list (user,
 * 2026-10-15: "todo donde el usuario deba meter algo manual … drop down").
 * The product page's open fields (suggestFields.js) and every other text
 * field of the import, but FREE_TEXT; the part-number pickers list SKUs.
 * Returns { field: [values…] } (sorted, distinct), keyed by column or
 * attribute name.
 */
export async function loadSuggestionLists() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('products')
      .select(['sku', 'category', 'product_type', ...SUGGEST_COLUMNS, 'attributes'].join(', '))
      .neq('workflow_status', 'archived')
      .order('sku')
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const valueOf = (r, field) => (field in r && field !== 'attributes' ? r[field] : r.attributes?.[field]);
  const collect = (field, keep = () => true) => [...new Set(rows.filter(keep)
    .map((r) => valueOf(r, field))
    .filter((v) => v != null && typeof v !== 'object' && String(v).trim())
    .map((v) => String(v).trim()))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const out = {};
  // every text field of the import, as the catalog writes it…
  for (const def of FIELD_DEFS) {
    const field = def.target.col ?? def.target.attr;
    if (!field || def.type !== 'text' || FREE_TEXT.has(field)) continue;
    const values = collect(field);
    if (values.length) out[field] = values;
  }
  // …the product page's open fields (some from some categories only)…
  for (const k of [...SUGGEST_COLUMNS, ...SUGGEST_ATTRS]) out[k] = collect(k);
  for (const [k, keep] of Object.entries(SUGGEST_FROM)) out[k] = collect(k, keep);
  // …and the part-number pickers
  for (const [field, type] of Object.entries(SKU_PICKERS)) {
    out[field] = rows.filter((r) => r.product_type === type).map((r) => r.sku).sort();
  }
  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  return out;
}
