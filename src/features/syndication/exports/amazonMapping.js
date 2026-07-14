// Amazon flat-file mapping (PIM → template labels).
//
// Rules are keyed by the template's LABEL row (declared by the settings string
// as labelRow). Repeated labels (Bullet Point ×5, Other Image URL ×8, Material
// ×5…) take an ARRAY: occurrence N of the label gets array[N-1]. Scalar rules
// fill only the first occurrence.
//
// Values are snapped against the template's Valid Values sheet by the
// generator, so rules return the *intended* value ("Stylish", "Undermount")
// and the exact casing comes from the template.

const attr = (p) => p.attributes || {};
const num = (v) => {
  if (v == null || v === '') return '';
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? m[0] : '';
};
const stripHtml = (h) =>
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
// Valid Values for Brand Name are exactly "Stylish" / "AZUNI".
const brandMap = (b) => (/azuni/i.test(b || '') ? 'AZUNI' : 'Stylish');
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const dropDNA = (v) => (/does\s*no\w*\s*appl/i.test(String(v ?? '')) ? '' : String(v ?? ''));

const installationType = (p) => {
  // Kitchen sinks carry it in product_type / installation_type; bathroom sinks
  // in the mounting_type attribute.
  const t = `${p.product_type ?? ''} ${[attr(p).installation_type ?? []].flat().join(' ')} ${attr(p).mounting_type ?? ''}`;
  if (/dual/i.test(t)) return 'Dual Mount';
  if (/under/i.test(t)) return 'Undermount';
  if (/drop/i.test(t)) return 'Drop-In';
  if (/vessel/i.test(t)) return 'Vessel';
  if (/wall/i.test(t)) return 'Wall Mount';
  if (/farmhouse|apron/i.test(t)) return 'Farmhouse';
  return '';
};

// Documents land in Amazon's Compliance Media columns (one per doc kind).
const docUrl = (p, kind) => (p._docs ?? []).find((d) => d.raw === kind)?.url ?? '';

