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
  // Sink (composite / nano-coated) colors
  grey: 'Matte Grey',
  gray: 'Matte Grey',
  black: 'Matte Black',
  'graphite black': 'Gunmetal Black',
  'nano graphite black dura-tek': 'Gunmetal Black',
};
const MOUNT_ALIAS = { 'one hole': 'Single-Hole', 'two holes': 'Centerset' };
const SPOUT_ALIAS = { foldable: 'Swivel' };
const alias = (table, v) => {
  if (!v) return '';
  const k = String(v).toLowerCase().trim();
  return table[k] ?? v;
};

// PIM stores "Ceramic Disk Cartridge"; Wayfair's valid value is "Disc".
const cartridge = (v) => (v && /ceramic dis[ck]/i.test(v) ? 'Ceramic Disc Cartridge' : v || '');
// Compatible deck-plate part numbers: normalize separators, map the typo'd
// "Does not Appy" placeholder to the Wayfair-friendly "Does Not Apply".
const deckPlate = (v) => {
  if (!v) return '';
  if (/does\s*not?\s*app/i.test(v)) return 'Does Not Apply';
  return String(v).replace(/[,:]/g, ';').replace(/\s*;\s*/g, '; ').trim();
};
// ADA field stores "No" / "ADA Compliant" (and rarely true/false).
const adaYesNo = (v) => {
  if (v == null || v === '') return '';
  const s = String(v).toLowerCase();
  if (s.includes('not') || s === 'no' || s === 'false') return 'No';
  if (s.includes('yes') || s.includes('compliant') || s === 'true') return 'Yes';
  return 'No';
};
// spray_type (Pull Down / Pull Out / Standard / Pot Filler …) → Construction Features.
const sprayToConstruction = (v) => {
  if (!v) return '';
  const s = String(v).toLowerCase();
  if (s.includes('pull down') || s.includes('pull-down')) return 'Pull Down Spray';
  if (s.includes('pull out') || s.includes('pull-out')) return 'Pull Out Spray';
  if (s.includes('side')) return 'Side Spray';
  if (s.includes('not app') || s.includes('does not')) return 'Does Not Apply';
  return 'No Construction Features'; // standard faucet, pot filler, etc.
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
  'Product Name': (p) => attr(p).general_title_en || p.model_name || p.sku,
  'Universal Product Code': (p) => attr(p).upc || '',
  'Collection Name': () => '', // faucets have no collection name
  'Manufacturer Product URL': (p) => (/azuni/i.test(p.brand) ? 'https://azuni.ca' : 'https://stylishkb.com'),
  Designer: (p) => brandMap(p.brand), // Designer = the brand
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
    return (Array.isArray(m) ? m : [m])
      .filter(Boolean)
      .map((x) => (/composite granite|granite composite/i.test(x) ? 'Granite' : x))
      .join('; ');
  },
  Durability: (p) => {
    const d = attr(p).durability_tags || [];
    return (Array.isArray(d) ? d : [d]).filter(Boolean).join('; ');
  },
  'Spout Type': (p) => alias(SPOUT_ALIAS, attr(p).spout_type),
  'Construction Features': (p) => sprayToConstruction(attr(p).spray_type),
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
  'Number of Installation Holes': (p) => num(attr(p).number_of_installation_holes),
  'Installation Hole Diameter': (p) => num(attr(p).install_hole_diameter_in),
  'Number of Handles': (p) => num(attr(p).number_of_handles),
  'Maximum Deck Thickness': (p) => num(attr(p).max_deck_thickness_in),
  'Overall Product Weight': (p) => num(attr(p).product_weight_lb || p.shipping_weight_lb),
  'Cartridge Type': (p) => cartridge(attr(p).cartridge_type),
  // Wayfair uses the British spelling ("Poured / Moulded").
  'Craftsmanship Type': (p) => (attr(p).craftsmanship || '').replace(/molded/i, 'Moulded'),
  'Compatible Deck Plate Part Number': (p) => deckPlate(attr(p).compatible_deck_plate),
  'Mounting / Installation': (p) => alias(MOUNT_ALIAS, attr(p).mounting_type),
  // Warranty
  'Product Warranty': () => 'Yes',
  'Full or Limited Warranty': () => 'Limited',
  'Warranty Length': (p) => attr(p).warranty_length || '',
  // Compliance
  'Lead Free': (p) => yesNo(attr(p).lead_free),
  'ADA Compliant': (p) => adaYesNo(attr(p).ada_compliant),
  'Commercial Warranty': () => 'No',
  'Wayfair Compliance Verified Program (including Baby Safety Alliance fka JPMA) for this product category': () => 'No',
  'Uniform Packaging and Labeling Regulations (UPLR) Compliant': (p) => yesNo(attr(p).uplr_compliant) || 'No',
  'Canada Product Restriction': (p) => yesNo(attr(p).canada_product_restriction) || 'No',
  'Reason for Restriction': (p) => attr(p).reason_for_restriction || 'Does Not Apply',
  'NSF/ANSI 61 Certified': () => 'No',
  'ASME A112.18.1/CSA B125.1 - 2018': (p) => yesNoDNA(attr(p).asme_csa_certified),
  'Title 24 Compliant': (p) => yesNoDNA(attr(p).title_24_compliant),
  'Warning Required': () => 'No',
  // Wayfair Canada: ship origin is always Canada; origin-details always N/A.
  'Country Of Manufacturer': () => 'Canada',
  'Country of Origin - Additional Details': () => 'Does Not Apply',
};

