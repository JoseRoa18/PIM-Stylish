// PIM data completeness — "is this product 100% filled in?" scored from PIM
// (CANONICAL copy: src/features/products/lib/completeness.js re-exports this file.)
// data ONLY (no channel state: nothing about links, stock or channel prices).
// Computed live from the catalog on every load, so any edit shows at once.
//
// Every check declares which categories it applies to; a product is COMPLETE
// when every applicable check passes. Groups map to the product tab where
// the gap gets fixed. A check answers true / false, or a string when the
// field is filled but WRONG (user request 2026-10-05: a bad UPC, a shipping
// weight under the product's) — the string is shown as the reason.
// Shared with the health-refresh edge function (daily KPI snapshots), so it
// stays pure JS importing only from _shared. Category labels mirror
// src/features/products/lib/categories.js; keep both in step.
import { COUNTRY_NAMES } from './countries.js';

export const CATEGORY_LABEL = {
  kitchen_sink: 'Kitchen Sink',
  bathroom_sink: 'Bathroom Sink',
  kitchen_faucet: 'Kitchen Faucet',
  bathroom_faucet: 'Bathroom Faucet',
  pot_filler: 'Pot Filler',
  bar_prep_sink: 'Bar/Prep Sink',
  laundry_sink: 'Laundry Sink',
  outdoor_sink: 'Outdoor Sink & Ice Chest',
  colander_drying_rack: 'Colanders & Drying Racks',
  accessory: 'Accessory',
};

const SINKS = ['kitchen_sink', 'bar_prep_sink', 'laundry_sink', 'outdoor_sink', 'bathroom_sink'];
const KITCHEN_SINKS = ['kitchen_sink', 'bar_prep_sink', 'laundry_sink', 'outdoor_sink'];
const FAUCETS = ['kitchen_faucet', 'bathroom_faucet', 'pot_filler'];
const ALL = null; // applies to every category
// Faucets describe size by spout height/reach, not by an overall L×W×H.
const NOT_FAUCETS = ['kitchen_sink', 'bar_prep_sink', 'laundry_sink', 'outdoor_sink', 'bathroom_sink', 'colander_drying_rack', 'accessory'];

const text = (v) => typeof v === 'string' && v.trim().length > 0;
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const list = (v, min = 1) => Array.isArray(v) && v.filter((x) => text(String(x ?? ''))).length >= min;
const dims = (v) => !!v && typeof v === 'object' && Object.values(v).filter((x) => num(x)).length >= 2;
const attr = (p, k) => p?.attributes?.[k] ?? null;
// Some fields live both as a product column and inside attributes; an empty
// column ('' / [] / null) must not hide a filled attribute.
const empty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
const field = (p, k) => (empty(p?.[k]) ? attr(p, k) : p[k]);
const stainless = (p) => /stainless/i.test(String(p.material ?? ''));
const PLACEHOLDER_UPC = /^(0+|840994000000)$/;
const HS_FORMAT = /^\d{4}\.\d{2}\.\d{4}$/; // 7323.93.0060 — every code in the PIM
const COUNTRY_SET = new Set(COUNTRY_NAMES);
const productWeight = (p) => Number(field(p, 'product_weight_lb') ?? p.weight_lb);

// UPC-A (12), EAN-13 or GTIN-14 with a correct check digit.
function upcIssue(upc) {
  if (!/^\d+$/.test(upc)) return `${upc} is not a number`;
  if (upc.length < 12 || upc.length > 14) return `${upc} has ${upc.length} digits (a UPC has 12)`;
  const digits = upc.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check ? null : `${upc} has a wrong check digit`;
}
const upcOf = (p) => String(field(p, 'upc') ?? '').trim();

const images = (media) => (media ?? []).filter((m) => m.media_type === 'image');
const docs = (media) => (media ?? []).filter((m) => m.media_type === 'document');

