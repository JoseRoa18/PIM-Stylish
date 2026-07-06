// Wayfair Product Addition template mapping (PIM → Wayfair columns).
//
// Rules are keyed by the template's DISPLAY NAME (header row 3), which is stable
// and shared across faucet categories, so one config covers kitchen (653) and
// bathroom (655) templates. A rule that has no matching column is simply
// ignored. Choice values are snapped to the template's Valid Values in
// wayfairExport (case-insensitive), so rules return the *intended* value here.

const attr = (p) => p.attributes || {};

// ---- value transforms ----
const num = (v) => {
  if (v == null || v === '') return '';
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? m[0] : '';
};
export const stripHtml = (h) =>
  String(h || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{2,}/g, '\n')
    .trim();
const brandMap = (b) => (/azuni/i.test(b || '') ? 'Azuni' : 'STYLISH');
const yesNo = (v) => {
  if (v == null || v === '') return '';
  const s = String(v).toLowerCase();
  if (s.includes('yes')) return 'Yes';
  if (s.includes('no')) return 'No';
  return /^(y|true|1)/.test(s) ? 'Yes' : 'No';
};
// Yes / No / Does Not Apply (for the compliance Selects)
const yesNoDNA = (v) => {
  if (v == null || v === '') return 'No';
  const s = String(v).toLowerCase();
  if (s.includes('yes')) return 'Yes';
  if (s.includes('n/a') || s.includes('not app')) return 'Does Not Apply';
  return 'No';
};

// ---- value alias tables (PIM value → Wayfair option) ----
const FINISH_ALIAS = {
  'brushed stainless steel': 'Stainless Steel',
  'matte black with gold': 'Matte Black; Gold',
  'matte black with brushed stainless steel': 'Matte Black; Stainless Steel',
  white: 'Matte White',
  red: 'Does Not Apply',
};
const MOUNT_ALIAS = { 'one hole': 'Single-Hole', 'two holes': 'Centerset' };
const SPOUT_ALIAS = { foldable: 'Swivel' };
const alias = (table, v) => {
  if (!v) return '';
  const k = String(v).toLowerCase().trim();
  return table[k] ?? v;
};

const pieces = (p) => {
  const a = attr(p), out = [];
  if (a.deck_plate_included) out.push('Deck Plate');
  if (a.aerator_included) out.push('Aerator');
  if (a.supply_line_included) out.push('Supply Line');
  if (a.handles_included) out.push('Handle(s)');
  return out.join('; ');
};

// Rules: displayName → (product) => intended value.
// `product._images` is an array of public image URLs (primary first), attached
// by the generator.
export const WAYFAIR_RULES = {
  // Basic
  'Supplier Part Number': (p) => p.sku,
  Brand: (p) => brandMap(p.brand),
  'Manufacturer Part Number': (p) => p.sku,
  'Product Name': (p) => p.model_name || p.sku,
  'Universal Product Code': (p) => attr(p).upc || '',
  'Collection Name': (p) => p.series || '',
  'Manufacturer Product URL': (p) => (/azuni/i.test(p.brand) ? 'https://azuni.ca' : 'https://stylishkb.com'),
  'Amazon Seller SKU': () => '',
  // Pricing
  'Base Cost': () => '', // wholesale — deferred
  'Manufacturer Suggested Retail Price': (p) => p.msrp_cad || '',
  // Marketing
  'Marketing Copy': (p) => stripHtml(p.description),
  // Fulfillment (business defaults)
  'Minimum Order Quantity': () => 1,
  'Force Quantity Multiplier': () => 1,
  'Display Set Quantity': () => 1,
  'Product Weight': (p) => num(attr(p).product_weight_lb || p.shipping_weight_lb),
  'Ship Type': () => 'Small Parcel',
  'Lead Time': () => '24',
  'Replacement Lead Time': () => '24',
  'Carton Weight 1': (p) => num(p.shipping_weight_lb),
  'Carton Height 1': (p) => num(attr(p).shipping_dimensions_in?.height),
  'Carton Width 1': (p) => num(attr(p).shipping_dimensions_in?.width),
  'Carton Depth 1': (p) => num(attr(p).shipping_dimensions_in?.length),
  // Attributes
  'Product Type': (p) => (attr(p).number_of_handles == 2 ? 'Double Handle Kitchen Facuet' : 'Single Handle Kitchen Faucet'),
  Material: (p) => {
    const m = attr(p).material || p.material;
    return (Array.isArray(m) ? m : [m]).filter(Boolean).join('; ');
  },
  Durability: (p) => {
    const d = attr(p).durability_tags || [];
    return (Array.isArray(d) ? d : [d]).filter(Boolean).join('; ');
  },
  'Spout Type': (p) => alias(SPOUT_ALIAS, attr(p).spout_type),
  'Maximum Flow Rate': (p) => num(attr(p).max_flow_rate),
  'Sensor Type': () => 'No Sensor',
  'Supplier Intended and Approved Use': (p) => attr(p).application || 'Residential Use',
  'Handle Style': (p) => attr(p).handle_style || '',
  'Handle Material': (p) => attr(p).handle_material || '',
  Finish: (p) => alias(FINISH_ALIAS, p.finish),
  'Pieces Included': (p) => pieces(p),
  'Power Source': () => 'No Power Source Required / Manual',
  'Plating Material': () => 'Does Not Apply', // bathroom template
  'Overall Shape': () => 'Unavailable', // bathroom template
  'Overall Width - Side to Side': () => '', // deferred
  'Overall Depth - Front to Back': () => '', // deferred
  'Spout Reach - Front to Back': (p) => num(attr(p).spout_reach_in),
  'Spout/Faucet Height - Top to Bottom': (p) => num(attr(p).faucet_height_in || attr(p).spout_height_in),
  'Faucet Centers': (p) => num(attr(p).faucet_centers),
  'Number of Mounting Holes': (p) => num(attr(p).number_of_installation_holes),
  'Mounting / Installation': (p) => alias(MOUNT_ALIAS, attr(p).mounting_type),
  // Compliance
  'Commercial Warranty': () => 'No',
  'Wayfair Compliance Verified Program (including Baby Safety Alliance fka JPMA) for this product category': () => 'No',
  'Uniform Packaging and Labeling Regulations (UPLR) Compliant': (p) => yesNo(attr(p).uplr_compliant) || 'No',
  'Canada Product Restriction': (p) => yesNo(attr(p).canada_product_restriction) || 'No',
  'Reason for Restriction': (p) => attr(p).reason_for_restriction || 'Does Not Apply',
  'NSF/ANSI 61 Certified': () => 'No',
  'ASME A112.18.1/CSA B125.1 - 2018': (p) => yesNoDNA(attr(p).asme_csa_certified),
  'Title 24 Compliant': (p) => yesNoDNA(attr(p).title_24_compliant),
  'Warning Required': () => 'No',
  'Country Of Manufacturer': (p) => attr(p).country_of_origin || attr(p).country_of_origin_details || '',
};

// Numbered image / bullet columns are matched by pattern.
export const IMAGE_COL_RE = /^Image File Name or URL (\d+)$/;
export const BULLET_COL_RE = /^Feature Bullet (\d+)$/;