// Numbered image / bullet columns are matched by pattern.
export const IMAGE_COL_RE = /^Image File Name or URL (\d+)$/;
export const BULLET_COL_RE = /^Feature Bullet (\d+)$/;

// Variant columns. Variant Type / Group Reference ID are single; Grouping and
// Attribute-Name-On-Site are numbered (1..3). Values come from a per-product
// `_variant` object attached by the generator (needs whole-family context).
export const VARIANT_GROUPING_RE = /^Variant Grouping (\d+)$/;
export const VARIANT_ATTR_NAME_RE = /^Variant Attribute Name On Site (\d+)$/;

// Document columns come in pairs: "Document File Name or URL N" + "Document Type N".
export const DOC_FILE_RE = /^Document File Name or URL (\d+)$/;
export const DOC_TYPE_RE = /^Document Type (\d+)$/;
// PIM product_media.document_type → Wayfair "Document Type" valid value.
export const DOC_TYPE_MAP = {
  spec_sheet: 'Specifications',
  installation_manual: 'Installation & Assembly',
  warranty_file: 'Warranty Information',
  owner_manual: 'Owner Manual',
  cut_out_template: 'Dimensions',
};
// Priority when filling the 3 document slots (spec → install → warranty first).
export const DOC_TYPE_PRIORITY = ['spec_sheet', 'installation_manual', 'warranty_file', 'owner_manual', 'cut_out_template'];

// Candidate second axes (beyond Finish) for families that repeat a finish,
// per category. name = the Wayfair "Variant Grouping" Select value for that
// template; get = normalized distinguishing key.
export const WAYFAIR_VARIANT_AXES = {
  default: [
    { name: 'Flow Rate', get: (p) => (p.attributes?.max_flow_rate ?? '') + '' },
    { name: 'Handle Style', get: (p) => (p.attributes?.handle_style ?? p.attributes?.number_of_handles ?? '') + '' },
    { name: 'Sensor', get: (p) => (p.attributes?.sensor_type ?? '') + '' },
  ],
  // Sinks: the same finish repeats between configuration variants of a model —
  // bare vs kit (S-828WH/WHK), with/without grid (S-300T/TG). The PIM
  // attributes are often identical between them; the SKU's suffix after the
  // numeric root IS the configuration code, so it's the distinguishing signal.
  // The 628 template's "Design" axis covers that split.
  kitchen_sink: [
    { name: 'Design', get: (p) => String(p.sku).replace(/^[A-Za-z]+-\d+/, '') },
  ],
  // Bathroom sinks (588 axes: Finish / Faucet Mount / Drain Finish): the "D"
  // suffix = pop-up drain included → Drain Finish axis; drilled vs undrilled
  // splits by Faucet Mount.
  bathroom_sink: [
    { name: 'Drain Finish', get: (p) => (/D$/i.test(p.sku) ? 'With Drain' : 'No Drain') },
    { name: 'Faucet Mount', get: (p) => `${attr(p).compatible_faucet_type ?? ''}|${attr(p).number_of_faucet_holes ?? 0}` },
  ],
};