export const AMAZON_RULES = {
  // ---- Listing Identity ----
  'SKU': (p) => p.sku,
  // Product Type is template-specific (SINK, …) — resolved by the generator
  // from the Valid Values sheet, which lists exactly one option.
  'Listing Action': () => 'Create or Replace (Full Update)',

  // ---- Product Identity ----
  'Item Name': (p) => attr(p).general_title_en || p.model_name || p.sku,
  'Brand Name': (p) => brandMap(p.brand),
  'Product Id Type': (p) => (attr(p).upc ? 'UPC' : ''),
  'Product Id': (p) => attr(p).upc || '',
  'Model Number': (p) => p.sku,
  'Model Name': (p) => p.model_name || '',
  'Manufacturer': (p) => brandMap(p.brand),

  // ---- Images (primary first; the generator attaches p._images) ----
  'Main Image URL': (p) => (p._images ?? [])[0] ?? '',
  'Other Image URL': (p) => (p._images ?? []).slice(1, 9),

  // ---- Product Details ----
  'Product Description': (p) => stripHtml(p.description),
  'Bullet Point': (p) => list(attr(p).bullet_points).slice(0, 5),
  'Style': (p) => p.series || '',
  'Material': (p) => list(attr(p).material ?? p.material).slice(0, 5),
  'Color': (p) => p.finish || '',
  'Size': (p) => {
    const d = attr(p).external_dimensions_in ?? {};
    return d.length && d.width ? `${d.length}"L x ${d.width}"W` : '';
  },
  'Item Shape': (p) => attr(p).sink_shape || attr(p).overall_shape || '',
  'Care Instructions': (p) => list(attr(p).product_care).slice(0, 5),
  'Installation Type': installationType,
  'Number of Items': () => '1',
  'Item Package Quantity': () => '1',
  'Unit Count': () => '1',
  'Unit Count Type': () => 'Count',
  'Included Components': (p) => list(attr(p).accessories_included).slice(0, 5),
  'Part Number': (p) => p.sku,
  'Hole Count': (p) => num(attr(p).number_of_faucet_holes),
  'Hole Count Unit': (p) => (num(attr(p).number_of_faucet_holes) ? 'Count' : ''),
  // Amazon axes: Width = side-to-side (PIM length), Depth = front-to-back
  // (PIM width), Height = base-to-top (PIM depth for sinks).
  'Item Width Side To Side': (p) => num(attr(p).external_dimensions_in?.length),
  'Item Width Unit': (p) => (num(attr(p).external_dimensions_in?.length) ? 'Inches' : ''),
  'Item Depth Front To Back': (p) => num(attr(p).external_dimensions_in?.width),
  'Item Depth Unit': (p) => (num(attr(p).external_dimensions_in?.width) ? 'Inches' : ''),
  'Item Height Base to Top': (p) => num(attr(p).external_dimensions_in?.height ?? attr(p).external_dimensions_in?.depth),
  'Item Height Unit': (p) =>
    num(attr(p).external_dimensions_in?.height ?? attr(p).external_dimensions_in?.depth ?? attr(p).faucet_height_in)
      ? 'Inches'
      : '',
  'Item Weight': (p) => num(attr(p).product_weight_lb),
  'Item Weight Unit': (p) => (num(attr(p).product_weight_lb) ? 'Pounds' : ''),

  'Base Width': (p) => num(attr(p).min_external_cabinet_size_in),
  'Base Width Unit': (p) => (num(attr(p).min_external_cabinet_size_in) ? 'Inches' : ''),

  // ---- Faucets (FAUCET template labels) ----
  'Handle Material': (p) => attr(p).handle_material || '',
  'Number of Handles': (p) => num(attr(p).number_of_handles),
  'Mounting Type': (p) => attr(p).mounting_type || '',
  'Maximum Flow Rate': (p) => num(attr(p).max_flow_rate),
  'Maximum Flow Rate Unit': (p) => (num(attr(p).max_flow_rate) ? 'Gallons Per Minute' : ''),
  'Mounting Hole Diameter Decimal Value': (p) => num(attr(p).install_hole_diameter_in),
  'Mounting Hole Diameter Unit': (p) => (num(attr(p).install_hole_diameter_in) ? 'Inches' : ''),
  'Spout Design': (p) => attr(p).spout_type || '',
  'Spout Height': (p) => num(attr(p).spout_height_in),
  'Spout Height Unit': (p) => (num(attr(p).spout_height_in) ? 'Inches' : ''),
  'Spout Reach': (p) => num(attr(p).spout_reach_in),
  // NB: Amazon's label really has two spaces before "Unit".
  'Spout Reach  Unit': (p) => (num(attr(p).spout_reach_in) ? 'Inches' : ''),
  // The faucet template names the overall dims differently than the sink one.
  'Height Top to Bottom': (p) => num(attr(p).faucet_height_in),
  'Number of Pieces': (p) => String(attr(p).number_of_pieces ?? 1),
  'Warranty Type': (p) => attr(p).warranty || 'Limited',
  'Room Type': (p) => (/bath/i.test(p.category ?? '') ? 'Bathroom' : 'Kitchen'),
  'Recommended Uses For Product': (p) => attr(p).application || '',
  'Special Features': (p) => list(attr(p).durability_tags).slice(0, 5),
  // "Brushed Stainless Steel" → "Brushed"; "Matte Black" → "Matte".
  'Finish Type': (p) => {
    const f = String(p.finish ?? '');
    const m = f.match(/^(Brushed|Matte|Polished|Satin|Gloss)/i);
    return m ? m[1] : f;
  },

  // ---- Accessories (CUTTING_BOARD / FOOD_STRAINER templates) ----
  // Amazon names the same physical axes differently per product type; all of
  // these read the accessory's external dimensions (length × width × height).
  // PIM sheets sometimes hold "Does Not Apply" (with typos) — not a valid
  // Amazon value, so treat it as empty.
  'Pattern': (p) => dropDNA(attr(p).pattern),
  'Wood Type': (p) => dropDNA(attr(p).wood_species) || (/bamboo/i.test(p.material ?? '') ? 'Bamboo' : ''),
  'Color Map': (p) => {
    const f = String(p.finish ?? '').toLowerCase();
    if (/black/.test(f)) return 'Black';
    if (/gold/.test(f)) return 'Gold';
    if (/stainless|chrome|silver/.test(f)) return 'Silver';
    if (/brown|bamboo|honey/.test(f)) return 'Brown';
    if (/white/.test(f)) return 'White';
    if (/grey|gray/.test(f)) return 'Grey';
    return '';
  },
  'Item Length Longer Edge': (p) => num(attr(p).external_dimensions_in?.length),
  'Item Width Shorter Edge': (p) => num(attr(p).external_dimensions_in?.width),
  'Item Thickness Bottom to Top': (p) => num(attr(p).external_dimensions_in?.height ?? attr(p).external_dimensions_in?.depth),
  'Item Thickness Unit': (p) => (num(attr(p).external_dimensions_in?.height ?? attr(p).external_dimensions_in?.depth) ? 'Inches' : ''),
  'Length longer horizontal edge at the top': (p) => num(attr(p).external_dimensions_in?.length),
  'Length Unit': (p) => (num(attr(p).external_dimensions_in?.length) ? 'Inches' : ''),
  'Width shorter horizontal edge at the top': (p) => num(attr(p).external_dimensions_in?.width),
  'Width Unit': (p) => (num(attr(p).external_dimensions_in?.width) ? 'Inches' : ''),
  'Height base to top': (p) => num(attr(p).external_dimensions_in?.height ?? attr(p).external_dimensions_in?.depth),
  'Height Unit': (p) => (num(attr(p).external_dimensions_in?.height ?? attr(p).external_dimensions_in?.depth) ? 'Inches' : ''),
  'Item Length': (p) => num(attr(p).external_dimensions_in?.length),
  'Item Length Unit': (p) => (num(attr(p).external_dimensions_in?.length) ? 'Inches' : ''),
  'Item Width': (p) => num(attr(p).external_dimensions_in?.width),
  'Item Width Unit': (p) => (num(attr(p).external_dimensions_in?.width) ? 'Inches' : ''),
  'Item Height': (p) => num(attr(p).external_dimensions_in?.height ?? attr(p).external_dimensions_in?.depth),

  // ---- Offer ----
  'Item Condition': () => 'New',
  // The PIM only carries CAD prices; US templates get a blank List Price
  // until USD pricing lands in the PIM.
  'List Price Currency': (p, ctx) => (p.msrp_cad && ctx?.lang !== 'en_US' ? 'CAD' : ''),
  'List Price': (p, ctx) => (ctx?.lang === 'en_US' ? '' : num(p.msrp_cad)),

  // ---- Shipping ----
  'Item Package Length': (p) => num(attr(p).shipping_dimensions_in?.length),
  'Package Length Unit': (p) => (num(attr(p).shipping_dimensions_in?.length) ? 'Inches' : ''),
  'Item Package Width': (p) => num(attr(p).shipping_dimensions_in?.width),
  'Package Width Unit': (p) => (num(attr(p).shipping_dimensions_in?.width) ? 'Inches' : ''),
  'Item Package Height': (p) => num(attr(p).shipping_dimensions_in?.height),
  'Package Height Unit': (p) => (num(attr(p).shipping_dimensions_in?.height) ? 'Inches' : ''),
  'Package Weight': (p) => num(p.shipping_weight_lb),
  'Package Weight Unit': (p) => (num(p.shipping_weight_lb) ? 'Pounds' : ''),
  'Number of Boxes': () => '1',

  // ---- Safety & Compliance ----
  'Country of Origin': (p) => attr(p).country_of_origin || '',
  'Warranty Description': (p) => {
    const parts = [attr(p).warranty_length, attr(p).warranty].filter(Boolean);
    return parts.length ? [`${parts.join(' ')} warranty`.replace(/\s+/g, ' ')] : [];
  },
  'Are batteries required?': () => 'No',
  'Are batteries included?': () => 'No',
  'Contains Liquid Contents?': () => 'No',
  // Required by Amazon even for inert products; sinks carry no dangerous goods.
  'Dangerous Goods Regulations': () => 'Not Applicable',
  // Confirmed by the business 2026-07-14: no PFAS in the assortment.
  'Contains PFAS': () => 'No',
  'Is This Product Subject To Buyer Age Restrictions': () => 'No',
  'Compliance Media Source Location (en_CA, Specification Sheet)': (p) => docUrl(p, 'spec_sheet'),
  'Compliance Media Source Location (en_CA, Installation Manual)': (p) => docUrl(p, 'installation_manual'),
  'Compliance Media Source Location (en_CA, Warranty)': (p) => docUrl(p, 'warranty_file'),
  'Compliance Media Source Location (en_CA, User Manual)': (p) => docUrl(p, 'owner_manual'),
};
