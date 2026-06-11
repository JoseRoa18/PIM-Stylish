/**
 * Import schema — maps spreadsheet headers to PIM fields.
 *
 * Header matching is tolerant: headers are normalized (lowercase, alphanumeric
 * only) and each field lists aliases, so "External Lenght", "External Length"
 * and "External Sink Size Length (inches)" all land on the same field.
 *
 * Targets:
 *   { col: 'x' }          → direct products column
 *   { attr: 'x' }         → products.attributes JSONB key
 *   { dim: [group, axis]} → grouped dimension object in attributes
 */

export const normalizeHeader = (h) =>
  String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const CATEGORY_MAP = {
  'kitchen sink': 'kitchen_sink',
  'kitchen sinks': 'kitchen_sink',
  'bath sink': 'bath_sink',
  'bath sinks': 'bath_sink',
  'bathroom sink': 'bath_sink',
  'kitchen faucet': 'kitchen_faucet',
  'kitchen faucets': 'kitchen_faucet',
  'bath faucet': 'bath_faucet',
  'bath faucets': 'bath_faucet',
  'bathroom faucet': 'bath_faucet',
  'accessory': 'accessory',
  'accessories': 'accessory',
};

export const FIELD_DEFS = [
  // ---------- Identification ----------
  { key: 'sku', label: 'Model Number', aliases: ['modelnumber', 'sku', 'suppliersku'], type: 'text', target: { col: 'sku' }, required: true },
  { key: 'model_name', label: 'Model Name', aliases: ['modelname'], type: 'text', target: { col: 'model_name' } },
  // NOTE: "Family #" from spreadsheets is intentionally ignored — variant
  // families are derived automatically from the SKU base model (S-300XG → S-300).
  { key: 'brand', label: 'Brand', aliases: ['brand'], type: 'text', target: { col: 'brand' }, required: true },
  { key: 'category', label: 'Category', aliases: ['category'], type: 'category', target: { col: 'category' }, required: true },
  { key: 'series', label: 'Sinks Series', aliases: ['sinksseries', 'sinkseries', 'series'], type: 'text', target: { col: 'series' } },
  { key: 'product_type', label: 'Product Type', aliases: ['producttype'], type: 'text', target: { col: 'product_type' } },

  // ---------- Sink configuration ----------
  { key: 'sink_shape', label: 'Sink Shape', aliases: ['sinkshape'], type: 'text', target: { attr: 'sink_shape' } },
  { key: 'strainer_model', label: 'Strainer Model', aliases: ['strainermodel'], type: 'text', target: { attr: 'strainer_model' } },
  { key: 'number_of_bowls', label: 'Number of Bowls', aliases: ['numberofbowls'], type: 'int', target: { attr: 'number_of_bowls' } },
  { key: 'bowl_configuration', label: 'Bowl Configuration', aliases: ['bowlconfiguration'], type: 'text', target: { attr: 'bowl_configuration' } },
  { key: 'basin_split', label: 'Basin Split', aliases: ['basinsplit'], type: 'text', target: { attr: 'basin_split' } },
  { key: 'low_divider', label: 'Low Divider', aliases: ['lowdivider', 'lowdividershortheightdivider'], type: 'bool', target: { attr: 'low_divider' } },
  { key: 'gauge', label: 'Gauge', aliases: ['gauge'], type: 'text', target: { attr: 'gauge' } },
  { key: 'material', label: 'Material', aliases: ['material'], type: 'text', target: { col: 'material' } },
  { key: 'finish', label: 'Finish / Color', aliases: ['finishcolor', 'finish'], type: 'text', target: { col: 'finish' } },
  // Dual-mount sinks list two options ("Undermount; Drop-In") → stored as array
  { key: 'installation_type', label: 'Installation Options', aliases: ['installationoptions', 'installationtype'], type: 'list', target: { attr: 'installation_type' } },
  { key: 'sink_radius_mm', label: 'Sink Radius', aliases: ['sinkradius', 'sinkradiusmm'], type: 'number', target: { attr: 'sink_radius_mm' } },

  // ---------- External / internal dimensions ----------
  { key: 'ext_length', label: 'External Lenght', aliases: ['externallenght', 'externallength', 'externalsinksizelengthinches'], type: 'number', target: { dim: ['external_dimensions_in', 'length'] } },
  { key: 'ext_width', label: 'External Width', aliases: ['externalwidth', 'externalsinksizewidthinches'], type: 'number', target: { dim: ['external_dimensions_in', 'width'] } },
  { key: 'ext_depth', label: 'External Depth', aliases: ['externaldepth', 'externalsinksizedepthinches'], type: 'number', target: { dim: ['external_dimensions_in', 'depth'] } },
  { key: 'min_ext_cabinet', label: 'External Minimum Cabinet Size', aliases: ['externalminimumcabinetsize', 'minimunexternalcabinetsizeminimumcountertoplength'], type: 'number', target: { attr: 'min_external_cabinet_size_in' } },
  { key: 'int_length', label: 'Internal Lenght', aliases: ['internallenght', 'internallength', 'internalsinksizelengthinches'], type: 'number', target: { dim: ['internal_dimensions_in', 'length'] } },
  { key: 'int_width', label: 'Internal Width', aliases: ['internalwidth', 'internalsinksizewidthinches'], type: 'number', target: { dim: ['internal_dimensions_in', 'width'] } },
  { key: 'int_depth', label: 'Internal Depth', aliases: ['internaldepth', 'internalsinksizedepthinches'], type: 'number', target: { dim: ['internal_dimensions_in', 'depth'] } },
  { key: 'min_int_cabinet', label: 'Internal Minimum Cabinet Size', aliases: ['internalminimumcabinetsize', 'minimuminternalcabinetsize'], type: 'number', target: { attr: 'min_internal_cabinet_size_in' } },
  { key: 'max_deck', label: 'Maximum Deck Thickness', aliases: ['maximumdeckthickness'], type: 'number', target: { attr: 'max_deck_thickness_in' } },

  // ---------- Features ----------
  { key: 'has_grooves', label: 'Does it have Grooves?', aliases: ['doesithavegrooves'], type: 'bool', target: { attr: 'has_grooves' } },
  { key: 'includes_grids', label: 'Include grids?', aliases: ['includegrids', 'includesgrids'], type: 'bool', target: { attr: 'includes_grids' } },
  { key: 'accessories_included', label: 'Accessories included', aliases: ['accessoriesincluded'], type: 'list', target: { attr: 'accessories_included' } },
  { key: 'number_of_pieces', label: 'Number of pieces Included', aliases: ['numberofpiecesincluded'], type: 'int', target: { attr: 'number_of_pieces' } },
  { key: 'drain_hole_location', label: 'Drain Hole location', aliases: ['drainholelocation', 'drainholelocationplacement'], type: 'text', target: { attr: 'drain_hole_location' } },
  { key: 'drain_diameter_in', label: 'Drain Diameter', aliases: ['draindiameter'], type: 'number', target: { attr: 'drain_diameter_in' } },
  { key: 'product_weight_lb', label: 'Product Weight lb', aliases: ['productweightlb'], type: 'number', target: { attr: 'product_weight_lb' } },

  // ---------- Trade & compliance ----------
  { key: 'country_of_origin', label: 'Country of Origen', aliases: ['countryoforigen', 'countryoforigin'], type: 'text', target: { attr: 'country_of_origin' } },
  { key: 'scc_compliant', label: 'SCC Compliant', aliases: ['scccompliant'], type: 'text', target: { attr: 'scc_compliant' } },
  { key: 'safety_listings', label: 'Safety Listing(s)', aliases: ['safetylistings', 'safetylisting'], type: 'text', target: { attr: 'safety_listings' } },
  { key: 'upc_certified', label: 'UPC Certified', aliases: ['upccertified'], type: 'text', target: { attr: 'upc_certified' } },
  { key: 'vermont_compliant', label: 'Vermont Act 193 Compliant', aliases: ['vermontact193compliant'], type: 'text', target: { attr: 'vermont_act_193_compliant' } },
  { key: 'hs_code', label: 'HS CODE', aliases: ['hscode'], type: 'text', target: { attr: 'hs_code' } },
  { key: 'upc', label: 'Master UPC', aliases: ['masterupc', 'upc'], type: 'upc', target: { attr: 'upc' } },

  // ---------- Shipping ----------
  { key: 'shipping_weight_lb', label: 'Shipping Weight Lbs', aliases: ['shippingweightlbs', 'shippingweightlb'], type: 'number', target: { col: 'shipping_weight_lb' } },
  { key: 'ship_height', label: 'Shipping Height (in)', aliases: ['shippingheightin', 'shippingheight'], type: 'number', target: { dim: ['shipping_dimensions_in', 'height'] } },
  { key: 'ship_width', label: 'Shipping Width (in)', aliases: ['shippingwidthin', 'shippingwidth'], type: 'number', target: { dim: ['shipping_dimensions_in', 'width'] } },
  { key: 'ship_length', label: 'Shipping Length (in)', aliases: ['shippinglengthin', 'shippinglength'], type: 'number', target: { dim: ['shipping_dimensions_in', 'length'] } },

  // ---------- Cut-out ----------
  { key: 'cutout_depth', label: 'Cut-Out Below Counter Depth', aliases: ['cutoutbelowcounterdepth'], type: 'number', target: { dim: ['cut_out_dimensions_in', 'depth'] } },
  { key: 'cutout_width', label: 'Cut-Out Front to Back', aliases: ['cutoutfronttoback'], type: 'number', target: { dim: ['cut_out_dimensions_in', 'width'] } },
  { key: 'cutout_length', label: 'Cut-Out Left to Right', aliases: ['cutoutlefttoright'], type: 'number', target: { dim: ['cut_out_dimensions_in', 'length'] } },

  // ---------- Marketing content ----------
  { key: 'general_title_en', label: 'General Title (EN)', aliases: ['generaltitleen'], type: 'text', target: { attr: 'general_title_en' } },
  { key: 'description_en', label: 'Description (EN)', aliases: ['descriptionennomorethan1000characters', 'descriptionen'], type: 'description', target: { col: 'description' } },
  { key: 'general_title_fr', label: 'General Title (FR)', aliases: ['generaltitlefr'], type: 'text', target: { attr: 'general_title_fr' } },
  { key: 'description_fr', label: 'Description (FR)', aliases: ['descriptionfr'], type: 'text', target: { attr: 'description_fr' } },
];

