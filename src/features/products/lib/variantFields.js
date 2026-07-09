// Shared helpers for reasoning about attributes across a variant family.

// Fields that typically DIFFER between variants — unchecked by default when
// propagating, and ignored by drift detection.
export const VARIANT_DISTINGUISHING = new Set([
  'finish', 'color', 'upc', 'general_title_en', 'general_title_fr',
  'description', 'description_fr', 'bullet_points', 'bullet_points_fr',
  'msrp_cad', 'dealer_cost_cad', 'sale_price_cad', 'factory_code',
  'sku', 'model_name', 'family_number',
  // Finish-specific: deck-plate part numbers match the faucet's finish
  // (A-803G for gold, A-803N for black, …), so they differ per variant.
  'compatible_deck_plate',
]);

// Columns (not attributes) worth keeping consistent across a family.
const SHARED_COLUMNS = ['material', 'product_type'];

export const prettifyKey = (k) =>
  k.replace(/_/g, ' ')
    .replace(/\b(in|mm|lb|cad|upc|ada|hs|fr|en)\b/gi, (m) => m.toUpperCase())
    .replace(/^\w/, (c) => c.toUpperCase());

// Read a field value from a product row, whether it's a column or an attribute.
export const readField = (product, { scope, key }) =>
  scope === 'column' ? product?.[key] : product?.attributes?.[key];

// Treat absent / '' / false / [] as the same "no value" so they don't register
// as drift (e.g. a sink-only boolean missing on faucets, or false vs undefined).
const isEmptyish = (v) => v == null || v === '' || v === false || (Array.isArray(v) && v.length === 0);
const norm = (x) => (isEmptyish(x) ? '∅' : JSON.stringify(x));

// Given the current product and its full sibling rows, return the shared fields
// whose values are NOT the same across the whole family (drift). Each entry's
// `value` is the CURRENT product's value (the source of truth for "unify").
export function computeFamilyDrift(current, siblings) {
  const members = [current, ...siblings];
  const out = [];

  const attrKeys = new Set();
  for (const m of members) for (const k of Object.keys(m.attributes ?? {})) attrKeys.add(k);
  for (const k of attrKeys) {
    if (VARIANT_DISTINGUISHING.has(k)) continue;
    const vals = new Set(members.map((m) => norm(m.attributes?.[k])));
    if (vals.size > 1) out.push({ scope: 'attr', key: k, label: prettifyKey(k), value: current.attributes?.[k] ?? null });
  }

  for (const k of SHARED_COLUMNS) {
    if (VARIANT_DISTINGUISHING.has(k)) continue;
    const vals = new Set(members.map((m) => norm(m[k])));
    if (vals.size > 1) out.push({ scope: 'column', key: k, label: prettifyKey(k), value: current[k] ?? null });
  }

  return out;
}
