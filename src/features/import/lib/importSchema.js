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
import { canonicalCountry, COUNTRY_NAMES } from '@/features/products/lib/countries';
import { BRANDS } from '@/features/products/lib/brands';
import {
  YES_NO_OPTIONS, YES_NO_DNA_OPTIONS, COMPLIANCE_OPTIONS, MANUFACTURER_OPTIONS, COLOR_OPTIONS, FINISH_TYPE_OPTIONS,
  WARRANTY_OPTIONS, WARRANTY_LENGTH_OPTIONS, CRAFTSMANSHIP_OPTIONS, SINK_SHAPE_OPTIONS, INSTALLATION_TYPE_OPTIONS,
  GAUGE_OPTIONS, BOWL_CONFIGURATION_OPTIONS, BASIN_SPLIT_OPTIONS, DRAIN_LOCATION_OPTIONS, FAUCET_SHAPE_OPTIONS,
  SPOUT_TYPE_OPTIONS, SPRAY_TYPE_OPTIONS, SPRAY_ACTIVATION_OPTIONS, SENSOR_ACTIVATION_OPTIONS, HANDLE_STYLE_OPTIONS,
  MAX_FLOW_RATE_OPTIONS, BOWL_COUNT_OPTIONS, HANDLE_COUNT_OPTIONS, HOLE_COUNT_OPTIONS, PIECE_COUNT_OPTIONS,
  DRAIN_HOLE_COUNT_OPTIONS, SPOUT_ROTATION_OPTIONS, SINK_RADIUS_OPTIONS,
} from '@/features/products/lib/fieldOptions';

export const normalizeHeader = (h) =>
  String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const CATEGORY_MAP = {
  'kitchen sink': 'kitchen_sink',
  'kitchen sinks': 'kitchen_sink',
  'bath sink': 'bathroom_sink',
  'bath sinks': 'bathroom_sink',
  'bathroom sink': 'bathroom_sink',
  'bathroom sinks': 'bathroom_sink',
  'kitchen faucet': 'kitchen_faucet',
  'kitchen faucets': 'kitchen_faucet',
  'kitchen faucet combo': 'kitchen_faucet_combo',
  'kitchen faucet combos': 'kitchen_faucet_combo',
  'cold water tap': 'cold_water_tap',
  'cold water taps': 'cold_water_tap',
  'bath faucet': 'bathroom_faucet',
  'bath faucets': 'bathroom_faucet',
  'bathroom faucet': 'bathroom_faucet',
  'bathroom faucets': 'bathroom_faucet',
  'pot filler': 'pot_filler',
  'pot fillers': 'pot_filler',
  'bar prep sink': 'bar_prep_sink',
  'bar/prep sink': 'bar_prep_sink',
  'bar sink': 'bar_prep_sink',
  'prep sink': 'bar_prep_sink',
  'laundry sink': 'laundry_sink',
  'laundry sinks': 'laundry_sink',
  'laundry tub': 'laundry_sink',
  'laundry tubs': 'laundry_sink',
  'utility sink': 'laundry_sink',
  'utility sinks': 'laundry_sink',
  'outdoor sink': 'outdoor_sink',
  'outdoor sinks': 'outdoor_sink',
  'ice chest': 'outdoor_sink',
  'ice chests': 'outdoor_sink',
  'outdoor sink and ice chest': 'outdoor_sink',
  'outdoor sink & ice chest': 'outdoor_sink',
  'outdoor sink / ice chest': 'outdoor_sink',
  'accessory': 'accessory',
  'accessories': 'accessory',
  'cutting board': 'accessory',
  'cutting boards': 'accessory',
  'soap dispenser': 'accessory',
  'soap dispensers': 'accessory',
  'pop-up drain': 'accessory',
  'pop-up drains': 'accessory',
  'pop up drain': 'accessory',
  'pop up drains': 'accessory',
  'drain': 'accessory',
  'drains': 'accessory',
  'strainer': 'accessory',
  'strainers': 'accessory',
  'basket strainer': 'accessory',
  'basket strainers': 'accessory',
  'faucet plate': 'accessory',
  'faucet plates': 'accessory',
  'deck plate': 'accessory',
  'deck plates': 'accessory',
  'sink grid': 'accessory',
  'sink grids': 'accessory',
  'grid': 'accessory',
  'grids': 'accessory',
  'colander': 'colander_drying_rack',
  'colanders': 'colander_drying_rack',
  'drying rack': 'colander_drying_rack',
  'drying racks': 'colander_drying_rack',
  'colander & drying rack': 'colander_drying_rack',
  'colanders & drying racks': 'colander_drying_rack',
  'colanders and drying racks': 'colander_drying_rack',
};

// Price columns, three levels each: Blue (base) / Orange (monthly promotion) /
// Purple (flash deal / special event). `col(suffix)` names the products column
// ("" for Blue, "_orange", "_purple"). Header "MAP CAD (Orange)"; the Blue one
// also answers to the bare name ("MAP CAD").
const PRICE_LEVELS = [['', 'Blue'], ['_orange', 'Orange'], ['_purple', 'Purple']];
const priceDefs = (name, col) => PRICE_LEVELS.map(([sfx, level]) => {
  const label = `${name} (${level})`;
  const column = col(sfx);
  return {
    key: column,
    label,
    aliases: [normalizeHeader(label), normalizeHeader(column), ...(sfx ? [] : [normalizeHeader(name)])],
    type: 'money',
    target: { col: column },
  };
});
const PRICE_DEFS = [
  // Canada, CAD
  ...priceDefs('MAP CAD', (s) => `map${s}_cad`),
  ...priceDefs('WC Rona / Home Depot CAD', (s) => `cost_cad_rona_hd${s}`),
  ...priceDefs('WC Small Online Dealers CAD', (s) => `cost_cad_wayfair_sod${s}`),
  // USA, USD
  { key: 'msrp_usd', label: 'MSRP USD$', aliases: ['msrpusd'], type: 'money', target: { col: 'msrp_usd' } },
  ...priceDefs('MAP USD', (s) => `map${s}_usd`),
  ...priceDefs("WC Lowe's / HD USA / SOD / BB&B USD", (s) => `cost_usd_lowes_sod_bbb${s}`),
  ...priceDefs('WC Wayfair USD', (s) => `cost_usd_wayfair${s}`),
  ...priceDefs('WC Menards USD', (s) => `cost_usd_menards${s}`),
  // Wayfair Canada, in USD (its supplier account is priced in US dollars)
  ...priceDefs('MAP Wayfair Canada USD', (s) => `map_usd_wayfair_ca${s}`),
  ...priceDefs('WC Wayfair Canada USD', (s) => `cost_usd_wayfair_ca${s}`),
];

