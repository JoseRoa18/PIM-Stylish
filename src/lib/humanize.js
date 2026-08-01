/**
 * Human-readable names for raw field identifiers (product columns, attribute
 * keys, document types) that leak into UI copy — activity summaries, bulk-edit
 * confirmations, tooltips. Summaries are stored verbatim in the audit log, so
 * `humanizeSummary` also cleans strings that were saved before this existed.
 */

// Overrides where naive snake_case → spaces reads wrong (acronyms, prices,
// proper nouns). Everything else falls back to underscores → spaces.
const FIELD_LABELS = {
  sku: 'SKU',
  upc: 'UPC',
  msrp_cad: 'MSRP (CAD)',
  msrp_usd: 'MSRP (USD)',
  dealer_cost_cad: 'dealer cost (CAD)',
  quickbooks_description: 'QuickBooks description',
  spec_sheet: 'spec sheet',
  installation_manual: 'installation manual',
  installation_undermount: 'installation manual (undermount)',
  installation_drop_in: 'installation manual (drop-in)',
  installation_dual_mount: 'installation manual (dual mount)',
  installation_top_mount: 'installation manual (top mount)',
  warranty_file: 'warranty file',
  dxf_file: 'DXF file',
  dxf_undermount: 'DXF file (undermount)',
  dxf_drop_in: 'DXF file (drop-in)',
  dxf_dual_mount: 'DXF file (dual mount)',
  dxf_top_mount: 'DXF file (top mount)',
  cut_out_template: 'cut-out template',
  wix_product_id: 'Wix product ID',
  wayfair_item_group_id: 'Wayfair item group ID',
  en_fr: 'English-French',
  en_es: 'English-Spanish',
};

/**
 * One raw field identifier → a human label. Lowercase by design (labels sit
 * mid-sentence in summaries); acronyms and brand names keep their casing.
 */
export function humanizeFieldName(field) {
  if (!field) return '';
  const key = String(field).trim().toLowerCase();
  return FIELD_LABELS[key] ?? key.replace(/_/g, ' ');
}

/**
 * Replace raw field names inside an already-saved summary string, e.g.
 * "Edited product S-300 (quickbooks_description, msrp_cad)" →
 * "Edited product S-300 (QuickBooks description, MSRP (CAD))".
 * Only underscore-joined tokens are touched, so SKUs, prose, and
 * dash-separated model numbers pass through untouched.
 */
export function humanizeSummary(text) {
  if (!text) return text ?? '';
  return String(text).replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (token) =>
    humanizeFieldName(token)
  );
}

/**
 * Compact list of humanized field names: the first `max` are spelled out and
 * the rest collapse into a count — ['description', 'title', 'sku', 'upc']
 * → 'description, title +2 more'.
 */
export function formatFieldList(fields, max = 2) {
  if (!fields?.length) return '';
  const shown = fields.slice(0, max).map(humanizeFieldName);
  const hidden = fields.length - shown.length;
  return hidden > 0 ? `${shown.join(', ')} +${hidden} more` : shown.join(', ');
}
