// Open-vocabulary fields: no fixed list (those live in fieldOptions.js), so
// their dropdown lists the values the catalog already uses, plus "Other…" on
// the product page. The page (loadSuggestions) and the PIM's Excel
// (suggestionLists) read the same fields (user, 2026-10-06 / 10-15: a
// dropdown wherever a value is typed, against typos).
export const SUGGEST_COLUMNS = ['material', 'finish', 'series', 'product_type', 'standards_compliance'];
export const SUGGEST_ATTRS = [
  'mounting_type', 'lock_type', 'application', 'safety_listings',
  'compatible_faucet_type', 'faucet_hole_center_spacing', 'compatible_pedestal',
  'wood_species', 'pattern', 'handle_material', 'faucet_centers', 'spray_head_functions',
  'pull_down_hose_model', 'cartridge_type', 'cartridge_size', 'grids_model_code',
  'warranty_url_us', 'warranty_url_ca', 'reason_for_restriction', 'commercial_warranty',
  'greenguard_certifications', 'cradle_to_cradle_certifications', 'sfi_certifications', 'fsc_certifications',
  'max_flow_rate', 'connection_size', 'safety_listing_registration_number',
];
// Fields whose suggestions come from some categories only (the others have a
// fixed list): accessories' Installation Type and Overall Shape.
export const SUGGEST_FROM = {
  installation_type: (r) => !String(r.category ?? '').includes('sink'),
  overall_shape: (r) => r.category === 'accessory',
};
