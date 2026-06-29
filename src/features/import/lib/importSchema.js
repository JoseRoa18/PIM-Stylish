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
  // Bathroom-faucet sheets have no "Model Name" column — the QuickBooks
  // Description doubles as the product name.
  { key: 'model_name', label: 'Model Name', aliases: ['modelname', 'quickbooksdescription'], type: 'text', target: { col: 'model_name' } },
  // NOTE: "Family #" from spreadsheets is intentionally ignored — variant
  // families are derived automatically from the SKU base model (S-300XG → S-300).
  { key: 'brand', label: 'Brand', aliases: ['brand'], type: 'text', target: { col: 'brand' }, required: true },
  { key: 'category', label: 'Category', aliases: ['category'], type: 'category', target: { col: 'category' }, required: true },
  { key: 'msrp_cad', label: 'MSRP CAD$', aliases: ['msrpcad', 'msrp', 'msrpcad$'], type: 'number', target: { col: 'msrp_cad' } },
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
  { key: 'product_weight_lb', label: 'Product Weight lb', aliases: ['productweightlb', 'overallproductweight'], type: 'number', target: { attr: 'product_weight_lb' } },

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

  // ---------- Faucet configuration ----------
  // Faucet sheets reuse identity / material / finish / UPC / shipping /
  // marketing fields above; these cover the faucet-specific attributes.
  { key: 'lead_free', label: 'Lead Free', aliases: ['leadfree'], type: 'bool', target: { attr: 'lead_free' } },
  { key: 'craftsmanship', label: 'Craftsmanship Type', aliases: ['craftsmanshiptype', 'craftsmanship'], type: 'text', target: { attr: 'craftsmanship' } },
  { key: 'durability', label: 'Durability', aliases: ['durability'], type: 'list', target: { attr: 'durability_tags' } },
  { key: 'warranty', label: 'Full or Limited Warranty', aliases: ['fullorlimitedwarranty', 'warranty'], type: 'text', target: { attr: 'warranty' } },
  { key: 'num_install_holes', label: 'Number of Installation Holes', aliases: ['numberofinstallationholes', 'numberofmountingholes'], type: 'int', target: { attr: 'number_of_installation_holes' } },
  { key: 'spout_type', label: 'Spout Type', aliases: ['spouttype'], type: 'text', target: { attr: 'spout_type' } },
  { key: 'swivel_spout', label: 'Swivel Spout', aliases: ['swivelspout'], type: 'text', target: { attr: 'swivel_spout' } },
  { key: 'max_flow_rate', label: 'Maximum Flow Rate', aliases: ['maximumflowrate'], type: 'text', target: { attr: 'max_flow_rate' } },
  { key: 'hot_cold_dispenser', label: 'Instant Hot and Cold Water Dispenser', aliases: ['instanthotandcoldwaterdispenser'], type: 'bool', target: { attr: 'hot_cold_dispenser' } },
  { key: 'spray_included', label: 'Spray Included', aliases: ['sprayincluded'], type: 'bool', target: { attr: 'spray_included' } },
  { key: 'spray_type', label: 'Spray Type', aliases: ['spraytype'], type: 'text', target: { attr: 'spray_type' } },
  { key: 'spray_function_activation', label: 'Spray Function Activation', aliases: ['sprayfunctionactivation'], type: 'text', target: { attr: 'spray_function_activation' } },
  { key: 'spray_head_functions', label: 'Spray Head Functions', aliases: ['sprayheadfunctions'], type: 'text', target: { attr: 'spray_head_functions' } },
  { key: 'pull_down_hose_model', label: 'Pull down hose model', aliases: ['pulldownhosemodel'], type: 'text', target: { attr: 'pull_down_hose_model' } },
  { key: 'cartridge_size', label: 'Cartridge size', aliases: ['cartridgesize'], type: 'text', target: { attr: 'cartridge_size' } },
  { key: 'cartridge_type', label: 'Cartridge Type', aliases: ['cartridgetype'], type: 'text', target: { attr: 'cartridge_type' } },
  { key: 'cold_start_handle', label: 'Cold start handle?', aliases: ['coldstarthandle'], type: 'bool', target: { attr: 'cold_start_handle' } },
  { key: 'handles_included', label: 'Handle(s) Included', aliases: ['handlesincluded', 'handleincluded'], type: 'bool', target: { attr: 'handles_included' } },
  { key: 'number_of_handles', label: 'Number of Handles', aliases: ['numberofhandles'], type: 'int', target: { attr: 'number_of_handles' } },
  { key: 'handle_style', label: 'Handle Style', aliases: ['handlestyle', 'handletype'], type: 'text', target: { attr: 'handle_style' } },
  { key: 'deck_plate_included', label: 'Deck Plate Included', aliases: ['deckplateincluded'], type: 'bool', target: { attr: 'deck_plate_included' } },
  { key: 'compatible_deck_plate', label: 'Compatible Deck Plate Part Number', aliases: ['compatibledeckplatepartnumber'], type: 'text', target: { attr: 'compatible_deck_plate' } },
  { key: 'supply_line_included', label: 'Supply Line Included', aliases: ['supplylineincluded'], type: 'bool', target: { attr: 'supply_line_included' } },
  { key: 'aerator_included', label: 'Aerator Included', aliases: ['aeratorincluded'], type: 'bool', target: { attr: 'aerator_included' } },
  { key: 'hose_included', label: 'Hose Included', aliases: ['hoseincluded'], type: 'bool', target: { attr: 'hose_included' } },
  { key: 'application', label: 'Application', aliases: ['application', 'supplierintendedandapproveduse'], type: 'text', target: { attr: 'application' } },
  { key: 'handle_style_lock', label: 'Lock Type', aliases: ['locktype'], type: 'text', target: { attr: 'lock_type' } },
  { key: 'connection_size', label: 'Connection Size', aliases: ['connectionsize'], type: 'text', target: { attr: 'connection_size' } },
  { key: 'mounting_type', label: 'Mounting / Installation Type', aliases: ['mountinginstallationtype'], type: 'text', target: { attr: 'mounting_type' } },
  { key: 'country_of_origin_details', label: 'Country of Origin - Additional Details', aliases: ['countryoforiginadditionaldetails'], type: 'text', target: { attr: 'country_of_origin_details' } },

  // ---------- Bathroom-faucet specific ----------
  { key: 'laminar_flow', label: 'Laminar Flow', aliases: ['laminarflow'], type: 'text', target: { attr: 'laminar_flow' } },
  { key: 'drain_overflow', label: 'Drain Overflow', aliases: ['drainoverflow'], type: 'text', target: { attr: 'drain_overflow' } },
  { key: 'valve_included', label: 'Valve Included', aliases: ['valveincluded'], type: 'bool', target: { attr: 'valve_included' } },
  { key: 'compatible_drain_assembly', label: 'Compatible Drain Assembly Part Number', aliases: ['compatibledrainassemblypartnumber'], type: 'text', target: { attr: 'compatible_drain_assembly' } },
  { key: 'handle_material', label: 'Handle Material', aliases: ['handlematerial'], type: 'text', target: { attr: 'handle_material' } },
  { key: 'faucet_centers', label: 'Faucet Centers', aliases: ['faucetcenters'], type: 'text', target: { attr: 'faucet_centers' } },

  // ---------- Faucet dimensions (inches unless noted) ----------
  { key: 'faucet_height', label: 'Faucet Height', aliases: ['faucetheightdecimals', 'faucetheight'], type: 'number', target: { attr: 'faucet_height_in' } },
  { key: 'spout_reach', label: 'Spout Reach', aliases: ['spoutreachdecimals', 'spoutreach', 'spoutreachin'], type: 'number', target: { attr: 'spout_reach_in' } },
  { key: 'spout_height', label: 'Spout Height', aliases: ['spoutheightdecimasl', 'spoutheightdecimals', 'spoutheight', 'spoutheightin'], type: 'number', target: { attr: 'spout_height_in' } },
  { key: 'install_hole_dia_mm', label: 'Installation Hole Diameter (mm)', aliases: ['installationholediametermm'], type: 'number', target: { attr: 'install_hole_diameter_mm' } },
  { key: 'install_hole_dia_in', label: 'Installation Hole Diameter (in)', aliases: ['installationholediameter', 'installationholediameterin', 'installationholediameterinch'], type: 'number', target: { attr: 'install_hole_diameter_in' } },

  // ---------- Faucet certifications & compliance ----------
  // Kept as text to preserve whatever the sheet holds (Yes/No, N/A, cert #s).
  { key: 'ada_compliant', label: 'ADA Compliant', aliases: ['adacompliant'], type: 'text', target: { attr: 'ada_compliant' } },
  { key: 'asse_1001', label: 'ASSE 1001 Certified', aliases: ['asse1001certified'], type: 'text', target: { attr: 'asse_1001_certified' } },
  { key: 'ista_1a', label: 'ISTA 1A Certified', aliases: ['ista1acertified'], type: 'text', target: { attr: 'ista_1a_certified' } },
  { key: 'ista_3a_6a', label: 'ISTA 3A or 6A Certified', aliases: ['ista3aor6acertified'], type: 'text', target: { attr: 'ista_3a_6a_certified' } },
  { key: 'title_20', label: 'Title 20 - California Code of Regulations', aliases: ['title20californiacodeofregulations', 'title20'], type: 'text', target: { attr: 'title_20_compliant' } },
  { key: 'uplr_compliant', label: 'UPLR Compliant', aliases: ['uniformpackagingandlabelingregulationsuplrcompliant', 'uplrcompliant'], type: 'text', target: { attr: 'uplr_compliant' } },
  { key: 'canada_restriction', label: 'Canada Product Restriction', aliases: ['canadaproductrestriction'], type: 'text', target: { attr: 'canada_product_restriction' } },
  { key: 'calgreen_compliant', label: 'CALGreen Compliant', aliases: ['calgreencompliant'], type: 'text', target: { attr: 'calgreen_compliant' } },
  { key: 'cupc_certified', label: 'cUPC Certified', aliases: ['cupccertified'], type: 'text', target: { attr: 'cupc_certified' } },
  { key: 'ul_1951', label: 'UL 1951 Listed', aliases: ['ul1951listed'], type: 'text', target: { attr: 'ul_1951_listed' } },
  { key: 'asme_csa', label: 'ASME A112.18.1/CSA B125.1 - 2018', aliases: ['asmea112181csab12512018', 'asmecsa'], type: 'text', target: { attr: 'asme_csa_certified' } },
  { key: 'title_24', label: 'Title 24 Compliant', aliases: ['title24compliant'], type: 'text', target: { attr: 'title_24_compliant' } },
  { key: 'energy_efficiency', label: 'Energy Efficiency Regulations Compliant', aliases: ['energyefficiencyregulationscompliant'], type: 'text', target: { attr: 'energy_efficiency_compliant' } },
  { key: 'ab_100', label: 'California AB-100 Compliant', aliases: ['californiaab100compliant'], type: 'text', target: { attr: 'ab_100_compliant' } },
  // Bathroom-faucet certifications (plumbing/material standards)
  { key: 'asme_19_2', label: 'ASME A112.19.2/CSA B45.1 Compliant', aliases: ['asmea112192csab451compliant'], type: 'text', target: { attr: 'asme_a112_19_2_compliant' } },
  { key: 'asme_19_3', label: 'ASME A112.19.3 Compliant', aliases: ['asmea112193compliant'], type: 'text', target: { attr: 'asme_a112_19_3_compliant' } },
  { key: 'asme_19_1', label: 'ASME A112.19.1/CSA B45.2 - 2018 Compliant', aliases: ['asmea112191csab4522018compliant'], type: 'text', target: { attr: 'asme_a112_19_1_compliant' } },
  { key: 'sdwa', label: 'SDWA Compliant', aliases: ['sdwacompliant'], type: 'text', target: { attr: 'sdwa_compliant' } },
  { key: 'reason_for_restriction', label: 'Reason for Restriction', aliases: ['reasonforrestriction'], type: 'text', target: { attr: 'reason_for_restriction' } },
  { key: 'warranty_length', label: 'Warranty Length', aliases: ['warrantylength'], type: 'text', target: { attr: 'warranty_length' } },

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

