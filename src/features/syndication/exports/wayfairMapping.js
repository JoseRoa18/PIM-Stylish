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
// Accessory "Color" columns want a plain color, not the finish name.
const COLOR_ALIAS = {
  'brushed stainless steel': 'Silver',
  'stainless steel': 'Silver',
  'brushed gold': 'Gold',
  'matte black': 'Black',
  'matte black with gold': 'Black',
  'graphite black': 'Black',
  grey: 'Grey',
  gray: 'Grey',
  white: 'White',
  // Bamboo boards
  'honey-toned brown': 'Brown',
  'honey toned brown': 'Brown',
  natural: 'Brown',
  bamboo: 'Brown',
};
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
// Wayfair's shape list uses noun forms ("Rectangle"), the PIM adjectives.
const SHAPE_ALIAS = {
  rectangular: 'Rectangle',
  circular: 'Circle',
  round: 'Round',
  square: 'Square',
  oval: 'Oval',
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
  // Designer's Valid Values list is 311 named designers — STYLISH/Azuni are
  // not on it; "Does Not Apply" is the listed option for unbranded design.
  Designer: () => 'Does Not Apply',
  'Amazon Seller SKU': () => '',
  // Pricing
  'Base Cost': () => '', // wholesale — deferred
  'Manufacturer Suggested Retail Price': (p) => p.msrp_cad || '',
  'Minimum Advertised Price': () => '', // business-deferred
  'Everyday B2B Discount Rate': () => '',
  // Marketing
  'Marketing Copy': (p) => stripHtml(p.description),
  // Fulfillment (business defaults)
  'Minimum Order Quantity': () => 1,
  'Force Quantity Multiplier': () => 1,
  'Display Set Quantity': () => 1,
  'Product Weight': (p) => num(attr(p).product_weight_lb || p.shipping_weight_lb),
  'Ship Type': () => 'Small Parcel',
  'Freight Class': () => '', // LTL-only fields; our exports ship small parcel
  'National Motor Freight Class': () => '',
  'Flat Pack': () => 'No',
  'Ship Palletized': () => 'No',
  'Lead Time': () => '24',
  'Replacement Lead Time': () => '24',
  'Carton Weight 1': (p) => num(p.shipping_weight_lb),
  'Carton Height 1': (p) => num(attr(p).shipping_dimensions_in?.height),
  // Wayfair review (kitchen sinks, kitchen faucets AND bathroom faucets all
  // flagged the same inversion): their Width is the box's LONG side (PIM
  // length) and Depth the short one (PIM width).
  'Carton Width 1': (p) => num(attr(p).shipping_dimensions_in?.length),
  'Carton Depth 1': (p) => num(attr(p).shipping_dimensions_in?.width),
  // Attributes
  'Product Type': (p) => (attr(p).number_of_handles == 2 ? 'Double Handle Kitchen Facuet' : 'Single Handle Kitchen Faucet'),
  Material: (p) => {
    const m = attr(p).material || p.material;
    return (Array.isArray(m) ? m : [m])
      .filter(Boolean)
      .map((x) => (/composite granite|granite composite/i.test(x) ? 'Granite' : x))
      .join('; ');
  },
  // The PIM has no durability attribute — derive factual traits from the
  // material (every value verified against the Durability Valid Values list).
  Durability: (p) => {
    const m = String(attr(p).material ?? p.material ?? '');
    if (/stainless/i.test(m)) return 'Rust Resistant; Corrosion Resistant';
    if (/granite|composite|quartz/i.test(m)) return 'Scratch Resistant; Heat Resistant';
    if (/porcelain|fireclay|ceramic|vitreous/i.test(m)) return 'Scratch Resistant; Stain Resistant';
    if (/brass|zinc|metal/i.test(m)) return 'Corrosion Resistant';
    return 'No Durability Features';
  },
  'Spout Type': (p) => alias(SPOUT_ALIAS, attr(p).spout_type),
  'Construction Features': (p) => sprayToConstruction(attr(p).spray_type),
  'Maximum Flow Rate': (p) => num(attr(p).max_flow_rate),
  'Sensor Type': () => 'No Sensor',
  // The list is strictly Residential Use / Non Residential Use — PIM texts
  // like "Commercial and Residential" must collapse to one of them.
  'Supplier Intended and Approved Use': (p) => {
    const a = String(attr(p).application ?? '');
    if (/non.?residential/i.test(a)) return 'Non Residential Use';
    if (/comm/i.test(a) && !/residen/i.test(a)) return 'Non Residential Use';
    return 'Residential Use';
  },
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
  // Business rule (2026-07-30): always No, every product, every template.
  'ADA Compliant': () => 'No',
  'Commercial Warranty': () => 'No',
  'Commercial Warranty Length': (p) => attr(p).commercial_warranty_length || 'Does Not Apply',
  // Valid values are certification levels (1A / 3A or 6A / Does Not Apply) —
  // the PIM only stores yes/no, so anything short of a level is Does Not Apply.
  'ISTA Certified': () => 'Does Not Apply',
  // Compliance/certification questions the business answered No across the
  // board (Wayfair review 2026-07-30). Every value verified against the
  // templates' Valid Values lists.
  'Sustainability & Social Responsibility Certifications (North America Only)': () => 'No',
  'Laminar Flow': () => 'No',
  'ASME A112.19.1/CSA B45.2 - 2018 Compliant': () => 'No',
  'ASME A112.19.3 Compliant': () => 'No',
  'ASSE 1001 Certified': () => 'No',
  'UL 1951 Listed': () => 'No',
  'CSA B45.5/IAPMO Z124 Compliant - Plastic Plumbing Fixtures': () => 'No',
  'Chemical 1': () => '', // Prop 65 — no listed chemicals in our assortment
  'Toxicity 1': () => '',
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

// Numbered image / bullet / video columns are matched by pattern.
export const IMAGE_COL_RE = /^Image File Name or URL (\d+)$/;
export const BULLET_COL_RE = /^Feature Bullet (\d+)$/;
export const VIDEO_COL_RE = /^Video File Name or URL (\d+)$/;

// Variant columns. Variant Type / Group Reference ID are single; Grouping and
// Attribute-Name-On-Site are numbered (1..3). Values come from a per-product
// `_variant` object attached by the generator (needs whole-family context).
export const VARIANT_GROUPING_RE = /^Variant Grouping (\d+)$/;
export const VARIANT_ATTR_NAME_RE = /^Variant Attribute Name On Site (\d+)$/;

// Document columns come in pairs: "Document File Name or URL N" + "Document Type N".
export const DOC_FILE_RE = /^Document File Name or URL (\d+)$/;
export const DOC_TYPE_RE = /^Document Type (\d+)$/;
// PIM product_media.document_type → Wayfair "Document Type" valid value.
// Sink manuals split per installation type in the PIM; Wayfair files them
// all under Installation & Assembly.
export const DOC_TYPE_MAP = {
  spec_sheet: 'Specifications',
  installation_manual: 'Installation & Assembly',
  installation_dual_mount: 'Installation & Assembly',
  installation_undermount: 'Installation & Assembly',
  installation_drop_in: 'Installation & Assembly',
  installation_top_mount: 'Installation & Assembly',
  warranty_file: 'Warranty Information',
  owner_manual: 'Owner Manual',
  cut_out_template: 'Dimensions',
};
// Priority when filling the 3 document slots (spec → install → warranty first).
export const DOC_TYPE_PRIORITY = [
  'spec_sheet',
  'installation_manual',
  'installation_dual_mount',
  'installation_undermount',
  'installation_drop_in',
  'installation_top_mount',
  'warranty_file',
  'owner_manual',
  'cut_out_template',
];

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

// Newer PIM categories reuse the rules of the template family they export to
// (colanders ship on the strainers template, outdoor sinks on kitchen sinks…).
// Wired at the bottom of this file, after WAYFAIR_CATEGORY_RULES is defined.

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
  // Accessories (strainers/colanders 831, soap dispensers, cutting boards…).
  // Axis translation: Wayfair "Width - Side to Side" is the PIM's length
  // (end-to-end); "Depth - Front to Back" is the PIM's width.
  accessory: {
    'Product Type': (p) => {
      const t = `${p.product_type ?? ''} ${attr(p).general_title_en ?? ''} ${p.model_name ?? ''}`;
      if (/strainer/i.test(t)) return 'Basket Strainer';
      if (/colander/i.test(t)) return 'Colander';
      if (/soap|lotion/i.test(t)) return 'Soap Dispenser';
      if (/cutting board|serving board|over the sink|workstation/i.test(t)) return 'Cutting Board';
      if (/drain/i.test(t)) return 'Pop-Up Drain';
      if (/grid/i.test(t)) return 'Sink Grid';
      return p.product_type ?? '';
    },
    Color: (p) => alias(COLOR_ALIAS, p.finish),
    'Color / Finish': (p) => alias(COLOR_ALIAS, p.finish),
    'Total Number of Pieces Included': (p) => String(attr(p).number_of_pieces ?? 1),
    // Product Care is a closed list; PIM texts like "Please refer to the
    // Spec Sheet" aren't options — derive the factual care by material.
    'Product Care': (p) => {
      const c = String(attr(p).product_care ?? '');
      if (/dishwasher/i.test(c)) return 'Dishwasher safe';
      if (/hand ?wash/i.test(c)) return 'Hand wash recommended';
      const m = `${attr(p).material ?? p.material ?? ''}`;
      if (/bamboo|wood/i.test(m)) return 'Hand wash recommended';
      // Present in BOTH the cutting-boards (187) and strainers (831) lists.
      return 'Wash with warm water and soap';
    },
    Handheld: () => 'No',
    'Adjustability Features': () => 'Does Not Apply',
    'BPA Free': (p) => yesNo(attr(p).bpa_free) || 'No',
    'Holiday / Occasion': () => 'No Holiday', // the list's "none" option
    'Personalization or Monogramming': () => 'No',
    // 187's list is Handle(s) / Boundary Markers / No Built-In Features —
    // juice grooves aren't representable on it.
    'Built-In Features': (p) =>
      /handle/i.test(`${attr(p).general_title_en ?? ''} ${p.product_type ?? ''}`)
        ? 'Handle(s)'
        : 'No Built-In Features',
    'Overall Length - End to End': (p) => num(attr(p).external_dimensions_in?.length),
    // Axis semantics depend on the template: when it has a Length column
    // (cutting boards 187), Width means the PIM's width; without one
    // (strainers 831), Width - Side to Side carries the PIM's length.
    'Overall Width - Side to Side': (p, headers) =>
      headers?.has('Overall Length - End to End')
        ? num(attr(p).external_dimensions_in?.width)
        : num(attr(p).external_dimensions_in?.length ?? attr(p).external_dimensions_in?.width),
    // Round items (soap dispensers, strainers) often carry a single footprint
    // dimension — fall back to it so depth isn't blank.
    'Overall Depth - Front to Back': (p) => num(attr(p).external_dimensions_in?.width ?? attr(p).external_dimensions_in?.length),
    'Overall Height - Top to Bottom': (p) => num(attr(p).external_dimensions_in?.height ?? attr(p).external_dimensions_in?.depth),
    'Overall Thickness': (p) => num(attr(p).external_dimensions_in?.height ?? attr(p).external_dimensions_in?.depth),
    'Commercial Warranty': (p) => yesNo(attr(p).commercial_warranty) || 'No',
  },
  kitchen_sink: {
    'Product Type': (p) => (/workstation/i.test(attr(p).general_title_en ?? '') ? 'Kitchen Sink Workstation' : 'Standard Kitchen Sink'),
    'Mounting / Installation': (p) => {
      const t = p.product_type ?? '';
      if (/dual/i.test(t)) return 'Dual Mount';
      if (/under/i.test(t)) return 'Undermount';
      if (/drop/i.test(t)) return 'Drop-In';
      if (isFarmhouse(p)) return 'Farmhouse / Apron';
      // installation_type is a single value since 2026-07-31 (legacy arrays
      // normalized); Wayfair has no Top Mount option — closest is Drop-In.
      const it = [attr(p).installation_type ?? []].flat().filter(Boolean);
      if (it.length > 1 || /dual/i.test(it[0] ?? '')) return 'Dual Mount';
      if (/top/i.test(it[0] ?? '')) return 'Drop-In';
      return it[0] ?? '';
    },
    'Overall Shape': (p) => alias(SHAPE_ALIAS, attr(p).sink_shape),
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

  bathroom_faucet: {
    // 655's Product Type taxonomy (Mono Basin Mixer / Pillar Tap / Bridge /
    // Swivel): our single-handle faucets are mono basin mixers; nothing on
    // the list fits 2-handle widespread sets, so those stay blank.
    'Product Type': (p) => (Number(attr(p).number_of_handles ?? 1) === 1 ? 'Mono Basin Mixer' : ''),
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
    'Overall Shape': (p) => alias(SHAPE_ALIAS, attr(p).sink_shape),
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

// Category aliases: these PIM categories export on another family's template,
// so they use its rules verbatim.
WAYFAIR_CATEGORY_RULES.colander_drying_rack = WAYFAIR_CATEGORY_RULES.accessory;
WAYFAIR_CATEGORY_RULES.outdoor_sink = WAYFAIR_CATEGORY_RULES.kitchen_sink;
WAYFAIR_CATEGORY_RULES.bar_prep_sink = WAYFAIR_CATEGORY_RULES.kitchen_sink;
WAYFAIR_CATEGORY_RULES.laundry_sink = WAYFAIR_CATEGORY_RULES.kitchen_sink;