// SKUs that are their own Wayfair listing, never a variant row, per category.
// Bathroom "-2" SKUs are 2-packs (no pack-size axis exists on template 588).
export const WAYFAIR_STANDALONE = {
  bathroom_sink: /-2$/i,
};

// ---- Kitchen-sink helpers ----
const isFarmhouse = (p) => /farm|apron/i.test(p.product_type ?? '');
// PIM accessory entries are model-coded ("A-04 Colander", "ST-01 Strainer (x2)");
// map them onto Wayfair's "Pieces Included" nouns by keyword.
const PIECES_KEYWORDS = [
  [/colander/i, 'Colander'],
  [/cutting board/i, 'Cutting Board'],
  [/strainer/i, 'Basket Strainer'],
  [/bottom grid|sink grid|grid/i, 'Bottom Grid'],
  [/drying rack|driying rack/i, 'Does Not Apply'], // no Wayfair option — dropped below
  [/soap|lotion/i, 'Soap / Lotion Dispenser'],
  [/cut.?out template/i, 'Cut Out Template'],
  [/drain assembly|drain kit/i, 'Drain Assembly'],
  [/faucet hole cover/i, 'Faucet Hole Covers'],
];
const sinkPieces = (p) => {
  const out = new Set();
  for (const a of attr(p).accessories_included ?? []) {
    for (const [re, label] of PIECES_KEYWORDS) {
      if (re.test(a)) { if (label !== 'Does Not Apply') out.add(label); break; }
    }
  }
  return [...out].join('; ');
};
const DRAIN_ALIAS = {
  'rear center': 'Centre-Back',
  'rear': 'Back',
  'center': 'Centre',
  'centre': 'Centre',
  'side drain / reversible': 'Reversible',
  'side drain/reversible': 'Reversible',
  'center drain / reversible': 'Reversible',
  'center drain/reversible': 'Reversible',
  'side drain': 'Reversible',
};
// Extract the part code (e.g. "G-05") from an accessory entry matching a keyword.
const partCode = (p, re) => {
  const hit = (attr(p).accessories_included ?? []).find((a) => re.test(a));
  return hit ? (hit.match(/^[A-Z]+-?\w+/) || [''])[0] : '';
};