// Bullets are matched by pattern, not by alias list: "Bullet/Feature 3 (EN)"
// → normalized "bulletfeature3en".
export const BULLET_RE = /^bulletfeature(\d{1,2})(en|fr)$/;

// Canonical value maps applied on import (keyed by field def key, then by
// lowercased incoming value). `null` means "treat as empty / drop the value".
// Keeps spreadsheet inconsistencies from re-polluting the normalized catalog.
export const VALUE_CANONICALS = {
  material: {
    'stainless steel': 'Stainless Steel',
    't-304 stainless steel': 'Stainless Steel',
    'brushed stainless steel': 'Stainless Steel',
  },
  finish: {
    'brushed stainless steel': 'Brushed Stainless Steel',
    'brushed': 'Brushed Stainless Steel',
    'gray': 'Grey',
  },
  gauge: {
    'no': null,
  },
  basin_split: {
    'does not apply': null,
  },
  drain_hole_location: {
    'side drain/ reversible': 'Side Drain / Reversible',
    'side drain/reversible': 'Side Drain / Reversible',
    'center drain/ reversible': 'Center Drain / Reversible',
    'center drain/reversible': 'Center Drain / Reversible',
  },
};

// Exact headers for the downloadable blank template, in the user's order.
export const TEMPLATE_HEADERS = [
  'Model Number', 'Model Name', 'Brand', 'Category', 'Sinks Series',
  'Sink Shape', 'Strainer Model', 'Number of Bowls', 'Bowl Configuration',
  'Basin Split', 'Low Divider', 'Gauge', 'Material', 'Finish / Color',
  'Installation Options', 'Product Type', 'Sink Radius',
  'External Lenght', 'External Width', 'External Depth', 'External Minimum Cabinet Size',
  'Internal Lenght', 'Internal Width', 'Internal Depth', 'Internal Minimum Cabinet Size',
  'Maximum Deck Thickness', 'Does it have Grooves?', 'Include grids?',
  'Accessories included', 'Number of pieces Included', 'Drain Hole location',
  'Drain Diameter', 'Product Weight lb', 'Country of Origen', 'SCC Compliant',
  'Safety Listing(s)', 'UPC Certified', 'Vermont Act 193 Compliant', 'HS CODE',
  'Master UPC', 'Shipping Weight Lbs', 'Shipping Height (in)', 'Shipping Width (in)',
  'Shipping Length (in)', 'Cut-Out Below Counter Depth', 'Cut-Out Front to Back',
  'Cut-Out Left to Right', 'General Title (EN)',
  'Description (EN) (No more than 1000 characters)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (EN)`),
  'General Title (FR)', 'Description (FR)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (FR)`),
];

// Build a lookup: normalized header alias → field def
export const ALIAS_LOOKUP = (() => {
  const map = new Map();
  for (const def of FIELD_DEFS) {
    for (const a of def.aliases) map.set(a, def);
  }
  return map;
})();
