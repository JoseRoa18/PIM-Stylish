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
  'bath sink': 'bathroom_sink',
  'bath sinks': 'bathroom_sink',
  'bathroom sink': 'bathroom_sink',
  'bathroom sinks': 'bathroom_sink',
  'kitchen faucet': 'kitchen_faucet',
  'kitchen faucets': 'kitchen_faucet',
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
};

export const FIELD_DEFS = [
  // ---------- Identification ----------
  { key: 'sku', label: 'Model Number', aliases: ['modelnumber', 'sku', 'suppliersku'], type: 'text', target: { col: 'sku' }, required: true },
  { key: 'model_name', label: 'Model Name', aliases: ['modelname'], type: 'text', target: { col: 'model_name' } },
  // Bathroom-faucet sheets have no "Model Name" column — buildImportRows falls
  // back to the QuickBooks Description as the product name when Model Name is empty.
  { key: 'quickbooks_description', label: 'Quickbooks Description', aliases: ['quickbooksdescription'], type: 'text', target: { col: 'quickbooks_description' } },
  // NOTE: "Family #" from spreadsheets is intentionally ignored — variant
  // families are derived automatically from the SKU base model (S-300XG → S-300).
  { key: 'brand', label: 'Brand', aliases: ['brand'], type: 'text', target: { col: 'brand' }, required: true },
  { key: 'category', label: 'Category', aliases: ['category'], type: 'category', target: { col: 'category' }, required: true },
  { key: 'msrp_cad', label: 'MSRP CAD$', aliases: ['msrpcad', 'msrp', 'msrpcad$'], type: 'number', target: { col: 'msrp_cad' } },
  { key: 'dealer_cost_cad', label: 'Dealer Cost CAD$', aliases: ['bmdealercostcad', 'dealercostcad', 'bmdealercost', 'bmdealercostcadinternaldatadonotuse'], type: 'number', target: { col: 'dealer_cost_cad' } },
  { key: 'launch_lead', label: 'Launch Lead', aliases: ['launchlead'], type: 'date', target: { col: 'launch_lead' } },
  { key: 'sample_available_date', label: 'When is sample available', aliases: ['whenissampleavailable', 'sampleavailable', 'whensampleavailable', 'sampleavailabledate'], type: 'date', target: { col: 'sample_available_date' } },
  { key: 'ready_to_sell_date', label: 'When will it be ready to sell?', aliases: ['whenwillitbereadytosell', 'readytosell', 'readytoselldate'], type: 'date', target: { col: 'ready_to_sell_date' } },
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
  { key: 'finish', label: 'Finish / Color', aliases: ['finishcolor', 'colorfinish', 'finish'], type: 'text', target: { col: 'finish' } },
  // Dual-mount sinks list two options ("Undermount; Drop-In") → stored as array
  { key: 'installation_type', label: 'Installation Options', aliases: ['installationoptions', 'installationtype'], type: 'list', target: { attr: 'installation_type' } },
  { key: 'sink_radius_mm', label: 'Sink Radius', aliases: ['sinkradius', 'sinkradiusmm'], type: 'number', target: { attr: 'sink_radius_mm' } },

  // ---------- External / internal dimensions ----------
  { key: 'ext_length', label: 'External Lenght', aliases: ['externallenght', 'externallength', 'externalsinksizelengthinches', 'overallproductlengthendtoend', 'overalllengthendtoend'], type: 'number', target: { dim: ['external_dimensions_in', 'length'] } },
  { key: 'ext_width', label: 'External Width', aliases: ['externalwidth', 'externalsinksizewidthinches', 'overallproductwidthsidetoside', 'overallwidthfronttoback', 'overallwidthsidetoside'], type: 'number', target: { dim: ['external_dimensions_in', 'width'] } },
  { key: 'ext_depth', label: 'External Depth', aliases: ['externaldepth', 'externalsinksizedepthinches', 'overallproductthickness', 'overalldepthfronttoback'], type: 'number', target: { dim: ['external_dimensions_in', 'depth'] } },
  { key: 'ext_height', label: 'Overall Height - Top to Bottom', aliases: ['overallheighttoptobottom', 'overallproductheighttoptobottom'], type: 'number', target: { dim: ['external_dimensions_in', 'height'] } },
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
  { key: 'drain_hole_location', label: 'Drain Hole location', aliases: ['drainholelocation', 'drainholelocationplacement', 'drainplacement'], type: 'text', target: { attr: 'drain_hole_location' } },
  { key: 'drain_diameter_in', label: 'Drain Diameter', aliases: ['draindiameter', 'drainholediameter'], type: 'number', target: { attr: 'drain_diameter_in' } },
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
  { key: 'shipping_weight_lb', label: 'Shipping Weight Lbs', aliases: ['shippingweightlbs', 'shippingweightlb', 'shippingweight'], type: 'number', target: { col: 'shipping_weight_lb' } },
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

  // ---------- Accessory (cutting board) specific ----------
  { key: 'wood_species', label: 'Wood Species', aliases: ['woodspecies'], type: 'text', target: { attr: 'wood_species' } },
  { key: 'juice_grooves', label: 'Carving Board Juice Grooves', aliases: ['carvingboardjuicegrooves', 'juicegrooves'], type: 'bool', target: { attr: 'juice_grooves' } },
  { key: 'bpa_free', label: 'BPA Free', aliases: ['bpafree'], type: 'bool', target: { attr: 'bpa_free' } },
  { key: 'product_care', label: 'Product Care', aliases: ['productcare'], type: 'text', target: { attr: 'product_care' } },
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
  { key: 'greenguard', label: 'GREENGUARD Certifications', aliases: ['greenguardcertifications', 'greenguardcertified'], type: 'text', target: { attr: 'greenguard_certifications' } },

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

  // ---------- Marketing content ----------
  { key: 'general_title_en', label: 'General Title (EN)', aliases: ['generaltitleen'], type: 'text', target: { attr: 'general_title_en' } },
  { key: 'description_en', label: 'Description (EN)', aliases: ['descriptionennomorethan1000characters', 'descriptionen'], type: 'description', target: { col: 'description' } },
  { key: 'general_title_fr', label: 'General Title (FR)', aliases: ['generaltitlefr'], type: 'text', target: { attr: 'general_title_fr' } },
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
  return map;
})();