// Category-specific rule overrides. The generator resolves a column as
// WAYFAIR_CATEGORY_RULES[product.category][name] ?? WAYFAIR_RULES[name],
// so templates that share display names with different semantics (Product
// Type, Mounting, Pieces Included…) stay correct per category.
export const WAYFAIR_CATEGORY_RULES = {
  kitchen_sink: {
    'Product Type': (p) => (/workstation/i.test(attr(p).general_title_en ?? '') ? 'Kitchen Sink Workstation' : 'Standard Kitchen Sink'),
    'Mounting / Installation': (p) => {
      const t = p.product_type ?? '';
      if (/dual/i.test(t)) return 'Dual Mount';
      if (/under/i.test(t)) return 'Undermount';
      if (/drop/i.test(t)) return 'Drop-In';
      if (isFarmhouse(p)) return 'Farmhouse / Apron';
      const list = attr(p).installation_type ?? [];
      return list.length > 1 ? 'Dual Mount' : list[0] ?? '';
    },
    'Overall Shape': (p) => attr(p).sink_shape ?? '',
    'Pieces Included': (p) => sinkPieces(p),
    'Construction Features': (p) => (isFarmhouse(p) ? 'Apron' : 'No Construction Features'),
    'Number of Basins': (p) => (attr(p).number_of_bowls != null ? String(attr(p).number_of_bowls) : ''),
    'Short Height Divider': (p) => (attr(p).low_divider === true ? 'Yes' : attr(p).low_divider === false ? 'No' : ''),
    'Number of Faucet Holes': (p) => String(attr(p).number_of_faucet_holes ?? attr(p).number_of_installation_holes ?? 0),
    'Faucet Finish': () => 'Does Not Apply',
    'Stainless Steel Gauge': (p) => {
      if (!/stainless/i.test(p.material ?? '')) return 'Does Not Apply';
      const m = String(attr(p).gauge ?? '').match(/\d+/);
      return m ? m[0] : '';
    },
    'Overall Width from Front to Back': (p) => attr(p).external_dimensions_in?.width ?? '',
    'Overall Length - End to End': (p) => attr(p).external_dimensions_in?.length ?? '',
    'Overall Height - Top to Bottom': (p) => attr(p).external_dimensions_in?.depth ?? '',
    'Minimum Base Cabinet Width - Side to Side': (p) => attr(p).min_external_cabinet_size_in ?? '',
    'Basin Width - Front to Back': (p) => attr(p).internal_dimensions_in?.width ?? '',
    'Basin Length - Side to Side': (p) => attr(p).internal_dimensions_in?.length ?? '',
    'Basin Depth - Top to Bottom': (p) => attr(p).internal_dimensions_in?.depth ?? '',
    'Drain Diameter': (p) => attr(p).drain_diameter_in ?? '',
    'Drain Placement': (p) => {
      const v = attr(p).drain_hole_location ?? '';
      return DRAIN_ALIAS[String(v).toLowerCase().trim()] ?? v;
    },
    'Compatible Sink Grid Part Number': (p) => partCode(p, /grid/i),
    'Compatible Drain Assembly Part Number': (p) => attr(p).strainer_model ?? '',
    'ASME A112.19.4 Compliant': () => 'No',
    'SCC Compliant': (p) => (/yes/i.test(String(attr(p).scc_compliant ?? '')) ? 'Yes' : 'No'),
  },

  bathroom_sink: {
    // Porcelain color is not a "finish" for Wayfair's 588 list (its Finish VV
    // has no White) — metals pass through, anything else is Does Not Apply.
    Finish: (p) => (/black/i.test(p.finish ?? '') ? 'Matte Black' : 'Does Not Apply'),
    'Product Type': () => '', // 588's Product Type VV is unrelated taxonomy junk
    'Compatible Faucet Type': (p) => attr(p).compatible_faucet_type ?? '',
    'Number of Faucet Holes': (p) => String(attr(p).number_of_faucet_holes ?? 0),
    'Compatible Pedestal Part Number': (p) => attr(p).compatible_pedestal ?? '',
    // "D" SKUs include a pop-up drain; the rest ship bare.
    'Pieces Included': (p) => (/D$/i.test(p.sku) ? 'Drain Assembly' : 'Does Not Apply'),
    'Drain Finish': () => 'Does Not Apply',
    'Construction Features': (p) => {
      const parts = [];
      if (/yes/i.test(String(attr(p).overflow ?? ''))) parts.push('Overflow Hole');
      if ((attr(p).number_of_faucet_holes ?? 0) > 0) parts.push('Faucet Holes');
      return parts.join('; ') || 'No Construction Features';
    },
    'Overall Shape': (p) => attr(p).sink_shape ?? '',
    'Mounting / Installation': (p) => attr(p).mounting_type ?? '',
    'Dual Mount Installation Type': () => 'Does Not Apply',
    'Drain Placement': (p) => {
      const v = attr(p).drain_hole_location ?? '';
      return DRAIN_ALIAS[String(v).toLowerCase().trim()] ?? v;
    },
    'Drain Diameter': (p) => attr(p).drain_diameter_in ?? '',
    'Overall Width from Front to Back': (p) => attr(p).external_dimensions_in?.width ?? '',
    'Overall Length - End to End': (p) => attr(p).external_dimensions_in?.length ?? '',
    'Overall Height - Top to Bottom': (p) => attr(p).external_dimensions_in?.depth ?? '',
    'Base/Stand Height from Top to Bottom': (p) => attr(p).external_dimensions_in?.depth ?? '',
    // Vessel sinks have no internal dims in the PIM — the basin IS the sink,
    // so fall back to the external dimensions.
    'Basin Width - Front to Back': (p) => attr(p).internal_dimensions_in?.width ?? attr(p).external_dimensions_in?.width ?? '',
    'Basin Length - Side to Side': (p) => attr(p).internal_dimensions_in?.length ?? attr(p).external_dimensions_in?.length ?? '',
    'Basin Depth - Top to Bottom': (p) => attr(p).internal_dimensions_in?.depth ?? attr(p).external_dimensions_in?.depth ?? '',
    'NSF/ANSI 61 Certified': () => 'No',
  },
};