// A select / text / Yes-No field counts once it holds a value; an empty
// Yes/No is missing, a stored "No" (false) is filled (user, 2026-10-05).
const filled = (v) => {
  if (v == null) return false;
  if (typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return list(v);
  return text(String(v));
};
const has = (k) => (p) => filled(attr(p, k));
const hasNum = (k) => (p) => num(Number(attr(p, k)));
const yes = (v) => v === true || /^(yes|true)$/i.test(String(v ?? '').trim());
const doubleBowl = (p) => Number(field(p, 'number_of_bowls')) >= 2;
const pullDown = (p) => /pull/i.test(String(attr(p, 'spray_type') ?? '')) || /pull/i.test(String(p.product_type ?? ''));
const KITCHEN_FAUCETS = ['kitchen_faucet', 'pot_filler'];

// group = the product page tab where the field is filled in (deep link),
// in the tab order of the product page.
export const GROUPS = {
  Overview: { tab: 'overview', order: 1 },
  Specifications: { tab: 'specs', order: 2 },
  Content: { tab: 'content', order: 3 },
  Pricing: { tab: 'pricing', order: 4 },
  Images: { tab: 'media', order: 5 },
  Documents: { tab: 'media', order: 6 },
};

// The mandatory fields (user list of 2026-10-05 for Overview and
// Specifications), each where it APPLIES: kitchen-only fields are not asked
// of bathroom sinks and faucets, and a field that depends on another one
// (Basin Split on a double bowl, Spout Rotation on a swivel spout, the spray
// fields on a faucet with a spray, the hose on a pull-down) only when it does.
// Labels and sections are the product page's own.
// { key, label, group, section, cats: null | string[], applies?(product), check(product, media, ctx) }
// Keys never change (the daily KPI snapshots count gaps by key).
export const CHECKS = [
  // ---- Overview ----
  { key: 'sku', label: 'SKU', group: 'Overview', section: 'Identification', cats: ALL, check: (p) => text(p.sku) },
  {
    key: 'upc', label: 'UPC (valid, unique)', group: 'Overview', section: 'Identification', cats: ALL,
    check: (p, m, ctx) => {
      const upc = upcOf(p);
      if (!upc || PLACEHOLDER_UPC.test(upc)) return false;
      const issue = upcIssue(upc);
      if (issue) return issue;
      const others = (ctx?.upcOwners?.get(upc) ?? []).filter((s) => s !== p.sku);
      return others.length ? `Same UPC as ${others.join(', ')}` : true;
    },
  },
  { key: 'brand', label: 'Brand', group: 'Overview', section: 'Identification', cats: ALL, check: (p) => text(p.brand) },
  { key: 'manufacturer', label: 'Manufacturer', group: 'Overview', section: 'Identification', cats: ALL, check: has('manufacturer') },
  { key: 'category', label: 'Category', group: 'Overview', section: 'Identification', cats: ALL, check: (p) => text(p.category) },
  { key: 'series', label: 'Series', group: 'Overview', section: 'Identification', cats: ALL, check: (p) => filled(p.series) },
  { key: 'product_type', label: 'Product Type', group: 'Overview', section: 'Identification', cats: ALL, check: (p) => filled(p.product_type) },
  // The product's name, edited at the top of the product page.
  { key: 'collection', label: 'Collection name', group: 'Overview', section: 'Page header', cats: ALL, check: (p) => text(p.model_name) },
  {
    key: 'country', label: 'Country of Origin', group: 'Overview', section: 'Trade & Compliance', cats: ALL,
    check: (p) => {
      const c = String(field(p, 'country_of_origin') ?? '').trim();
      if (!c) return false;
      return COUNTRY_SET.has(c) ? true : `"${c}" is not in the country list`;
    },
  },
  // Every category since 2026-10-05 (was sinks only; the user's list covers the catalog).
  {
    key: 'hs_code', label: 'HS Code', group: 'Overview', section: 'Trade & Compliance', cats: ALL,
    check: (p) => {
      const hs = String(field(p, 'hs_code') ?? '').trim();
      if (!hs) return false;
      return HS_FORMAT.test(hs) ? true : `${hs} is not in the ####.##.#### format`;
    },
  },
  { key: 'warranty', label: 'Warranty', group: 'Overview', section: 'Trade & Compliance', cats: ALL, check: has('warranty') },
  { key: 'warranty_length', label: 'Warranty Length', group: 'Overview', section: 'Trade & Compliance', cats: ALL, check: has('warranty_length') },
  { key: 'warranty_url_us', label: 'Warranty URL (USA)', group: 'Overview', section: 'Trade & Compliance', cats: ALL, check: has('warranty_url_us') },
  { key: 'warranty_url_ca', label: 'Warranty URL (Canada)', group: 'Overview', section: 'Trade & Compliance', cats: ALL, check: has('warranty_url_ca') },
  { key: 'warranty_text_us', label: 'Warranty Text (USA)', group: 'Overview', section: 'Trade & Compliance', cats: ALL, check: has('warranty_text_us') },
  { key: 'warranty_text_ca', label: 'Warranty Text (Canada)', group: 'Overview', section: 'Trade & Compliance', cats: ALL, check: has('warranty_text_ca') },

  // ---- Specifications: Physical Properties ----
  { key: 'material', label: 'Material', group: 'Specifications', section: 'Physical Properties', cats: ALL, check: (p) => text(p.material) },
  { key: 'finish', label: 'Finish', group: 'Specifications', section: 'Physical Properties', cats: ALL, check: (p) => text(p.finish) },
  { key: 'craftsmanship', label: 'Craftsmanship', group: 'Specifications', section: 'Physical Properties', cats: ALL, check: has('craftsmanship') },
  { key: 'shape', label: 'Sink Shape', group: 'Specifications', section: 'Physical Properties', cats: SINKS, check: (p) => text(String(field(p, 'sink_shape') ?? p.shape ?? '')) },
  { key: 'installation', label: 'Installation Type', group: 'Specifications', section: 'Physical Properties', cats: SINKS, check: (p) => text(String(field(p, 'installation_type') ?? '')) || list(field(p, 'installation_type')) },
  { key: 'gauge', label: 'Gauge (stainless steel)', group: 'Specifications', section: 'Physical Properties', cats: SINKS, applies: (p) => stainless(p), check: (p) => num(Number(field(p, 'gauge'))) },
  { key: 'care', label: 'Care Instructions', group: 'Specifications', section: 'Physical Properties', cats: SINKS, check: (p) => text(String(attr(p, 'product_care') ?? '')) },

  // ---- Specifications: Bowl Configuration ----
  { key: 'bowls', label: 'Number of Bowls', group: 'Specifications', section: 'Bowl Configuration', cats: SINKS, check: (p) => num(Number(field(p, 'number_of_bowls'))) },
  { key: 'bowl_configuration', label: 'Bowl Configuration', group: 'Specifications', section: 'Bowl Configuration', cats: KITCHEN_SINKS, check: has('bowl_configuration') },
  { key: 'basin_split', label: 'Basin Split (double bowl)', group: 'Specifications', section: 'Bowl Configuration', cats: SINKS, applies: doubleBowl, check: has('basin_split') },
  { key: 'low_divider', label: 'Low Divider', group: 'Specifications', section: 'Bowl Configuration', cats: KITCHEN_SINKS, check: has('low_divider') },
  { key: 'strainer_model', label: 'Strainer Model', group: 'Specifications', section: 'Bowl Configuration', cats: KITCHEN_SINKS, check: has('strainer_model') },
  { key: 'sink_radius', label: 'Sink Radius (mm)', group: 'Specifications', section: 'Bowl Configuration', cats: KITCHEN_SINKS, check: hasNum('sink_radius_mm') },
  { key: 'drain', label: 'Drain Diameter', group: 'Specifications', section: 'Bowl Configuration', cats: SINKS, check: (p) => num(Number(field(p, 'drain_diameter_in'))) },
  // Bathroom sinks show it in their own "Bathroom Sink" section.
  { key: 'drain_location', label: 'Drain Location', group: 'Specifications', section: 'Bowl Configuration', cats: SINKS, check: (p) => text(String(attr(p, 'drain_hole_location') ?? '')) },
  { key: 'has_grooves', label: 'Has Grooves', group: 'Specifications', section: 'Bowl Configuration', cats: KITCHEN_SINKS, check: has('has_grooves') },
  { key: 'includes_grids', label: 'Includes Grids', group: 'Specifications', section: 'Bowl Configuration', cats: KITCHEN_SINKS, check: has('includes_grids') },

  // ---- Specifications: Faucet Configuration ----
  { key: 'spout_type', label: 'Spout Type', group: 'Specifications', section: 'Faucet Configuration', cats: KITCHEN_FAUCETS, check: has('spout_type') },
  { key: 'overall_shape', label: 'Overall Shape', group: 'Specifications', section: 'Faucet Configuration', cats: FAUCETS, check: has('overall_shape') },
  { key: 'swivel_spout', label: 'Swivel Spout', group: 'Specifications', section: 'Faucet Configuration', cats: KITCHEN_FAUCETS, check: has('swivel_spout') },
  { key: 'spout_rotation', label: 'Spout Rotation (swivel spout)', group: 'Specifications', section: 'Faucet Configuration', cats: KITCHEN_FAUCETS, applies: (p) => yes(attr(p, 'swivel_spout')), check: hasNum('spout_rotation_degrees') },
  { key: 'flow_rate', label: 'Max Flow Rate (GPM)', group: 'Specifications', section: 'Faucet Configuration', cats: FAUCETS, check: (p) => num(Number(attr(p, 'max_flow_rate'))) },
  { key: 'holes', label: 'Installation Holes', group: 'Specifications', section: 'Faucet Configuration', cats: FAUCETS, check: (p) => Number.isFinite(Number(attr(p, 'number_of_installation_holes'))) && attr(p, 'number_of_installation_holes') !== null },
  { key: 'mounting_type', label: 'Mounting / Installation Type', group: 'Specifications', section: 'Faucet Configuration', cats: FAUCETS, check: has('mounting_type') },
  { key: 'connection_size', label: 'Connection Size', group: 'Specifications', section: 'Faucet Configuration', cats: FAUCETS, check: has('connection_size') },
  { key: 'lock_type', label: 'Lock Type', group: 'Specifications', section: 'Faucet Configuration', cats: KITCHEN_FAUCETS, check: has('lock_type') },
  { key: 'hot_cold_dispenser', label: 'Hot & Cold Dispenser', group: 'Specifications', section: 'Faucet Configuration', cats: KITCHEN_FAUCETS, check: has('hot_cold_dispenser') },

  // ---- Specifications: Handles, Spray & Cartridge ----
  { key: 'handles', label: 'Number of Handles', group: 'Specifications', section: 'Handles, Spray & Cartridge', cats: FAUCETS, check: (p) => Number.isFinite(Number(attr(p, 'number_of_handles'))) && attr(p, 'number_of_handles') !== null },
  { key: 'handles_included', label: 'Handle(s) Included', group: 'Specifications', section: 'Handles, Spray & Cartridge', cats: FAUCETS, check: has('handles_included') },
  { key: 'handle_style', label: 'Handle Style', group: 'Specifications', section: 'Handles, Spray & Cartridge', cats: FAUCETS, check: has('handle_style') },
  { key: 'cold_start_handle', label: 'Cold Start Handle', group: 'Specifications', section: 'Handles, Spray & Cartridge', cats: KITCHEN_FAUCETS, check: has('cold_start_handle') },
  { key: 'spray_included', label: 'Spray Included', group: 'Specifications', section: 'Handles, Spray & Cartridge', cats: KITCHEN_FAUCETS, check: has('spray_included') },
  { key: 'spray_type', label: 'Spray Type (with spray)', group: 'Specifications', section: 'Handles, Spray & Cartridge', cats: KITCHEN_FAUCETS, applies: (p) => yes(attr(p, 'spray_included')), check: has('spray_type') },
  { key: 'spray_activation', label: 'Spray Activation (with spray)', group: 'Specifications', section: 'Handles, Spray & Cartridge', cats: KITCHEN_FAUCETS, applies: (p) => yes(attr(p, 'spray_included')), check: has('spray_function_activation') },
  { key: 'spray_head_functions', label: 'Spray Head Functions (with spray)', group: 'Specifications', section: 'Handles, Spray & Cartridge', cats: KITCHEN_FAUCETS, applies: (p) => yes(attr(p, 'spray_included')), check: has('spray_head_functions') },
  { key: 'pull_down_hose', label: 'Pull-Down Hose Model (pull-down)', group: 'Specifications', section: 'Handles, Spray & Cartridge', cats: KITCHEN_FAUCETS, applies: pullDown, check: has('pull_down_hose_model') },
  { key: 'cartridge_type', label: 'Cartridge Type', group: 'Specifications', section: 'Handles, Spray & Cartridge', cats: FAUCETS, check: has('cartridge_type') },
  { key: 'cartridge_size', label: 'Cartridge Size', group: 'Specifications', section: 'Handles, Spray & Cartridge', cats: FAUCETS, check: has('cartridge_size') },

  // ---- Specifications: Faucet Dimensions ----
  { key: 'faucet_height', label: 'Faucet Height', group: 'Specifications', section: 'Faucet Dimensions', cats: FAUCETS, check: hasNum('faucet_height_in') },
  { key: 'spout_reach', label: 'Spout Reach', group: 'Specifications', section: 'Faucet Dimensions', cats: FAUCETS, check: hasNum('spout_reach_in') },
  { key: 'spout_height', label: 'Spout Height', group: 'Specifications', section: 'Faucet Dimensions', cats: FAUCETS, check: hasNum('spout_height_in') },
  {
    key: 'install_hole_mm', label: 'Install Hole Ø (mm)', group: 'Specifications', section: 'Faucet Dimensions', cats: KITCHEN_FAUCETS,
    check: (p) => {
      const mm = Number(attr(p, 'install_hole_diameter_mm'));
      if (!num(mm)) return false;
      // It must be the inch value in millimetres (62 faucets held "1").
      const inch = Number(attr(p, 'install_hole_diameter_in'));
      return num(inch) && Math.abs(mm - inch * 25.4) > 2.5 ? `${mm} mm does not match ${inch} in (≈ ${Math.round(inch * 25.4)} mm)` : true;
    },
  },
  { key: 'install_hole_in', label: 'Install Hole Ø', group: 'Specifications', section: 'Faucet Dimensions', cats: FAUCETS, check: hasNum('install_hole_diameter_in') },
  { key: 'deck', label: 'Max Deck Thickness', group: 'Specifications', section: 'Faucet Dimensions', cats: FAUCETS, check: hasNum('max_deck_thickness_in') },

  // ---- Specifications: Dimensions & Weight ----
  // Faucets describe size by spout height/reach, not by an overall L×W×H.
  { key: 'external_dims', label: 'External Dimensions', group: 'Specifications', section: 'Dimensions & Weight', cats: NOT_FAUCETS, check: (p) => dims(attr(p, 'external_dimensions_in')) },
  { key: 'internal_dims', label: 'Internal Dimensions', group: 'Specifications', section: 'Dimensions & Weight', cats: SINKS, check: (p) => dims(attr(p, 'internal_dimensions_in')) },
  { key: 'left_bowl_depth', label: 'Left Bowl Depth (double bowl)', group: 'Specifications', section: 'Dimensions & Weight', cats: SINKS, applies: doubleBowl, check: hasNum('left_bowl_depth_in') },
  { key: 'right_bowl_depth', label: 'Right Bowl Depth (double bowl)', group: 'Specifications', section: 'Dimensions & Weight', cats: SINKS, applies: doubleBowl, check: hasNum('right_bowl_depth_in') },
  { key: 'product_weight', label: 'Product Weight', group: 'Specifications', section: 'Dimensions & Weight', cats: ALL, check: (p) => num(productWeight(p)) },
  { key: 'cabinet', label: 'Min External Cabinet', group: 'Specifications', section: 'Dimensions & Weight', cats: KITCHEN_SINKS, check: hasNum('min_external_cabinet_size_in') },
  { key: 'min_internal_cabinet', label: 'Min Internal Cabinet', group: 'Specifications', section: 'Dimensions & Weight', cats: KITCHEN_SINKS, check: hasNum('min_internal_cabinet_size_in') },
  { key: 'sink_deck', label: 'Max Deck Thickness (sink)', group: 'Specifications', section: 'Dimensions & Weight', cats: KITCHEN_SINKS, check: hasNum('max_deck_thickness_in') },
  { key: 'cut_out', label: 'Cut-out Dimensions', group: 'Specifications', section: 'Dimensions & Weight', cats: SINKS, check: (p) => dims(attr(p, 'cut_out_dimensions_in')) },

  // ---- Specifications: Shipping ----
  {
    key: 'ship_weight', label: 'Shipping Weight', group: 'Specifications', section: 'Shipping', cats: ALL,
    check: (p) => {
      if (!num(p.shipping_weight_lb)) return false;
      const pw = productWeight(p);
      // The box weighs at least what is inside it.
      return num(pw) && p.shipping_weight_lb < pw ? `${p.shipping_weight_lb} lb is less than the product's ${pw} lb` : true;
    },
  },
  { key: 'ship_dims', label: 'Shipping Dimensions', group: 'Specifications', section: 'Shipping', cats: ALL, check: (p) => dims(attr(p, 'shipping_dimensions_in')) },

  // ---- Content ----
  { key: 'title_en', label: 'General Title (EN)', group: 'Content', section: 'English Content', cats: ALL, check: (p) => text(attr(p, 'general_title_en')) },
  { key: 'description_en', label: 'Product Description (100+ characters)', group: 'Content', section: 'English Content', cats: ALL, check: (p) => text(p.description) && p.description.replace(/<[^>]*>/g, '').trim().length >= 100 },
  { key: 'bullets_en', label: '4+ Bullet Points (EN)', group: 'Content', section: 'Bullet Points / Features (EN)', cats: ALL, check: (p) => list(field(p, 'bullet_points'), 4) },
  { key: 'keywords', label: 'Keywords (EN)', group: 'Content', section: 'Search Keywords (EN)', cats: ALL, check: (p) => list(attr(p, 'keywords_en')) || text(attr(p, 'keywords_en')) },
  { key: 'title_fr', label: 'General Title (FR)', group: 'Content', section: 'French Content', cats: ALL, check: (p) => text(attr(p, 'general_title_fr')) },
  { key: 'description_fr', label: 'Description (FR)', group: 'Content', section: 'French Content', cats: ALL, check: (p) => text(attr(p, 'description_fr')) },
  { key: 'bullets_fr', label: '4+ Bullet Points (FR)', group: 'Content', section: 'Bullet Points / Features (FR)', cats: ALL, check: (p) => list(attr(p, 'bullet_points_fr'), 4) },

  // ---- Pricing (both markets) ----
  { key: 'msrp_cad', label: 'MSRP CAD', group: 'Pricing', section: 'Canada Pricing (CAD)', cats: ALL, check: (p) => num(p.msrp_cad) },
  { key: 'map_cad', label: 'MAP CAD', group: 'Pricing', section: 'Canada Pricing (CAD)', cats: ALL, check: (p) => num(p.map_cad) },
  { key: 'cost_cad', label: 'Costs CAD (Rona/HD + Small Online Dealers)', group: 'Pricing', section: 'Canada Pricing (CAD)', cats: ALL, check: (p) => num(p.cost_cad_rona_hd) && num(p.cost_cad_wayfair_sod) },
  { key: 'msrp_usd', label: 'MSRP USD', group: 'Pricing', section: 'USA Pricing (USD)', cats: ALL, check: (p) => num(p.msrp_usd) },
  { key: 'map_usd', label: 'MAP USD', group: 'Pricing', section: 'USA Pricing (USD)', cats: ALL, check: (p) => num(p.map_usd) },
  { key: 'cost_usd', label: 'Costs USD (Wayfair + Lowe\'s/SOD/BB&B)', group: 'Pricing', section: 'USA Pricing (USD)', cats: ALL, check: (p) => num(p.cost_usd_wayfair) && num(p.cost_usd_lowes_sod_bbb) },

  // ---- Media: Images ----
  { key: 'hero', label: 'Gray hero (SinksDirect main)', group: 'Images', section: 'Images', cats: ALL, check: (p, m) => images(m).some((x) => x.image_role === 'sinksdirect_main') },
  { key: 'main', label: 'White main (primary)', group: 'Images', section: 'Images', cats: ALL, check: (p, m) => images(m).some((x) => x.is_primary) },
  { key: 'five_images', label: '5+ images', group: 'Images', section: 'Images', cats: ALL, check: (p, m) => images(m).length >= 5 },
  { key: 'set_en_fr', label: 'EN-FR image set (3+)', group: 'Images', section: 'Images', cats: ALL, check: (p, m) => images(m).filter((x) => x.language === 'en_fr').length >= 3 },

  // ---- Media: Documents ----
  { key: 'spec_sheet', label: 'Spec sheet', group: 'Documents', section: 'Documents', cats: ALL, check: (p, m) => docs(m).some((d) => d.document_type === 'spec_sheet') },
  { key: 'installation_doc', label: 'Installation guide', group: 'Documents', section: 'Documents', cats: [...SINKS, ...FAUCETS], check: (p, m) => docs(m).some((d) => /^installation_/.test(d.document_type ?? '')) },
  { key: 'warranty_doc', label: 'Warranty document', group: 'Documents', section: 'Documents', cats: ALL, check: (p, m) => docs(m).some((d) => d.document_type === 'warranty_file') },
];

export function applicableChecks(product) {
  const cat = product?.category ?? '';
  return CHECKS.filter((c) => (c.cats === ALL || c.cats.includes(cat)) && (!c.applies || c.applies(product)));
}

/**
 * What the checks need to know about the rest of the catalog: which SKUs
 * carry each UPC (a UPC on two products fails both). Build it from the same
 * product list that is being scored.
 */
export function completenessContext(products) {
  const upcOwners = new Map();
  for (const p of products ?? []) {
    const upc = upcOf(p);
    if (!upc || PLACEHOLDER_UPC.test(upc)) continue;
    if (!upcOwners.has(upc)) upcOwners.set(upc, []);
    upcOwners.get(upc).push(p.sku);
  }
  return { upcOwners };
}

/**
 * `ctx` (from completenessContext) is optional: without it a UPC is not
 * compared with other products.
 * @returns {{ score: number, complete: boolean, passed: object[], missing: object[] }}
 *   each missing item carries `note` when the field is filled but wrong
 */
export function scoreCompleteness(product, media, ctx = null) {
  const checks = applicableChecks(product);
  const passed = [];
  const missing = [];
  for (const c of checks) {
    let out;
    try { out = c.check(product, media, ctx); } catch { out = false; }
    const note = typeof out === 'string' ? out : null;
    const item = { key: c.key, label: c.label, group: c.group, section: c.section, tab: GROUPS[c.group].tab };
    if (!note && out) passed.push(item);
    else missing.push(note ? { ...item, note } : item);
  }
  const score = checks.length ? Math.round((passed.length / checks.length) * 100) : 100;
  return { score, complete: missing.length === 0, passed, missing };
}

/** Group scored products by category: totals, complete count, average, top gaps. */
export function summarizeByCategory(rows) {
  const by = new Map();
  for (const r of rows) {
    const cat = r.category ?? 'uncategorized';
    if (!by.has(cat)) by.set(cat, { category: cat, label: CATEGORY_LABEL[cat] ?? cat, total: 0, complete: 0, scoreSum: 0, gaps: new Map(), products: [] });
    const g = by.get(cat);
    g.total += 1;
    g.scoreSum += r.result.score;
    if (r.result.complete) g.complete += 1;
    for (const m of r.result.missing) {
      const cur = g.gaps.get(m.key) ?? { ...m, count: 0 };
      cur.count += 1;
      g.gaps.set(m.key, cur);
    }
    g.products.push(r);
  }
  return [...by.values()]
    .map((g) => ({
      ...g,
      pct: g.total ? Math.round((g.complete / g.total) * 100) : 0,
      avg: g.total ? Math.round(g.scoreSum / g.total) : 0,
      gaps: [...g.gaps.values()].sort((a, b) => b.count - a.count),
      products: g.products.sort((a, b) => a.result.score - b.result.score || a.sku.localeCompare(b.sku)),
    }))
    .sort((a, b) => a.pct - b.pct || b.total - a.total);
}

/**
 * Group scored products by check (the PIM tab's "By field" view): how many
 * products each check applies to and which of them miss it — with the
 * reason when the field is filled but wrong. Most missing first.
 */
export function summarizeByCheck(rows) {
  const by = new Map(CHECKS.map((c, order) => [c.key, { key: c.key, label: c.label, group: c.group, section: c.section, tab: GROUPS[c.group].tab, order, applies: 0, products: [] }]));
  for (const r of rows) {
    for (const p of r.result.passed) by.get(p.key).applies += 1;
    for (const m of r.result.missing) {
      const f = by.get(m.key);
      f.applies += 1;
      f.products.push({ sku: r.sku, model_name: r.model_name, brand: r.brand, category: r.category, note: m.note ?? null });
    }
  }
  return [...by.values()]
    .filter((f) => f.applies > 0)
    // floor: one product missing out of 365 reads 99%, never 100%
    .map((f) => ({ ...f, pct: Math.floor(((f.applies - f.products.length) / f.applies) * 100) }))
    .sort((a, b) => b.products.length - a.products.length || a.order - b.order);
}

/**
 * KPI snapshot rows for one day: catalog totals, per-category totals and the
 * count of products missing each check — enough to compare weeks and to say
 * which gaps closed. Same shape from the cron and from the browser.
 * @param {{ sku, category, result }[]} rows  scored products
 * @param {string} date  YYYY-MM-DD
 */
export function snapshotMetrics(rows, date) {
  const totals = (list) => {
    const missing = {};
    let scoreSum = 0;
    let complete = 0;
    for (const r of list) {
      scoreSum += r.result.score;
      if (r.result.complete) complete += 1;
      for (const m of r.result.missing) missing[m.key] = (missing[m.key] ?? 0) + 1;
    }
    const total = list.length;
    return {
      total,
      complete,
      pct: total ? Math.round((complete / total) * 100) : 0,
      avg: total ? Math.round(scoreSum / total) : 0,
      missing,
    };
  };
  // The catalog row also carries per-SKU detail: every product's score, which
  // SKUs miss each check (gap aging = how many days a SKU stays in that
  // list) and the workflow funnel. Small enough (a few KB) to keep daily.
  const all = totals(rows);
  const scores = {};
  const missingSkus = {};
  const workflow = {};
  for (const r of rows) {
    scores[r.sku] = r.result.score;
    const w = r.workflow_status ?? 'unknown';
    workflow[w] = (workflow[w] ?? 0) + 1;
    for (const m of r.result.missing) (missingSkus[m.key] ??= []).push(r.sku);
  }
  const out = [{ snapshot_date: date, scope: 'pim', key: 'all', metrics: { ...all, scores, missing_skus: missingSkus, workflow } }];
  const byCat = new Map();
  for (const r of rows) {
    const cat = r.category ?? 'uncategorized';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(r);
  }
  for (const [cat, list] of byCat) {
    out.push({ snapshot_date: date, scope: 'pim_category', key: cat, metrics: totals(list) });
  }
  return out;
}