export const FIELD_DEFS = [
  // ---------- Identification ----------
  { key: 'sku', label: 'SKU (Model Number)', aliases: ['modelnumber', 'sku', 'suppliersku', 'skumodelnumber'], type: 'text', target: { col: 'sku' }, required: true },
  { key: 'model_name', label: 'Model Name', aliases: ['modelname'], type: 'text', target: { col: 'model_name' } },
  // Bathroom-faucet sheets have no "Model Name" column — buildImportRows falls
  // back to the QuickBooks Description as the product name when Model Name is empty.
  { key: 'quickbooks_description', label: 'Quickbooks Description', aliases: ['quickbooksdescription'], type: 'text', target: { col: 'quickbooks_description' } },
  // NOTE: "Family #" from spreadsheets is intentionally ignored — variant
  // families are derived automatically from the SKU base model (S-300XG → S-300).
  { key: 'brand', label: 'Brand', aliases: ['brand'], type: 'brand', target: { col: 'brand' }, required: true },
  { key: 'category', label: 'Category', aliases: ['category'], type: 'category', target: { col: 'category' }, required: true },
  { key: 'msrp_cad', label: 'MSRP CAD$', aliases: ['msrpcad', 'msrp', 'msrpcad$'], type: 'money', target: { col: 'msrp_cad' } },
  { key: 'launch_lead', label: 'Launch Lead', aliases: ['launchlead'], type: 'date', target: { col: 'launch_lead' } },
  { key: 'sample_available_date', label: 'When is sample available', aliases: ['whenissampleavailable', 'sampleavailable', 'whensampleavailable', 'sampleavailabledate'], type: 'date', target: { col: 'sample_available_date' } },
  { key: 'ready_to_sell_date', label: 'When will it be ready to sell?', aliases: ['whenwillitbereadytosell', 'readytosell', 'readytoselldate'], type: 'date', target: { col: 'ready_to_sell_date' } },
  { key: 'series', label: 'Series', aliases: ['sinksseries', 'sinkseries', 'series'], type: 'text', target: { col: 'series' } },
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
  { key: 'finish', label: 'Finish', aliases: ['finishcolor', 'colorfinish', 'finish'], type: 'text', target: { col: 'finish' } },
  // Dual-mount sinks list two options ("Undermount; Drop-In") → stored as array
  // Single value since 2026-07-31 (Undermount / Drop-In / Dual Mount / Top
  // Mount) — imports listing both undermount and drop-in mean Dual Mount.
  {
    key: 'installation_type',
    label: 'Installation Options',
    aliases: ['installationoptions', 'installationtype'],
    type: 'text',
    target: { attr: 'installation_type' },
    transform: (v) => {
      const parts = String(v ?? '').split(/[;,/]/).map((s) => s.trim()).filter(Boolean);
      if (parts.length > 1 || /dual/i.test(parts[0] ?? '')) return 'Dual Mount';
      if (/under/i.test(parts[0] ?? '')) return 'Undermount';
      if (/drop/i.test(parts[0] ?? '')) return 'Drop-In';
      if (/top/i.test(parts[0] ?? '')) return 'Top Mount';
      return parts[0] ?? '';
    },
  },
  { key: 'sink_radius_mm', label: 'Sink Radius', aliases: ['sinkradius', 'sinkradiusmm'], type: 'number', target: { attr: 'sink_radius_mm' } },

  // ---------- External / internal dimensions ----------
  { key: 'ext_length', label: 'External Length', aliases: ['externallenght', 'externallength', 'externalsinksizelengthinches', 'overallproductlengthendtoend', 'overalllengthendtoend', 'overalllengthtoptobottom'], type: 'number', target: { dim: ['external_dimensions_in', 'length'] } },
  { key: 'ext_width', label: 'External Width', aliases: ['externalwidth', 'externalsinksizewidthinches', 'overallproductwidthsidetoside', 'overallwidthfronttoback', 'overallwidthsidetoside'], type: 'number', target: { dim: ['external_dimensions_in', 'width'] } },
  { key: 'ext_depth', label: 'External Depth', aliases: ['externaldepth', 'externalsinksizedepthinches', 'overallproductthickness', 'overalldepthfronttoback'], type: 'number', target: { dim: ['external_dimensions_in', 'depth'] } },
  { key: 'ext_height', label: 'Overall Height - Top to Bottom', aliases: ['overallheighttoptobottom', 'overallproductheighttoptobottom'], type: 'number', target: { dim: ['external_dimensions_in', 'height'] } },
  { key: 'min_ext_cabinet', label: 'External Minimum Cabinet Size', aliases: ['externalminimumcabinetsize', 'minimunexternalcabinetsizeminimumcountertoplength'], type: 'number', target: { attr: 'min_external_cabinet_size_in' } },
  { key: 'int_length', label: 'Internal Length', aliases: ['internallenght', 'internallength', 'internalsinksizelengthinches'], type: 'number', target: { dim: ['internal_dimensions_in', 'length'] } },
  { key: 'int_width', label: 'Internal Width', aliases: ['internalwidth', 'internalsinksizewidthinches'], type: 'number', target: { dim: ['internal_dimensions_in', 'width'] } },
  { key: 'int_depth', label: 'Internal Depth', aliases: ['internaldepth', 'internalsinksizedepthinches'], type: 'number', target: { dim: ['internal_dimensions_in', 'depth'] } },
  { key: 'min_int_cabinet', label: 'Internal Minimum Cabinet Size', aliases: ['internalminimumcabinetsize', 'minimuminternalcabinetsize'], type: 'number', target: { attr: 'min_internal_cabinet_size_in' } },
  { key: 'max_deck', label: 'Maximum Deck Thickness', aliases: ['maximumdeckthickness'], type: 'number', target: { attr: 'max_deck_thickness_in' } },

  // ---------- Features ----------
  { key: 'has_grooves', label: 'Does it have Grooves?', aliases: ['doesithavegrooves'], type: 'bool', target: { attr: 'has_grooves' } },
  { key: 'includes_grids', label: 'Include grids?', aliases: ['includegrids', 'includesgrids'], type: 'bool', target: { attr: 'includes_grids' } },
  { key: 'accessories_included', label: 'Accessories included', aliases: ['accessoriesincluded'], type: 'list', target: { attr: 'accessories_included' } },
  { key: 'number_of_pieces', label: 'Number of pieces Included', aliases: ['numberofpiecesincluded', 'totalnumberofpiecesincluded'], type: 'int', target: { attr: 'number_of_pieces' } },
  { key: 'drain_hole_location', label: 'Drain Hole location', aliases: ['drainholelocation', 'drainholelocationplacement', 'drainplacement'], type: 'text', target: { attr: 'drain_hole_location' } },
  { key: 'drain_diameter_in', label: 'Drain Diameter', aliases: ['draindiameter', 'drainholediameter'], type: 'number', target: { attr: 'drain_diameter_in' } },
  { key: 'product_weight_lb', label: 'Product Weight (lb)', aliases: ['productweightlb', 'overallproductweight'], type: 'number', target: { attr: 'product_weight_lb' } },

  // ---------- Trade & compliance ----------
  // "CN", "Viet Nam", "CHN" → the dropdown's name ("China", "Vietnam"); a value
  // it doesn't know is kept as written.
  { key: 'country_of_origin', label: 'Country of Origin', aliases: ['countryoforigen', 'countryoforigin'], type: 'text', target: { attr: 'country_of_origin' }, transform: (v) => canonicalCountry(v) ?? v },
  { key: 'scc_compliant', label: 'SCC Compliant', aliases: ['scccompliant'], type: 'text', target: { attr: 'scc_compliant' } },
  { key: 'safety_listings', label: 'Safety Listing(s)', aliases: ['safetylistings', 'safetylisting'], type: 'text', target: { attr: 'safety_listings' } },
  { key: 'upc_certified', label: 'UPC Certified', aliases: ['upccertified'], type: 'text', target: { attr: 'upc_certified' } },
  { key: 'vermont_compliant', label: 'Vermont Act 193 Compliant', aliases: ['vermontact193compliant'], type: 'text', target: { attr: 'vermont_act_193_compliant' } },
  { key: 'hs_code', label: 'HS Code (USA)', aliases: ['hscode', 'hscodeusa', 'hscodeus', 'usahscode'], type: 'text', target: { attr: 'hs_code' } },
  // Canada has its own tariff code (user, 2026-10-15); "HS CODE" alone stays the USA one.
  { key: 'hs_code_ca', label: 'HS Code (Canada)', aliases: ['hscodecanada', 'hscodeca', 'hscodecan', 'canadahscode', 'cahscode'], type: 'text', target: { attr: 'hs_code_ca' } },
  { key: 'upc', label: 'UPC', aliases: ['masterupc', 'upc'], type: 'upc', target: { attr: 'upc' } },

  // ---------- Shipping ----------
  { key: 'shipping_weight_lb', label: 'Shipping Weight (lb)', aliases: ['shippingweightlbs', 'shippingweightlb', 'shippingweight'], type: 'number', target: { col: 'shipping_weight_lb' } },
  { key: 'ship_height', label: 'Shipping Height (in)', aliases: ['shippingheightin', 'shippingheight'], type: 'number', target: { dim: ['shipping_dimensions_in', 'height'] } },
  { key: 'ship_width', label: 'Shipping Width (in)', aliases: ['shippingwidthin', 'shippingwidth'], type: 'number', target: { dim: ['shipping_dimensions_in', 'width'] } },
  { key: 'ship_length', label: 'Shipping Length (in)', aliases: ['shippinglengthin', 'shippinglength'], type: 'number', target: { dim: ['shipping_dimensions_in', 'length'] } },
  // Master carton — pallet shipments only (user, 2026-10-15)
  { key: 'master_carton_quantity', label: 'Quantity / Master Carton', aliases: ['quantitymastercarton', 'mastercartonquantity', 'mastercartonqty', 'unitspermastercarton'], type: 'number', target: { attr: 'master_carton_quantity' } },
  { key: 'master_carton_length', label: 'Master Carton Length (in)', aliases: ['mastercartonlengthin', 'mastercartonlength'], type: 'number', target: { dim: ['master_carton_dimensions_in', 'length'] } },
  { key: 'master_carton_width', label: 'Master Carton Width (in)', aliases: ['mastercartonwidthin', 'mastercartonwidth'], type: 'number', target: { dim: ['master_carton_dimensions_in', 'width'] } },
  { key: 'master_carton_height', label: 'Master Carton Height (in)', aliases: ['mastercartonheightin', 'mastercartonheight'], type: 'number', target: { dim: ['master_carton_dimensions_in', 'height'] } },
  { key: 'master_carton_weight_lb', label: 'Master Carton Weight (lb)', aliases: ['mastercartonweightlbs', 'mastercartonweightlb', 'mastercartonweight'], type: 'number', target: { attr: 'master_carton_weight_lb' } },

  // ---------- Cut-out ----------
  { key: 'cutout_depth', label: 'Cut-Out Below Counter Depth', aliases: ['cutoutbelowcounterdepth'], type: 'number', target: { dim: ['cut_out_dimensions_in', 'depth'] } },
  { key: 'cutout_width', label: 'Cut-Out Front to Back', aliases: ['cutoutfronttoback'], type: 'number', target: { dim: ['cut_out_dimensions_in', 'width'] } },
  { key: 'cutout_length', label: 'Cut-Out Left to Right', aliases: ['cutoutlefttoright'], type: 'number', target: { dim: ['cut_out_dimensions_in', 'length'] } },

  // ---------- Faucet configuration ----------
  // Faucet sheets reuse identity / material / finish / UPC / shipping /
  // marketing fields above; these cover the faucet-specific attributes.
  { key: 'lead_free', label: 'Lead Free', aliases: ['leadfree'], type: 'bool', target: { attr: 'lead_free' } },
  { key: 'craftsmanship', label: 'Craftsmanship Type', aliases: ['craftsmanshiptype', 'craftsmanship', 'craftsmanshiptypemanufacturingmethod'], type: 'text', target: { attr: 'craftsmanship' } },
  { key: 'durability', label: 'Durability', aliases: ['durability'], type: 'list', target: { attr: 'durability_tags' } },
  { key: 'warranty', label: 'Full or Limited Warranty', aliases: ['fullorlimitedwarranty', 'warranty'], type: 'text', target: { attr: 'warranty' } },
  { key: 'num_install_holes', label: 'Number of Installation Holes', aliases: ['numberofinstallationholes', 'numberofmountingholes'], type: 'int', target: { attr: 'number_of_installation_holes' } },
  { key: 'spout_type', label: 'Spout Type', aliases: ['spouttype'], type: 'text', target: { attr: 'spout_type' } },
  { key: 'swivel_spout', label: 'Swivel Spout', aliases: ['swivelspout'], type: 'text', target: { attr: 'swivel_spout' } },
  // the number only: the field is in GPM ("1.8 GPM" → "1.8")
  { key: 'max_flow_rate', label: 'Maximum Flow Rate', aliases: ['maximumflowrate'], type: 'text', target: { attr: 'max_flow_rate' }, transform: (v) => String(v).replace(/\s*gpm\s*$/i, '').trim() },
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

  // ---------- Bathroom-sink specific ----------
  { key: 'compatible_faucet_type', label: 'Compatible Faucet Type', aliases: ['compatiblefaucettype'], type: 'text', target: { attr: 'compatible_faucet_type' } },
  { key: 'faucet_hole_center_spacing', label: 'Faucet Hole Center Spacing', aliases: ['faucetholecenterspacing'], type: 'text', target: { attr: 'faucet_hole_center_spacing' } },
  { key: 'number_of_faucet_holes', label: 'Number of Faucet Holes', aliases: ['numberoffaucetholes'], type: 'int', target: { attr: 'number_of_faucet_holes' } },
  { key: 'overflow', label: 'Overflow', aliases: ['overflow'], type: 'text', target: { attr: 'overflow' } },
  { key: 'pedestal_included', label: 'Pedestal Included', aliases: ['pedestalincluded'], type: 'bool', target: { attr: 'pedestal_included' } },
  { key: 'compatible_pedestal', label: 'Compatible Pedestal Part Number', aliases: ['compatiblepedestalpartnumber'], type: 'text', target: { attr: 'compatible_pedestal' } },
  { key: 'console_included', label: 'Console Included', aliases: ['consoleincluded'], type: 'bool', target: { attr: 'console_included' } },
  { key: 'nsf_ansi_61', label: 'NSF/ANSI 61 Certified', aliases: ['nsfansi61certified'], type: 'text', target: { attr: 'nsf_ansi_61_certified' } },
  { key: 'nsf_certified', label: 'NSF Certified', aliases: ['nsfcertified'], type: 'text', target: { attr: 'nsf_certified' } },
  { key: 'csa_b45_5', label: 'CSA B45.5/IAPMO Z124 Compliant', aliases: ['csab455iapmoz124compliantplasticplumbingfixtures', 'csab455iapmoz124compliant'], type: 'text', target: { attr: 'csa_b45_5_iapmo_z124_compliant' } },

  // ---------- Kitchen-sink certifications ----------
  // The rest of the kitchen-sink cert columns reuse the definitions above
  // (cUPC, ADA, ISTA, UPLR, ASME 19.1/19.2/19.3, NSF, ISO 14021, WaterSense,
  // EPD, AB-100, …); only these had no home yet.
  { key: 'ansi_z124_6_97', label: 'ANSI Z124.6-97 Compliant', aliases: ['ansiz124697compliant'], type: 'text', target: { attr: 'ansi_z124_6_97_compliant' } },
  { key: 'asme_19_4', label: 'ASME A112.19.4 Compliant', aliases: ['asmea112194compliant'], type: 'text', target: { attr: 'asme_a112_19_4_compliant' } },
  { key: 'ww_p_541', label: 'WW-P-541 Certified', aliases: ['wwp541certified'], type: 'text', target: { attr: 'ww_p_541_certified' } },
  // GREENGUARD and Cradle to Cradle each ship as three separate template
  // columns (umbrella / base cert / specific cert), so they stay three fields.
  { key: 'greenguard_certified', label: 'GREENGUARD Certified', aliases: ['greenguardcertified'], type: 'text', target: { attr: 'greenguard_certified' } },
  { key: 'greenguard_gold', label: 'GREENGUARD Gold Certified', aliases: ['greenguardgoldcertified'], type: 'text', target: { attr: 'greenguard_gold_certified' } },
  { key: 'cradle_certified', label: 'Cradle to Cradle Certified', aliases: ['cradletocradlecertified'], type: 'text', target: { attr: 'cradle_to_cradle_certified' } },
  { key: 'cradle_material_health', label: 'Cradle to Cradle Material Health Certificate', aliases: ['cradletocradlematerialhealthcertificate'], type: 'text', target: { attr: 'cradle_to_cradle_material_health' } },

  // ---------- Accessory (cutting board) specific ----------
  { key: 'wood_species', label: 'Wood Species', aliases: ['woodspecies'], type: 'text', target: { attr: 'wood_species' } },
  { key: 'juice_grooves', label: 'Carving Board Juice Grooves', aliases: ['carvingboardjuicegrooves', 'juicegrooves'], type: 'bool', target: { attr: 'juice_grooves' } },
  { key: 'bpa_free', label: 'BPA Free', aliases: ['bpafree'], type: 'bool', target: { attr: 'bpa_free' } },
  // "Care instructions" on the kitchen-sink sheet is the same field under a
  // different name — one place to fill it in, not two.
  { key: 'product_care', label: 'Product Care', aliases: ['productcare', 'careinstructions'], type: 'text', target: { attr: 'product_care' } },
  { key: 'pattern', label: 'Pattern', aliases: ['pattern'], type: 'text', target: { attr: 'pattern' } },
  { key: 'flexible_board', label: 'Flexible Cutting Board', aliases: ['flexiblecuttingboard'], type: 'bool', target: { attr: 'flexible_cutting_board' } },
  { key: 'reversible', label: 'Reversible', aliases: ['reversible'], type: 'bool', target: { attr: 'reversible' } },
  { key: 'overall_shape', label: 'Overall Shape', aliases: ['overallshape'], type: 'text', target: { attr: 'overall_shape' } },
  { key: 'over_the_sink', label: 'Over The Sink', aliases: ['overthesink'], type: 'bool', target: { attr: 'over_the_sink' } },
  { key: 'knife_included', label: 'Knife Included', aliases: ['knifeincluded'], type: 'bool', target: { attr: 'knife_included' } },
  { key: 'antimicrobial', label: 'Antimicrobial', aliases: ['antimicrobial'], type: 'text', target: { attr: 'antimicrobial' } },
  { key: 'usda_compliant', label: 'USDA Compliant', aliases: ['usdacompliant'], type: 'text', target: { attr: 'usda_compliant' } },
  { key: 'taa_compliant', label: 'TAA Compliant', aliases: ['taacompliant'], type: 'text', target: { attr: 'taa_compliant' } },
  { key: 'iso_14021', label: 'ISO 14021 Recycled Content Standard Certified', aliases: ['iso14021recycledcontentstandardcertified'], type: 'text', target: { attr: 'iso_14021_certified' } },
  { key: 'pefc_certified', label: 'PEFC Certified', aliases: ['pefccertified'], type: 'text', target: { attr: 'pefc_certified' } },
  { key: 'safety_listing_reg', label: 'Safety Listing(s) Registration Number', aliases: ['safetylistingsregistrationnumber', 'safetylistingregistrationnumber'], type: 'text', target: { attr: 'safety_listing_registration_number' } },
  { key: 'ista_certified', label: 'ISTA Certified', aliases: ['istacertified'], type: 'text', target: { attr: 'ista_certified' } },
  { key: 'sfi_certifications', label: 'SFI Certifications', aliases: ['sficertifications', 'sficertified'], type: 'text', target: { attr: 'sfi_certifications' } },
  { key: 'fsc_certifications', label: 'FSC Certifications', aliases: ['fsccertifications', 'fsccertified'], type: 'text', target: { attr: 'fsc_certifications' } },
  { key: 'commercial_warranty', label: 'Commercial Warranty', aliases: ['commercialwarranty'], type: 'text', target: { attr: 'commercial_warranty' } },

  // ---------- Colanders & drying racks ----------
  { key: 'collapsible', label: 'Collapsible', aliases: ['collapsible'], type: 'bool', target: { attr: 'collapsible' } },
  { key: 'handheld', label: 'Handheld', aliases: ['handheld'], type: 'bool', target: { attr: 'handheld' } },
  // The Color column (2026-10-08) — what the product page shows and Walmart reads.
  { key: 'color', label: 'Color', aliases: ['color'], type: 'text', target: { col: 'color' } },
  { key: 'length_with_handles', label: 'Overall Length Including Handles - End to End', aliases: ['overalllengthincludinghandlesendtoend'], type: 'number', target: { attr: 'length_with_handles_in' } },

  // ---------- Accessory (soap dispenser / grid) specific ----------
  { key: 'alias', label: 'Alias', aliases: ['alias'], type: 'text', target: { attr: 'alias' } },
  { key: 'soap_dispenser_features', label: 'Soap Dispenser Features', aliases: ['soapdispenserfeatures'], type: 'list', target: { attr: 'soap_dispenser_features' } },
  { key: 'grid_hole_placement', label: 'Grid Hole Placement', aliases: ['gridholeplacement'], type: 'text', target: { attr: 'grid_hole_placement' } },
  { key: 'weight_capacity', label: 'Weight Capacity', aliases: ['weightcapacity'], type: 'text', target: { attr: 'weight_capacity' } },
  { key: 'installation_required', label: 'Installation Required', aliases: ['installationrequired'], type: 'bool', target: { attr: 'installation_required' } },
  { key: 'iapmo_certified', label: 'IAPMO Certified', aliases: ['iapmocertified'], type: 'text', target: { attr: 'iapmo_certified' } },
  { key: 'epa_watersense', label: 'EPA WaterSense Certified', aliases: ['epawatersensecertified'], type: 'text', target: { attr: 'epa_watersense_certified' } },
  { key: 'hazardous_material', label: 'Hazardous Material / Dangerous Goods', aliases: ['hazardousmaterialdangerousgoods', 'hazardousmaterial'], type: 'text', target: { attr: 'hazardous_material' } },

  // ---------- Accessory (pop-up drain) specific ----------
  { key: 'drain_shape', label: 'Drain Shape', aliases: ['drainshape'], type: 'text', target: { attr: 'drain_shape' } },
  { key: 'overflow_included', label: 'Overflow Included', aliases: ['overflowincluded'], type: 'bool', target: { attr: 'overflow_included' } },
  { key: 'trip_lever_included', label: 'Trip Lever Included', aliases: ['tripleverincluded'], type: 'bool', target: { attr: 'trip_lever_included' } },
  { key: 'garbage_disposal_compatible', label: 'Compatible with Garbage Disposal', aliases: ['compatiblewithgarbagedisposal'], type: 'bool', target: { attr: 'compatible_with_garbage_disposal' } },
  { key: 'drain_closure_type', label: 'Drain Closure Type', aliases: ['drainclosuretype'], type: 'text', target: { attr: 'drain_closure_type' } },
  { key: 'number_of_drain_holes', label: 'Number of Drain Holes', aliases: ['numberofdrainholes'], type: 'int', target: { attr: 'number_of_drain_holes' } },
  { key: 'compatible_fixture', label: 'Compatible Fixture', aliases: ['compatiblefixture'], type: 'text', target: { attr: 'compatible_fixture' } },
  { key: 'diameter_in', label: 'Diameter', aliases: ['diameter'], type: 'number', target: { attr: 'diameter_in' } },
  { key: 'drain_connection_diameter_in', label: 'Drain Connection Diameter', aliases: ['drainconnectiondiameter'], type: 'number', target: { attr: 'drain_connection_diameter_in' } },
  { key: 'max_compatible_drain_opening', label: 'Maximum Compatible Drain Opening', aliases: ['maximumcompatibledrainopening'], type: 'number', target: { attr: 'max_compatible_drain_opening_in' } },
  { key: 'assembly_required', label: 'Assembly Required', aliases: ['assemblyrequired'], type: 'bool', target: { attr: 'assembly_required' } },
  { key: 'commercial_warranty_length', label: 'Commercial Warranty Length', aliases: ['commercialwarrantylength'], type: 'text', target: { attr: 'commercial_warranty_length' } },
  { key: 'product_warranty', label: 'Product Warranty', aliases: ['productwarranty'], type: 'text', target: { attr: 'product_warranty' } },
  { key: 'warranty_details', label: 'Warranty Details', aliases: ['warrantydetails'], type: 'text', target: { attr: 'warranty_details' } },
  { key: 'epd_type_iii', label: 'Type III Product Specific Environmental Product Declaration (EPD)', aliases: ['typeiiiproductspecificenvironmentalproductdeclarationepd'], type: 'text', target: { attr: 'epd_type_iii' } },
  { key: 'cradle_to_cradle', label: 'Cradle to Cradle Certifications', aliases: ['cradletocradlecertifications'], type: 'text', target: { attr: 'cradle_to_cradle_certifications' } },

  // ---------- Accessory (faucet plate) specific ----------
  { key: 'asme_18_2', label: 'ASME A112.18.2 Compliant', aliases: ['asmea112182compliant'], type: 'text', target: { attr: 'asme_a112_18_2_compliant' } },
  { key: 'asse_1016', label: 'ASSE 1016 Certified', aliases: ['asse1016certified'], type: 'text', target: { attr: 'asse_1016_certified' } },
  { key: 'ab_1953', label: 'California AB 1953 Compliant', aliases: ['californiaab1953compliant'], type: 'text', target: { attr: 'ab_1953_compliant' } },
  { key: 'wqa_gold_seal', label: 'WQA Gold Seal Certified', aliases: ['wqagoldsealcertified'], type: 'text', target: { attr: 'wqa_gold_seal_certified' } },
  // 'greenguardcertified' used to land here; it now has its own field below,
  // so a column named "GREENGUARD Certified" goes where its name says.
  { key: 'greenguard', label: 'GREENGUARD Certifications', aliases: ['greenguardcertifications'], type: 'text', target: { attr: 'greenguard_certifications' } },

  // ---------- Retailer listing IDs ----------
  { key: 'bbb_ca_upc', label: 'BB&B.ca UPC (Alias related)', aliases: ['bbbcaupcaliasrelated', 'bbbcaupc'], type: 'text', target: { attr: 'bbb_ca_upc' } },
  { key: 'asin', label: 'ASIN', aliases: ['asin'], type: 'text', target: { attr: 'asin' } },
  { key: 'amazon_fnsku', label: 'Amazon Barcode FNSKU', aliases: ['amazonbarcodefnsku', 'fnsku'], type: 'text', target: { attr: 'amazon_fnsku' } },
  { key: 'homedepot_ca_sku', label: 'Home Depot.ca SKU', aliases: ['homedepotcasku'], type: 'text', target: { attr: 'homedepot_ca_sku' } },
  { key: 'bbb_ca_sku', label: 'BB&B.ca SKU', aliases: ['bbbcasku'], type: 'text', target: { attr: 'bbb_ca_sku' } },
  { key: 'rona_ca_sku', label: 'Rona.ca SKU', aliases: ['ronacasku'], type: 'text', target: { attr: 'rona_ca_sku' } },
  { key: 'bestbuy_ca_sku', label: 'Best Buy.ca SKU', aliases: ['bestbuycasku'], type: 'text', target: { attr: 'bestbuy_ca_sku' } },
  { key: 'bbb_com_sku', label: 'BB&B.com SKU', aliases: ['bbbcomsku'], type: 'text', target: { attr: 'bbb_com_sku' } },
  { key: 'lowes_sku', label: "Lowe's SKU", aliases: ['lowessku'], type: 'text', target: { attr: 'lowes_sku' } },
  { key: 'wayfair_sku', label: 'Wayfair SKU', aliases: ['wayfairsku'], type: 'text', target: { attr: 'wayfair_sku' } },

  // ---------- PIM fields no vendor sheet carries (user, 2026-10-15) ----------
  // So the PIM's own Excel holds everything the product page edits.
  { key: 'manufacturer', label: 'Manufacturer', aliases: ['manufacturer'], type: 'text', target: { attr: 'manufacturer' } },
  { key: 'finish_type', label: 'Finish Type', aliases: ['finishtype'], type: 'text', target: { attr: 'finish_type' } },
  { key: 'warranty_url_us', label: 'Warranty URL (USA)', aliases: ['warrantyurlusa', 'warrantyurlus'], type: 'text', target: { attr: 'warranty_url_us' } },
  { key: 'warranty_url_ca', label: 'Warranty URL (Canada)', aliases: ['warrantyurlcanada', 'warrantyurlca'], type: 'text', target: { attr: 'warranty_url_ca' } },
  { key: 'warranty_text_us', label: 'Warranty Text (USA)', aliases: ['warrantytextusa', 'warrantytextus'], type: 'text', target: { attr: 'warranty_text_us' } },
  { key: 'warranty_text_ca', label: 'Warranty Text (Canada)', aliases: ['warrantytextcanada', 'warrantytextca'], type: 'text', target: { attr: 'warranty_text_ca' } },
  { key: 'left_bowl_depth_in', label: 'Left Bowl Depth (in)', aliases: ['leftbowldepthin', 'leftbowldepth'], type: 'number', target: { attr: 'left_bowl_depth_in' } },
  { key: 'right_bowl_depth_in', label: 'Right Bowl Depth (in)', aliases: ['rightbowldepthin', 'rightbowldepth'], type: 'number', target: { attr: 'right_bowl_depth_in' } },
  { key: 'grids_model_code', label: 'Grids Model Code', aliases: ['gridsmodelcode', 'gridmodelcode'], type: 'text', target: { attr: 'grids_model_code' } },
  { key: 'spout_rotation_degrees', label: 'Spout Rotation (degrees)', aliases: ['spoutrotationdegrees', 'spoutrotation'], type: 'number', target: { attr: 'spout_rotation_degrees' } },
  { key: 'sensor_activation', label: 'Sensor Activation', aliases: ['sensoractivation'], type: 'text', target: { attr: 'sensor_activation' } },

  // ---------- Prices and costs (user, 2026-10-15: the bulk upload changes them too) ----------
  // Blue / Orange / Purple per channel, as in the product page's Pricing tab.
  // An empty cell never clears a price; a filled one replaces it.
  ...PRICE_DEFS,

  // ---------- Marketing content ----------
  { key: 'general_title_en', label: 'General Title (EN)', aliases: ['generaltitleen'], type: 'text', target: { attr: 'general_title_en' } },
  { key: 'description_en', label: 'Description (EN)', aliases: ['descriptionennomorethan1000characters', 'descriptionen'], type: 'description', target: { col: 'description' } },
  { key: 'general_title_fr', label: 'General Title (FR)', aliases: ['generaltitlefr'], type: 'text', target: { attr: 'general_title_fr' } },
  // Search terms per language. Lists, so a sheet can hold them semicolon-separated.
  { key: 'keywords_en', label: 'Search Keywords (EN)', aliases: ['searchkeywordsen', 'keywordsen', 'searchtermsen', 'keywords'], type: 'list', target: { attr: 'keywords_en' } },
  { key: 'keywords_fr', label: 'Search Keywords (FR)', aliases: ['searchkeywordsfr', 'keywordsfr', 'searchtermsfr'], type: 'list', target: { attr: 'keywords_fr' } },
  { key: 'description_fr', label: 'Description (FR)', aliases: ['descriptionfr'], type: 'text', target: { attr: 'description_fr' } },
  { key: 'marketing_copy', label: 'Short Description - Marketing Copy', aliases: ['shortdescriptionmarketingcopy', 'marketingcopy', 'shortdescription'], type: 'text', target: { attr: 'marketing_copy' } },
  { key: 'product_url', label: 'Product URL', aliases: ['stylishproducturl', 'producturl', 'productpageurl'], type: 'text', target: { attr: 'product_url' } },
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
    // Colour spelling standard (2026-09-22): always "Gray", never "Grey".
    'grey': 'Gray',
    'dark grey': 'Dark Gray',
    'light grey': 'Light Gray',
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
  // The product page's dropdown has "Lifetime"; "Limited" lives in Warranty.
  warranty_length: {
    'limited lifetime': 'Lifetime',
  },
  mounting_type: {
    'undermount sinks': 'Undermount',
    'undermount': 'Undermount',
    'vessel sinks': 'Vessel',
    'vessel': 'Vessel',
    'drop-in': 'Drop-In',
    'drop in': 'Drop-In',
    'dropin': 'Drop-In',
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
  // Craftsmanship / durability / care, then the full certification block —
  // added 2026-08-06 to match what the other category sheets already carried.
  'Craftsmanship Type/ Manufacturing Method', 'Durability', 'Care instructions',
  'cUPC Certified', 'ASME A112.19.2/CSA B45.1 Compliant',
  'ANSI Z124.6-97 Compliant', 'ADA Compliant', 'ASME A112.19.4 Compliant',
  'WW-P-541 Certified', 'ISTA 3A or 6A Certified', 'ISTA 1A Certified',
  'Uniform Packaging and Labeling Regulations (UPLR) Compliant',
  'Canada Product Restriction', 'Reason for Restriction',
  'ASME A112.19.1/CSA B45.2 - 2018 Compliant', 'ASME A112.19.3 Compliant',
  'UL 1951 Listed', 'NSF Certified',
  'CSA B45.5/IAPMO Z124 Compliant - Plastic Plumbing Fixtures',
  'GREENGUARD Certifications', 'GREENGUARD Certified', 'GREENGUARD Gold Certified',
  'ISO 14021 Recycled Content Standard Certified', 'EPA WaterSense Certified',
  'Cradle to Cradle Certifications', 'Cradle to Cradle Certified',
  'Cradle to Cradle Material Health Certificate',
  'Type III Product Specific Environmental Product Declaration (EPD)',
  'Energy Efficiency Regulations Compliant', 'California AB-100 Compliant',
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
  'Model Number', 'Model Name', 'Family #', 'Quickbooks Description', 'MSRP CAD$',
  'Brand', 'Category', 'Material', 'Durability', 'Craftsmanship Type', 'Maximum Flow Rate',
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

// Blank template headers for BATHROOM sinks, in the source-sheet order.
// (Media / image / document columns are handled separately and omitted.)
export const BATH_SINK_TEMPLATE_HEADERS = [
  'Model Number', 'Model Name', 'Brand', 'Category', 'Color/Finish',
  'Craftsmanship Type', 'Durability', 'Compatible Faucet Type', 'Country of Origin',
  'Cut-Out Below Counter Depth', 'Cut-Out Front to Back', 'Cut-Out Left to Right',
  'Drain Hole Diameter', 'Drain Placement', 'Faucet Hole Center Spacing', 'Material',
  'Mounting / Installation Type', 'Number of Faucet Holes',
  'External Sink Size Length (inches)', 'External Sink Size Width (inches)',
  'External Sink Size Depth (inches)', 'Internal Sink Size Length (inches)',
  'Internal Sink Size Width (inches)', 'Internal Sink Size Depth (inches)',
  'Overflow', 'Sink Shape', 'Pedestal Included', 'Compatible Pedestal Part Number',
  'Console Included', 'Warranty Length', 'MSRP CAD$', 'BM Dealer Cost CAD$',
  'ASME A112.19.1/CSA B45.2 - 2018 Compliant', 'ASME A112.19.2/CSA B45.1 Compliant',
  'ASME A112.19.3 Compliant', 'ASSE 1001 Certified',
  'Uniform Packaging and Labeling Regulations (UPLR) Compliant',
  'Canada Product Restriction', 'Reason for Restriction', 'NSF/ANSI 61 Certified',
  'UL 1951 Listed', 'UPC Certified', 'Vermont Act 193 Compliant', 'NSF Certified',
  'cUPC Certified', 'CSA B45.5/IAPMO Z124 Compliant - Plastic Plumbing Fixtures',
  'California AB-100 Compliant', 'Safety Listing(s)', 'HS CODE', 'UPC',
  'Shipping Weight', 'Shipping Height', 'Shipping Width', 'Shipping Length',
  'General Title (EN)', 'Description (EN)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (EN)`),
  'General Title (FR)', 'Description (FR)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (FR)`),
];

// Blank template headers for COLANDERS & DRYING RACKS, in the source-sheet
// order. (Media / image / document columns are handled separately and omitted.)
export const COLANDER_TEMPLATE_HEADERS = [
  'Model Number', 'Alias', 'Model Name', 'Family #', 'Quickbooks Description',
  'Brand', 'Category', 'MSRP CAD$', 'BM Dealer Cost CAD$', 'Product Type',
  'Total Number of Pieces Included', 'Material', 'Collapsible', 'Handheld',
  'Supplier Intended and Approved Use', 'Country of Origin - Additional Details',
  'Color', 'Finish', 'USDA Compliant', 'TAA Compliant',
  'Uniform Packaging and Labeling Regulations (UPLR) Compliant',
  'Canada Product Restriction', 'NSF Certified',
  'ISO 14021 Recycled Content Standard Certified', 'Safety Listing(s)',
  'ISTA Certified',
  'Overall Length - Top to Bottom', 'Overall Width - Side to Side',
  'Overall Depth - Front to Back', 'Overall Product Weight',
  'Overall Length Including Handles - End to End',
  'Commercial Warranty', 'Warranty Length', 'Full or Limited Warranty',
  'Warranty Details', 'UPC',
  'Shipping Weight Lbs', 'Shipping Height', 'Shipping Width', 'Shipping Length',
  'General Title (EN)', 'Description (EN)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (EN)`),
  'General Title (FR)', 'Description (FR)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (FR)`),
  'Short Description - Marketing Copy', 'Stylish product URL',
];

// Blank template headers for CUTTING BOARDS (accessory), in the source-sheet
// order. (Media / image / document columns are handled separately and omitted.)
export const CUTTING_BOARD_TEMPLATE_HEADERS = [
  'Model Number', 'Model Name', 'Brand', 'Category', 'MSRP CAD$', 'BM Dealer Cost CAD$',
  'Product Type', 'Material', 'Wood Species', 'Carving Board Juice Grooves',
  'Handle(s) Included', 'BPA Free', 'Product Care', 'Pattern', 'Flexible Cutting Board',
  'Reversible', 'Overall Shape', 'Over The Sink', 'Knife Included',
  'Supplier Intended and Approved Use', 'Country of Origin - Additional Details',
  'Antimicrobial', 'Color / Finish', 'USDA Compliant', 'TAA Compliant',
  'Canada Product Restriction', 'Reason for Restriction', 'NSF Certified',
  'ISO 14021 Recycled Content Standard Certified', 'PEFC Certified',
  'Safety Listing(s)', 'Safety Listing(s) Registration Number', 'ISTA Certified',
  'SFI Certifications', 'FSC Certifications',
  'Overall Product Length - End to End', 'Overall Product Width - Side to Side',
  'Overall Product Thickness', 'Overall Product Weight',
  'Commercial Warranty', 'Warranty Length', 'Full or Limited Warranty', 'UPC',
  'Shipping Weight Lbs', 'Shipping Height', 'Shipping Width', 'Shipping Length',
  'General Title (EN)', 'Description (EN)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (EN)`),
  'General Title (FR)', 'Description (FR)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (FR)`),
];

// Blank template headers for ACCESSORIES (soap dispensers, grids, …), in the
// source-sheet order. (Family # kept for fidelity but ignored on import;
// media / image / document columns are handled separately and omitted.)
export const ACCESSORY_TEMPLATE_HEADERS = [
  'Model Number', 'Alias', 'Model Name', 'Family #', 'Brand', 'Category',
  'MSRP CAD$', 'BM Dealer Cost CAD$', 'Product Type', 'Material',
  'Soap Dispenser Features', 'Durability', 'Grid Hole Placement', 'Weight Capacity',
  'Country of Origin - Additional Details', 'Finish',
  'ASME A112.19.2/CSA B45.1 Compliant', 'ASME A112.19.3 Compliant',
  'Uniform Packaging and Labeling Regulations (UPLR) Compliant',
  'Canada Product Restriction', 'Reason for Restriction', 'cUPC Certified',
  'IAPMO Certified', 'UL 1951 Listed', 'UPC Certified', 'ADA Compliant',
  'ASME A112.18.1/CSA B125.1 - 2018', 'Vermont Act 193 Compliant',
  'ISO 14021 Recycled Content Standard Certified', 'EPA WaterSense Certified',
  'Hazardous Material / Dangerous Goods', 'Safety Listing(s)',
  'Safety Listing(s) Registration Number',
  'Overall Height - Top to Bottom', 'Overall Length - End to End',
  'Overall Width - Front to Back', 'Overall Product Weight',
  'Maximum Deck Thickness', 'Installation Required', 'Installation Type',
  'Warranty Length', 'Full or Limited Warranty', 'UPC', 'ASIN',
  'Amazon Barcode FNSKU', 'Home Depot.ca SKU', 'BB&B.ca SKU', 'Rona.ca SKU',
  'Best Buy.ca SKU', 'BB&B.com SKU', "Lowe's SKU", 'Wayfair SKU',
  'Shipping Weight Lbs', 'Shipping Height', 'Shipping Width', 'Shipping Length',
  'General Title (EN)', 'Description (EN)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (EN)`),
  'General Title (FR)', 'Description (FR)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (FR)`),
];

// Blank template headers for BASKET STRAINERS (accessory), in the source-sheet
// order — the accessories sheet v2: same as soap dispensers but with the
// Quickbooks Description column instead of Alias. (Family # kept for fidelity
// but ignored on import; media / document columns are handled separately.)
export const STRAINER_TEMPLATE_HEADERS = [
  'Model Number', 'Model Name', 'Family #', 'Quickbooks Description', 'Brand',
  'Category', 'MSRP CAD$', 'BM Dealer Cost CAD$', 'Product Type', 'Material',
  'Soap Dispenser Features', 'Durability', 'Grid Hole Placement', 'Weight Capacity',
  'Country of Origin - Additional Details', 'Finish',
  'ASME A112.19.2/CSA B45.1 Compliant', 'ASME A112.19.3 Compliant',
  'Uniform Packaging and Labeling Regulations (UPLR) Compliant',
  'Canada Product Restriction', 'Reason for Restriction', 'cUPC Certified',
  'IAPMO Certified', 'UL 1951 Listed', 'UPC Certified', 'ADA Compliant',
  'ASME A112.18.1/CSA B125.1 - 2018', 'Vermont Act 193 Compliant',
  'ISO 14021 Recycled Content Standard Certified', 'EPA WaterSense Certified',
  'Hazardous Material / Dangerous Goods', 'Safety Listing(s)',
  'Safety Listing(s) Registration Number',
  'Overall Height - Top to Bottom', 'Overall Length - End to End',
  'Overall Width - Front to Back', 'Overall Product Weight',
  'Maximum Deck Thickness', 'Installation Required', 'Installation Type',
  'Warranty Length', 'Full or Limited Warranty', 'UPC', 'ASIN',
  'Amazon Barcode FNSKU', 'Home Depot.ca SKU', 'BB&B.ca SKU', 'Rona.ca SKU',
  'Best Buy.ca SKU', 'BB&B.com SKU', "Lowe's SKU", 'Wayfair SKU',
  'Shipping Weight Lbs', 'Shipping Height', 'Shipping Width', 'Shipping Length',
  'General Title (EN)', 'Description (EN)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (EN)`),
  'General Title (FR)', 'Description (FR)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (FR)`),
];

// Blank template headers for POP-UP DRAINS (accessory), in the source-sheet
// order. (Family # kept for fidelity but ignored on import;
// media / image / document columns are handled separately and omitted.)
export const DRAIN_TEMPLATE_HEADERS = [
  'Model Number', 'Model Name', 'Family #', 'Quickbooks Description', 'Brand',
  'Category', 'Application', 'MSRP CAD$', 'BM Dealer Cost CAD$', 'Product Type',
  'Material', 'Drain Shape', 'Overflow Included', 'Trip Lever Included',
  'Lead Free', 'Durability', 'Compatible with Garbage Disposal',
  'Country of Origin - Additional Details', 'Supplier Intended and Approved Use',
  'Drain Closure Type', 'Number of Drain Holes', 'Finish', 'Compatible Fixture',
  'Uniform Packaging and Labeling Regulations (UPLR) Compliant',
  'Canada Product Restriction', 'Reason for Restriction', 'UL 1951 Listed',
  'IAPMO Certified', 'UPC Certified', 'Vermont Act 193 Compliant', 'cUPC Certified',
  'ISO 14021 Recycled Content Standard Certified',
  'Type III Product Specific Environmental Product Declaration (EPD)',
  'Energy Efficiency Regulations Compliant', 'Safety Listing(s)',
  'Safety Listing(s) Registration Number', 'Cradle to Cradle Certifications',
  'Overall Width - Side to Side', 'Overall Height - Top to Bottom', 'Diameter',
  'Drain Connection Diameter', 'Maximum Compatible Drain Opening',
  'Overall Product Weight', 'Installation Required', 'Assembly Required',
  'Commercial Warranty', 'Commercial Warranty Length', 'Product Warranty',
  'Warranty Length', 'Full or Limited Warranty', 'Warranty Details', 'UPC',
  'BB&B.ca UPC (Alias related)', 'ASIN', 'Amazon Barcode FNSKU',
  'Home Depot.ca SKU', 'BB&B.ca SKU', 'Rona.ca SKU', 'Best Buy.ca SKU',
  'BB&B.com SKU', "Lowe's SKU", 'Wayfair SKU',
  'Shipping Weight Lbs', 'Shipping Height', 'Shipping Width', 'Shipping Length',
  'General Title (EN)', 'Description (EN)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (EN)`),
  'General Title (FR)', 'Description (FR)',
  ...Array.from({ length: 12 }, (_, i) => `Bullet/Feature ${i + 1} (FR)`),
];

// Blank template headers for FAUCET PLATES (accessory), in the source-sheet
// order. This sheet carries only 7 bullet slots per language. (Family # kept
// for fidelity but ignored on import; media / document columns are handled
// separately and omitted.)
export const FAUCET_PLATE_TEMPLATE_HEADERS = [
  'Model Number', 'Model Name', 'Family #', 'Quickbooks Description', 'Brand',
  'Category', 'MSRP CAD$', 'BM Dealer Cost CAD$', 'Application', 'Product Type',
  'Material', 'Lead Free', 'Supplier Intended and Approved Use',
  'Country of Origin - Additional Details', 'Durability', 'Finish',
  'ASME A112.18.2 Compliant', 'ASSE 1001 Certified',
  'Uniform Packaging and Labeling Regulations (UPLR) Compliant',
  'ASSE 1016 Certified', 'Canada Product Restriction', 'Reason for Restriction',
  'California AB 1953 Compliant', 'cUPC Certified', 'IAPMO Certified',
  'NSF/ANSI 61 Certified', 'UPC Certified', 'UL 1951 Listed',
  'WQA Gold Seal Certified', 'ASME A112.18.1/CSA B125.1 - 2018',
  'Vermont Act 193 Compliant', 'ISO 14021 Recycled Content Standard Certified',
  'EPA WaterSense Certified', 'Safety Listing(s)', 'GREENGUARD Certifications',
  'Overall Height - Top to Bottom', 'Overall Width - Side to Side',
  'Overall Depth - Front to Back', 'Maximum Deck Thickness',
  'Overall Product Weight', 'Mounting / Installation Type', 'Installation Required',
  'Commercial Warranty Length', 'Product Warranty', 'Warranty Length',
  'Full or Limited Warranty', 'Warranty Details', 'UPC', 'ASIN',
  'Amazon Barcode FNSKU', 'Home Depot.ca SKU', 'BB&B.ca SKU', 'Rona.ca SKU',
  'Best Buy.ca SKU', 'BB&B.com SKU', "Lowe's SKU", 'Wayfair SKU',
  'Shipping Weight Lbs', 'Shipping Height', 'Shipping Width', 'Shipping Length',
  'General Title (EN)', 'Description (EN)',
  ...Array.from({ length: 7 }, (_, i) => `Bullet/Feature ${i + 1} (EN)`),
  'General Title (FR)', 'Description (FR)',
  ...Array.from({ length: 7 }, (_, i) => `Bullet/Feature ${i + 1} (FR)`),
];

// Build a lookup: normalized header alias → field def
export const ALIAS_LOOKUP = (() => {
  const map = new Map();
  for (const def of FIELD_DEFS) {
    for (const a of def.aliases) map.set(a, def);
  }
  // a column named exactly as its field's label ("Finish Type") imports too
  for (const def of FIELD_DEFS) {
    const label = normalizeHeader(def.label);
    if (!map.has(label)) map.set(label, def);
  }
  return map;
})();

// A header → its field def, by label or alias (first def wins). What the
// sectioned layout and the PIM export use to place and fill a column.
const DEF_BY_HEADER = (() => {
  const map = new Map();
  for (const def of FIELD_DEFS) {
    for (const key of [normalizeHeader(def.label), ...def.aliases]) if (!map.has(key)) map.set(key, def);
  }
  return map;
})();
export const defForHeader = (header) => DEF_BY_HEADER.get(normalizeHeader(header)) ?? null;

// How much a spreadsheet row looks like the import's header row: the number
// of cells that name a known field. Lets the parser skip the section band
// above the headers (and any title rows a sheet carries).
export function scoreImportHeader(cells) {
  let score = 0;
  for (const c of cells) {
    const n = normalizeHeader(c);
    if (n && (BULLET_RE.test(n) || ALIAS_LOOKUP.has(n))) score += 1;
  }
  return score;
}

// ---------- Sections (user, 2026-10-15: the PIM's Excel "seccionado") ----------
// The bulk-upload template and the PIM export group their columns under these
// bands, in this order; `color` is the band's fill (hex, no #).
export const SECTIONS = [
  { key: 'identity', title: 'Identity', color: '1F3864' },
  { key: 'status', title: 'Status & Dates', color: '595959' },
  { key: 'pricing_ca', title: 'Pricing — Canada (CAD)', color: '9C2A00' },
  { key: 'pricing_us', title: 'Pricing — USA (USD)', color: '1E5631' },
  { key: 'pricing_wfca', title: 'Pricing — Wayfair Canada (USD)', color: '6B4F00' },
  { key: 'physical', title: 'Physical Properties', color: '2E75B6' },
  { key: 'sink', title: 'Sink Configuration', color: '00695C' },
  { key: 'faucet', title: 'Faucet Configuration', color: '4527A0' },
  { key: 'accessory', title: 'Accessory Details', color: '8D6E00' },
  { key: 'dimensions', title: 'Dimensions & Weight', color: '0B5394' },
  { key: 'shipping', title: 'Shipping', color: '6A1B9A' },
  { key: 'carton', title: 'Master Carton — pallet shipments only', color: '880E4F' },
  { key: 'trade', title: 'Trade, Warranty & Compliance', color: '2E4A1E' },
  { key: 'certifications', title: 'Certifications', color: '37474F' },
  { key: 'content_en', title: 'Content — English', color: '0D47A1' },
  { key: 'content_fr', title: 'Content — French', color: '283593' },
  { key: 'retailer', title: 'Retailer IDs', color: '5D4037' },
  { key: 'other', title: 'Other', color: '757575' },
];
const SECTION_FIELDS = {
  identity: ['sku', 'brand', 'category', 'model_name', 'series', 'product_type', 'manufacturer', 'upc', 'quickbooks_description', 'alias'],
  status: ['launch_lead', 'sample_available_date', 'ready_to_sell_date'],
  pricing_ca: ['msrp_cad', 'map_cad', 'map_orange_cad', 'map_purple_cad', 'cost_cad_rona_hd', 'cost_cad_rona_hd_orange', 'cost_cad_rona_hd_purple', 'cost_cad_wayfair_sod', 'cost_cad_wayfair_sod_orange', 'cost_cad_wayfair_sod_purple'],
  pricing_us: ['msrp_usd', 'map_usd', 'map_orange_usd', 'map_purple_usd', 'cost_usd_lowes_sod_bbb', 'cost_usd_lowes_sod_bbb_orange', 'cost_usd_lowes_sod_bbb_purple',
    'cost_usd_wayfair', 'cost_usd_wayfair_orange', 'cost_usd_wayfair_purple', 'cost_usd_menards', 'cost_usd_menards_orange', 'cost_usd_menards_purple'],
  pricing_wfca: ['map_usd_wayfair_ca', 'map_usd_wayfair_ca_orange', 'map_usd_wayfair_ca_purple', 'cost_usd_wayfair_ca', 'cost_usd_wayfair_ca_orange', 'cost_usd_wayfair_ca_purple'],
  physical: ['material', 'finish', 'color', 'finish_type', 'craftsmanship', 'durability', 'lead_free', 'installation_type', 'mounting_type', 'sink_shape', 'overall_shape',
    'pattern', 'wood_species', 'antimicrobial', 'application'],
  sink: ['number_of_bowls', 'bowl_configuration', 'basin_split', 'low_divider', 'gauge', 'sink_radius_mm', 'strainer_model', 'drain_hole_location', 'drain_diameter_in',
    'has_grooves', 'includes_grids', 'grids_model_code', 'left_bowl_depth_in', 'right_bowl_depth_in', 'number_of_faucet_holes', 'compatible_faucet_type',
    'faucet_hole_center_spacing', 'overflow', 'pedestal_included', 'compatible_pedestal', 'console_included'],
  faucet: ['num_install_holes', 'spout_type', 'swivel_spout', 'spout_rotation_degrees', 'max_flow_rate', 'hot_cold_dispenser', 'spray_included', 'spray_type',
    'spray_function_activation', 'spray_head_functions', 'pull_down_hose_model', 'sensor_activation', 'cartridge_size', 'cartridge_type', 'cold_start_handle',
    'handles_included', 'number_of_handles', 'handle_style', 'handle_material', 'handle_style_lock', 'deck_plate_included', 'compatible_deck_plate',
    'supply_line_included', 'aerator_included', 'hose_included', 'connection_size', 'laminar_flow', 'drain_overflow', 'valve_included',
    'compatible_drain_assembly', 'faucet_centers', 'faucet_height', 'spout_reach', 'spout_height', 'install_hole_dia_mm', 'install_hole_dia_in'],
  accessory: ['accessories_included', 'number_of_pieces', 'juice_grooves', 'bpa_free', 'flexible_board', 'reversible', 'over_the_sink', 'knife_included',
    'collapsible', 'handheld', 'length_with_handles', 'soap_dispenser_features', 'grid_hole_placement', 'weight_capacity', 'installation_required',
    'drain_shape', 'overflow_included', 'trip_lever_included', 'garbage_disposal_compatible', 'drain_closure_type', 'number_of_drain_holes',
    'compatible_fixture', 'diameter_in', 'drain_connection_diameter_in', 'max_compatible_drain_opening', 'assembly_required'],
  dimensions: ['ext_length', 'ext_width', 'ext_depth', 'ext_height', 'int_length', 'int_width', 'int_depth', 'min_ext_cabinet', 'min_int_cabinet', 'max_deck',
    'cutout_length', 'cutout_width', 'cutout_depth', 'product_weight_lb'],
  shipping: ['shipping_weight_lb', 'ship_length', 'ship_width', 'ship_height'],
  carton: ['master_carton_quantity', 'master_carton_length', 'master_carton_width', 'master_carton_height', 'master_carton_weight_lb'],
  trade: ['country_of_origin', 'country_of_origin_details', 'hs_code', 'hs_code_ca', 'warranty', 'warranty_length', 'warranty_url_us', 'warranty_url_ca',
    'warranty_text_us', 'warranty_text_ca', 'commercial_warranty', 'commercial_warranty_length', 'product_warranty', 'warranty_details',
    'canada_restriction', 'reason_for_restriction', 'hazardous_material', 'safety_listings', 'safety_listing_reg'],
  certifications: ['upc_certified', 'cupc_certified', 'vermont_compliant', 'scc_compliant', 'ada_compliant', 'asse_1001', 'asse_1016', 'ista_1a', 'ista_3a_6a',
    'ista_certified', 'title_20', 'title_24', 'uplr_compliant', 'calgreen_compliant', 'ul_1951', 'asme_csa', 'asme_18_2', 'asme_19_1', 'asme_19_2',
    'asme_19_3', 'asme_19_4', 'energy_efficiency', 'ab_100', 'ab_1953', 'sdwa', 'nsf_ansi_61', 'nsf_certified', 'csa_b45_5', 'ansi_z124_6_97',
    'ww_p_541', 'greenguard', 'greenguard_certified', 'greenguard_gold', 'cradle_to_cradle', 'cradle_certified', 'cradle_material_health',
    'iso_14021', 'epd_type_iii', 'epa_watersense', 'iapmo_certified', 'wqa_gold_seal', 'usda_compliant', 'taa_compliant', 'pefc_certified',
    'sfi_certifications', 'fsc_certifications'],
  content_en: ['general_title_en', 'description_en', 'marketing_copy', 'keywords_en', 'product_care', 'product_url'],
  content_fr: ['general_title_fr', 'description_fr', 'keywords_fr'],
  retailer: ['bbb_ca_upc', 'asin', 'amazon_fnsku', 'homedepot_ca_sku', 'bbb_ca_sku', 'rona_ca_sku', 'bestbuy_ca_sku', 'bbb_com_sku', 'lowes_sku', 'wayfair_sku'],
};
const SECTION_OF_FIELD = new Map(Object.entries(SECTION_FIELDS).flatMap(([s, keys]) => keys.map((k) => [k, s])));
// A sink's installation holes are the sink's own (its faucet holes); an
// accessory's drain size and handles are details of the accessory.
const SECTION_BY_KIND = {
  kitchen_sink: { num_install_holes: 'sink' },
  bathroom_sink: { num_install_holes: 'sink' },
  accessory: { drain_diameter_in: 'accessory', handles_included: 'accessory' },
};
// Bullets sit in their language's content, right after the description.
export function sectionOfHeader(header, kind = null) {
  const bullet = normalizeHeader(header).match(BULLET_RE);
  if (bullet) return bullet[2] === 'fr' ? 'content_fr' : 'content_en';
  const def = defForHeader(header);
  if (!def) return 'other';
  return SECTION_BY_KIND[kind]?.[def.key] ?? SECTION_OF_FIELD.get(def.key) ?? 'other';
}

// Columns every template adds to its vendor-sheet ones, so the PIM's Excel
// carries everything the product page edits (user, 2026-10-15) — by label.
const ALWAYS = [
  'SKU (Model Number)', 'Brand', 'Category', 'Model Name', 'Series', 'Product Type', 'Manufacturer', 'UPC',
  'MSRP CAD$', ...PRICE_DEFS.map((d) => d.label),
  'Material', 'Finish', 'Color', 'Finish Type',
  'Product Weight (lb)', 'Shipping Weight (lb)', 'Shipping Length (in)', 'Shipping Width (in)', 'Shipping Height (in)',
  'Quantity / Master Carton', 'Master Carton Length (in)', 'Master Carton Width (in)', 'Master Carton Height (in)', 'Master Carton Weight (lb)',
  'Country of Origin', 'HS Code (USA)', 'HS Code (Canada)', 'Full or Limited Warranty', 'Warranty Length',
  'Warranty URL (USA)', 'Warranty URL (Canada)', 'Warranty Text (USA)', 'Warranty Text (Canada)',
  'General Title (EN)', 'Description (EN)', 'Short Description - Marketing Copy', 'Search Keywords (EN)',
  'General Title (FR)', 'Description (FR)', 'Search Keywords (FR)',
];
// …and what one kind of product carries beyond its vendor sheet (the fields
// the catalog holds for it, 2026-10-15).
const BY_KIND = {
  kitchen_sink: ['Number of Installation Holes', 'Left Bowl Depth (in)', 'Right Bowl Depth (in)', 'Grids Model Code'],
  bathroom_sink: ['Application', 'Product Care', 'Number of Bowls', 'Installation Options', 'Internal Minimum Cabinet Size',
    'External Minimum Cabinet Size', 'Number of pieces Included', 'Accessories included'],
  kitchen_faucet: ['Spout Rotation (degrees)', 'Sensor Activation', 'Overall Shape', 'UPC Certified', 'SCC Compliant'],
  bathroom_faucet: ['Spout Rotation (degrees)', 'Overall Shape', 'UPC Certified', 'Cartridge size', 'Cartridge Type',
    'Installation Hole Diameter (mm)', 'Lead Free', 'Spout Type', 'Swivel Spout', 'Spray Type', 'Spray Head Functions',
    'Spray Function Activation', 'ADA Compliant', 'Lock Type'],
  accessory: ['External Length', 'External Width', 'External Depth', 'Product URL', 'BPA Free', 'Drain Diameter', 'Installation Options'],
};
// Which kind a vendor header list is.
export const TEMPLATE_KIND = new Map([
  [TEMPLATE_HEADERS, 'kitchen_sink'], [BATH_SINK_TEMPLATE_HEADERS, 'bathroom_sink'], [FAUCET_TEMPLATE_HEADERS, 'kitchen_faucet'],
  [BATH_FAUCET_TEMPLATE_HEADERS, 'bathroom_faucet'],
]);

/**
 * A vendor header list → the PIM's sectioned layout: its columns (each named
 * by its field's label) plus the ones above, one column per field, grouped in
 * SECTIONS order (a column keeps its place inside its section). Returns
 * [{ key, title, color, headers: [...] }] without the empty sections.
 */
export function templateLayout(baseHeaders) {
  const kind = templateKindOf(baseHeaders);
  const seen = new Set();
  const columns = [];
  const add = (header) => {
    const n = normalizeHeader(header);
    if (!n) return;
    const def = BULLET_RE.test(n) ? null : defForHeader(header);
    // a vendor column no field reads ("Family #" is derived from the SKU, "BM
    // Dealer Cost" is MSRP × 0.30) would only ever be empty
    if (!def && !BULLET_RE.test(n)) return;
    const id = def ? def.key : `bullet:${n}`;
    if (seen.has(id)) return;
    seen.add(id);
    columns.push(def ? def.label : header);
  };
  baseHeaders.forEach(add);
  [...ALWAYS, ...(BY_KIND[kind] ?? [])].forEach(add);
  // inside a section: SECTION_FIELDS order, bullets right after their description
  const sectionOf = (header) => sectionOfHeader(header, kind);
  const rank = (header) => {
    const fields = SECTION_FIELDS[sectionOf(header)] ?? [];
    const bullet = normalizeHeader(header).match(BULLET_RE);
    if (bullet) return fields.indexOf(bullet[2] === 'fr' ? 'description_fr' : 'description_en') + 0.5 + Number(bullet[1]) / 100;
    const at = fields.indexOf(defForHeader(header)?.key);
    return at >= 0 ? at : 1000;
  };
  return SECTIONS
    .map((s) => ({
      ...s,
      headers: columns.map((h, i) => [h, i]).filter(([h]) => sectionOf(h) === s.key)
        .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([h]) => h),
    }))
    .filter((s) => s.headers.length);
}

// ---------- Dropdowns (user, 2026-10-15) ----------
// The Category cell the PIM writes, one per category — names CATEGORY_MAP
// reads back (the PIM export and the Excel dropdown use them).
export const CATEGORY_LABELS = {
  kitchen_sink: 'Kitchen Sink',
  bathroom_sink: 'Bathroom Sink',
  kitchen_faucet: 'Kitchen Faucet',
  kitchen_faucet_combo: 'Kitchen Faucet Combo',
  cold_water_tap: 'Cold Water Tap',
  bathroom_faucet: 'Bathroom Faucet',
  pot_filler: 'Pot Filler',
  bar_prep_sink: 'Bar Prep Sink',
  laundry_sink: 'Laundry Sink',
  outdoor_sink: 'Outdoor Sink',
  colander_drying_rack: 'Colanders & Drying Racks',
  accessory: 'Accessory',
};

// The product page's dropdowns, by the field they write: the PIM's Excel puts
// the same list on that column. A yes / no field gets Yes / No. (Strainer
// Model and the deck plate / drain pickers list the catalog's own SKUs per
// brand, so they stay free text here.)
const COMPLIANCE_FIELDS = [
  'ada_compliant', 'ansi_z124_6_97_compliant', 'asme_a112_19_1_compliant', 'asme_a112_19_2_compliant', 'asme_a112_19_3_compliant',
  'asme_a112_19_4_compliant', 'asme_csa_certified', 'asse_1001_certified', 'cradle_to_cradle_material_health', 'calgreen_compliant',
  'csa_b45_5_iapmo_z124_compliant', 'ab_100_compliant', 'cradle_to_cradle_certified', 'epa_watersense_certified',
  'energy_efficiency_compliant', 'greenguard_certified', 'greenguard_gold_certified', 'iso_14021_certified', 'ista_1a_certified',
  'ista_3a_6a_certified', 'ista_certified', 'nsf_certified', 'nsf_ansi_61_certified', 'pefc_certified', 'sdwa_compliant',
  'taa_compliant', 'title_20_compliant', 'title_24_compliant', 'epd_type_iii', 'ul_1951_listed', 'uplr_compliant',
  'usda_compliant', 'ww_p_541_certified', 'cupc_certified',
  // vendor-sheet certifications the page does not show, same answers
  'iapmo_certified', 'asme_a112_18_2_compliant', 'asse_1016_certified', 'ab_1953_compliant', 'wqa_gold_seal_certified',
];
const YES_NO_FIELDS = [
  'antimicrobial', 'canada_product_restriction', 'laminar_flow', 'overflow', 'scc_compliant', 'swivel_spout', 'upc_certified',
  'vermont_act_193_compliant',
];
const LIST_BY_TARGET = {
  'col:brand': BRANDS,
  'col:category': Object.values(CATEGORY_LABELS),
  'col:color': COLOR_OPTIONS,
  'attr:manufacturer': MANUFACTURER_OPTIONS,
  'attr:finish_type': FINISH_TYPE_OPTIONS,
  'attr:country_of_origin': COUNTRY_NAMES,
  'attr:warranty': WARRANTY_OPTIONS,
  'attr:warranty_length': WARRANTY_LENGTH_OPTIONS,
  'attr:commercial_warranty_length': WARRANTY_LENGTH_OPTIONS,
  'attr:craftsmanship': CRAFTSMANSHIP_OPTIONS,
  'attr:sink_shape': SINK_SHAPE_OPTIONS,
  'attr:installation_type': INSTALLATION_TYPE_OPTIONS,
  'attr:gauge': GAUGE_OPTIONS,
  'attr:bowl_configuration': BOWL_CONFIGURATION_OPTIONS,
  'attr:basin_split': BASIN_SPLIT_OPTIONS,
  'attr:drain_hole_location': DRAIN_LOCATION_OPTIONS,
  'attr:overall_shape': FAUCET_SHAPE_OPTIONS,
  'attr:spout_type': SPOUT_TYPE_OPTIONS,
  'attr:spray_type': SPRAY_TYPE_OPTIONS,
  'attr:spray_function_activation': SPRAY_ACTIVATION_OPTIONS,
  'attr:sensor_activation': SENSOR_ACTIVATION_OPTIONS,
  'attr:handle_style': HANDLE_STYLE_OPTIONS,
  'attr:max_flow_rate': MAX_FLOW_RATE_OPTIONS,
  'attr:number_of_bowls': BOWL_COUNT_OPTIONS,
  'attr:number_of_handles': HANDLE_COUNT_OPTIONS,
  'attr:number_of_installation_holes': HOLE_COUNT_OPTIONS,
  'attr:number_of_faucet_holes': HOLE_COUNT_OPTIONS,
  'attr:number_of_pieces': PIECE_COUNT_OPTIONS,
  'attr:number_of_drain_holes': DRAIN_HOLE_COUNT_OPTIONS,
  'attr:spout_rotation_degrees': SPOUT_ROTATION_OPTIONS,
  'attr:sink_radius_mm': SINK_RADIUS_OPTIONS,
  'attr:drain_overflow': YES_NO_DNA_OPTIONS,
  ...Object.fromEntries(COMPLIANCE_FIELDS.map((f) => [`attr:${f}`, COMPLIANCE_OPTIONS])),
  ...Object.fromEntries(YES_NO_FIELDS.map((f) => [`attr:${f}`, YES_NO_OPTIONS])),
};
// Lists the page shows for some kinds only: Installation Type is a dropdown
// on sinks (free on accessories, faucets use Mounting), Overall Shape on
// faucets (free on accessories — a board is "Rectangular").
const LIST_ONLY_FOR = {
  'attr:installation_type': ['kitchen_sink', 'bathroom_sink'],
  'attr:overall_shape': ['kitchen_faucet', 'bathroom_faucet'],
};
/** The kind of a vendor header list (TEMPLATE_KIND), accessories by default. */
export const templateKindOf = (baseHeaders) => TEMPLATE_KIND.get(baseHeaders) ?? 'accessory';
/** The dropdown a column of the PIM's Excel carries on a kind's sheet, or null. */
export function dropdownFor(header, kind = null) {
  if (BULLET_RE.test(normalizeHeader(header))) return null;
  const def = defForHeader(header);
  if (!def) return null;
  const target = def.target.col ? `col:${def.target.col}` : def.target.attr ? `attr:${def.target.attr}` : null;
  if (target && LIST_ONLY_FOR[target] && !LIST_ONLY_FOR[target].includes(kind)) return null;
  if (target && LIST_BY_TARGET[target]) return LIST_BY_TARGET[target];
  return def.type === 'bool' ? YES_NO_OPTIONS : null;
}

/**
 * What a column of the PIM's Excel checks as it is typed (user, 2026-10-15:
 * "todo donde el usuario deba meter algo manual … drop down", against typos):
 *   { type: 'list', values } — the page's fixed list, else the values the
 *     catalog already uses for an open field (`suggestions`, from
 *     loadSuggestionLists);
 *   { type: 'decimal' } / { type: 'whole' } — a number (prices, sizes, counts);
 *   { type: 'textLength', min: 12, max: 14 } — a UPC;
 *   null — free text (titles, descriptions, HS codes, URLs, part numbers).
 */
// `strict` (user, 2026-10-15: "solo número, no letras ni símbolos"): a number,
// a UPC, and a list made only of numbers (counts, radius, rotation, flow
// rate) refuse anything else; the other lists only warn, as the page keeps a
// value off its list.
const NUMERIC_TEXT = /^\d+(\.\d+)?$/;
export function excelValidationFor(header, kind = null, suggestions = {}) {
  const fixed = dropdownFor(header, kind);
  if (fixed?.length) return { type: 'list', values: fixed, strict: fixed.every((v) => NUMERIC_TEXT.test(v)) };
  if (BULLET_RE.test(normalizeHeader(header))) return null;
  const def = defForHeader(header);
  if (!def) return null;
  const field = def.target.col ?? def.target.attr;
  const known = field ? suggestions[field] : null;
  if (known?.length) return { type: 'list', values: known };
  if (def.type === 'upc') return { type: 'upc', min: 12, max: 14, strict: true };
  if (def.type === 'int') return { type: 'whole', strict: true };
  if (def.type === 'number' || def.type === 'money') return { type: 'decimal', strict: true };
  return null;
}