// Blank template headers for KITCHEN faucets, in the source-sheet order.
// (Family # is omitted — variant families are derived from the SKU.)
export const FAUCET_TEMPLATE_HEADERS = [
  'Model Number', 'Model Name', 'Brand', 'Category', 'Material', 'Durability',
  'Lead Free', 'Craftsmanship Type', 'Number of Installation Holes', 'Spout Type',
  'Swivel Spout', 'Maximum Flow Rate', 'Instant Hot and Cold Water Dispenser',
  'Spray Included', 'Spray Type', 'Spray Function Activation', 'Spray Head Functions',
  'Pull down hose model', 'Cartridge size', 'Cold start handle?', 'Handle(s) Included',
  'Number of Handles', 'Deck Plate Included', 'Compatible Deck Plate Part Number',
  'Supply Line Included', 'Aerator Included', 'Hose Included', 'Cartridge Type',
  'Country of Origin - Additional Details', 'Application', 'Handle Style', 'Finish',
  'Lock Type', 'ADA Compliant', 'ASSE 1001 Certified', 'ISTA 1A Certified',
  'ISTA 3A or 6A Certified', 'Title 20 - California Code of Regulations',
  'Uniform Packaging and Labeling Regulations (UPLR) Compliant',
  'Canada Product Restriction', 'CALGreen Compliant', 'cUPC Certified',
  'UL 1951 Listed', 'ASME A112.18.1/CSA B125.1 - 2018', 'Vermont Act 193 Compliant',
  'Title 24 Compliant', 'Energy Efficiency Regulations Compliant',
  'California AB-100 Compliant', 'Safety Listing(s)', 'Faucet Height (decimals)',
  'Spout Reach (Decimals)', 'Spout Height (Decimals)', 'Overall Product Weight',
  'Installation Hole Diameter (mm)', 'Installation Hole Diameter (in)',
  'Maximum Deck Thickness', 'Connection Size', 'Mounting / Installation Type',
  'Full or Limited Warranty', 'UPC', 'Shipping Weight Lbs', 'Shipping Height',
  'Shipping Width', 'Shipping Length',
  'General Title (EN)', 'Description (EN)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (EN)`),
  'General Title (FR)', 'Description (FR)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (FR)`),
];

// Blank template headers for BATHROOM faucets, in the source-sheet order.
// (Family # kept for fidelity but ignored on import; the duplicate
// "Mounting / Installation Type" column is collapsed to one.)
export const BATH_FAUCET_TEMPLATE_HEADERS = [
  'Model Number', 'Family #', 'Quickbooks Description', 'MSRP CAD$', 'Brand',
  'Category', 'Material', 'Durability', 'Craftsmanship Type', 'Maximum Flow Rate',
  'Laminar Flow', 'Handle(s) Included', 'Number of Handles', 'Deck Plate Included',
  'Compatible Deck Plate Part Number', 'Drain Overflow', 'Valve Included',
  'Aerator Included', 'Supply Line Included', 'Supplier Intended and Approved Use',
  'Country of Origin', 'Compatible Drain Assembly Part Number', 'Handle Material',
  'Handle Type', 'Finish', 'Spout Height (In)', 'Spout Reach (In)', 'Faucet Height',
  'Faucet Centers', 'Overall Product Weight', 'Number of Mounting Holes',
  'Mounting / Installation Type', 'Installation Hole Diameter INCH',
  'Maximum Deck Thickness', 'Connection Size',
  'ASME A112.19.2/CSA B45.1 Compliant', 'ASME A112.19.3 Compliant', 'SDWA Compliant',
  'ASME A112.19.1/CSA B45.2 - 2018 Compliant', 'ASSE 1001 Certified',
  'Title 20 - California Code of Regulations',
  'Uniform Packaging and Labeling Regulations (UPLR) Compliant',
  'Canada Product Restriction', 'Reason for Restriction', 'UL 1951 Listed',
  'ASME A112.18.1/CSA B125.1 - 2018', 'Vermont Act 193 Compliant', 'cUPC Certified',
  'Title 24 Compliant', 'California AB-100 Compliant', 'Safety Listing(s)',
  'Warranty Length', 'Full or Limited Warranty', 'UPC', 'Shipping Weight Lbs',
  'Shipping Height', 'Shipping Width', 'Shipping Length',
  'General Title (EN)', 'Description (EN)',
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
