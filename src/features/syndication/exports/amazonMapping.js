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
// Manufacturer is the legal entity, not the brand (rule 2026-08-19):
// Stylish products → "Stylish International Inc.", Azuni products → "Azuni".
const manufacturerOf = (b) => (/azuni/i.test(b || '') ? 'Azuni' : 'Stylish International Inc.');
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const dropDNA = (v) => (/does\s*no\w*\s*appl/i.test(String(v ?? '')) ? '' : String(v ?? ''));

// Regulatory contact address, per marketplace (Amazon prints it on the listing
// for GPSR/consumer-safety purposes). Picked by the template's locale.
const MANUFACTURER_CONTACT = {
  en_CA: '85 Thompson Dr, Cambridge, ON N1T 2E4',
  en_US: '4042 Enterprise Way, Flowery Branch, GA 30542, USA',
};

const installationType = (p, ctx) => {
  // Kitchen sinks carry it in product_type / installation_type; bathroom sinks
  // in the mounting_type attribute.
  const t = `${p.product_type ?? ''} ${[attr(p).installation_type ?? []].flat().join(' ')} ${attr(p).mounting_type ?? ''}`;

  // The FAUCET templates offer a completely different list — Centerset /
  // Single Hole / Vessel / Widespread — so the sink vocabulary never matches
  // and the column came out blank. Map from how the faucet decks instead.
  if (ctx?.productType === 'FAUCET') {
    if (/single.?hole|one.?hole/i.test(t)) return 'Single Hole';
    if (/widespread/i.test(t)) return 'Widespread';
    if (/vessel/i.test(t)) return 'Vessel';
    // Anything multi-hole and deck-mounted is a centerset in Amazon's terms.
    if (/two.?holes?|three.?holes?|centerset/i.test(t)) return 'Centerset';
    // Wall-mounted faucets have no option in this list — better blank than wrong.
    return '';
  }

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
  'Manufacturer': (p) => manufacturerOf(p.brand),
  'Manufacturer Contact Information': (p, ctx) =>
    MANUFACTURER_CONTACT[ctx?.lang === 'en_US' ? 'en_US' : 'en_CA'],
  // Sinks are listed as a single unit; faucets ship as a case of one (business
  // call, 2026-08-05). Amazon's own note: "Choose Unit when package hierarchy
  // is not provided or applicable".
  'Package Level': (p, ctx) => (ctx?.productType === 'FAUCET' ? 'Case' : 'Unit'),
  // Part of the Case hierarchy: only meaningful where Package Level is Case.
  'Package Contains SKU Quantity': (p, ctx) => (ctx?.productType === 'FAUCET' ? '1' : ''),
  'Number of Packs': () => '1',

  // ---- Images (primary first; the generator attaches p._images) ----
  'Main Image URL': (p) => (p._images ?? [])[0] ?? '',
  'Other Image URL': (p) => (p._images ?? []).slice(1, 9),

  // ---- Product Details ----
  'Product Description': (p) => stripHtml(p.description),
  'Bullet Point': (p) => list(attr(p).bullet_points).slice(0, 5),
  // Amazon's search terms: five separate cells (generic_keyword #1–#5), one
  // phrase each, in both the .ca (en_CA) and .com (en_US) templates — the label
  // is identical, so this one rule covers all twelve. Not to be confused with
  // 'Item Type Keyword' on the US files, which is product classification.
  'Generic Keyword': (p) => list(attr(p).keywords_en).slice(0, 5),
  // Always Modern — it's one of the 22 options Amazon's Style list allows, and
  // the PIM's `series` (Kelso, Wapta…) is a collection name, never a style.
  'Style': () => 'Modern',
  'Material': (p) => list(attr(p).material ?? p.material).slice(0, 5),
  'Color': (p) => p.finish || '',
  // Faucets have no external dimensions in the PIM, so the sink's L x W left the
  // column empty on all 107 of them — they get height x spout reach instead.
  'Size': (p, ctx) => {
    if (ctx?.productType === 'FAUCET') {
      const h = num(attr(p).faucet_height_in);
      const r = num(attr(p).spout_reach_in);
      return h && r ? `${h}"H x ${r}"D` : '';
    }
    const d = attr(p).external_dimensions_in ?? {};
    return d.length && d.width ? `${d.length}"L x ${d.width}"W` : '';
  },
  // Groups the finishes of one faucet together (the four Fano, the three Modena).
  'Set Name': (p) => p.model_name || '',
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
  // NOTE: 'Item Width Unit' is defined once, in the generic dimensions block
  // below (width-based) — a duplicate key here was shadowed and never ran.
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
  // List Price = MSRP in the template's market currency (USD pricing lives
  // in the PIM since 2026-08).
  'List Price Currency': (p, ctx) =>
    ctx?.lang === 'en_US' ? (p.msrp_usd ? 'USD' : '') : (p.msrp_cad ? 'CAD' : ''),
  'List Price': (p, ctx) => (ctx?.lang === 'en_US' ? num(p.msrp_usd) : num(p.msrp_cad)),

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
  // Only a third of the catalogue carries the attribute, but the whole
  // assortment is made in China — the same fallback the Home Depot exporters
  // already use.
  'Country of Origin': (p) => attr(p).country_of_origin || 'China',
  'Warranty Description': (p) => {
    const parts = [attr(p).warranty_length, attr(p).warranty].filter(Boolean);
    return parts.length ? [`${parts.join(' ')} warranty`.replace(/\s+/g, ' ')] : [];
  },
  // Free text (no Valid Values list) — nothing in the assortment carries a
  // printed safety warning.
  'Safety Warning': () => 'Not Applicable',
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

// ===================== Amazon kitchen sink listing (Canada + USA) =====================
// The user's review of the Canada template (2026-10-06), column by column,
// applied to the USA one too the same day. These rules sit on top of
// AMAZON_RULES only for the two kitchen sink templates (the generator sets
// ctx.kitchenSink and ctx.market 'ca' | 'us'); every other Amazon template
// keeps the rules above. Where the two templates differ, the rule reads the
// template's own list (fulfilment wording) or the market (prices, stock).

const isCompositeGranite = (p) => /composite\s*granite|granite\s*composite/i.test(String(p.material ?? attr(p).material ?? ''));
const installText = (p) => [attr(p).installation_type ?? []].flat().join(' ');
const bowlKind = (p) => {
  const n = Number(attr(p).number_of_bowls);
  const c = String(attr(p).bowl_configuration ?? '');
  if (n >= 2 || /double/i.test(c)) return 'Double Bowl';
  if (n === 1 || /single/i.test(c)) return 'Single Bowl';
  return '';
};
const installLabel = (p) => {
  const t = installText(p);
  if (/dual/i.test(t)) return 'Dual Mount';
  if (/under/i.test(t)) return 'Undermount';
  if (/top/i.test(t)) return 'Top Mount';
  if (/drop/i.test(t)) return 'Drop-In';
  return '';
};

// One installation manual per sink, the one of its own mounting, in English
// or English + French (never the French-only or the Spanish one): Canada
// takes the bilingual one first, the USA the English one.
const INSTALL_SLOTS = {
  'Dual Mount': ['installation_dual_mount', 'installation_undermount', 'installation_drop_in', 'installation_top_mount'],
  Undermount: ['installation_undermount'],
  'Top Mount': ['installation_top_mount', 'installation_drop_in'],
  'Drop-In': ['installation_drop_in', 'installation_top_mount'],
};
const DOC_LANGS = { ca: ['en_fr', 'en', null], us: ['en', 'en_fr', null] };
const englishDoc = (p, kinds, ctx) => {
  for (const kind of kinds) {
    for (const lang of DOC_LANGS[ctx?.market] ?? DOC_LANGS.ca) {
      const d = (p._docs ?? []).find((x) => x.raw === kind && (x.lang ?? null) === lang);
      if (d) return d.url;
    }
  }
  return '';
};
const installManual = (p, ctx) => englishDoc(p, [
  ...(INSTALL_SLOTS[installLabel(p)] ?? []),
  'installation_manual',
  'installation_undermount', 'installation_dual_mount', 'installation_drop_in', 'installation_top_mount',
], ctx);
// Single Bowl / Double Bowl node: Canada's "Recommended Browse Nodes", the
// USA's "Item Type Keyword" — each template lists exactly those two.
const bowlNode = (label) => (p, ctx) => {
  const b = bowlKind(p);
  return b ? (ctx?.validValues?.[label] ?? []).find((o) => o.includes(`> ${b} (`)) ?? '' : '';
};
// Each template's own wording ("Fulfilment" in Canada, "Fulfillment" in the
// USA; their Valid Values rows carry no "- [ … ]" tag, so the generator can't
// snap them). An FBA Seller SKU stays with Amazon.
const isFba = (p) => /fba/i.test(p._amazon?.fulfillment ?? '');
const FULFILMENT = {
  ca: { merchant: 'Fulfilment by Merchant (Default)', amazon: 'Fulfilment by Amazon (NA)' },
  us: { merchant: 'Fulfillment by Merchant (Default)', amazon: 'Fulfillment by Amazon (NA)' },
};
const fulfilment = (market) => (p) => FULFILMENT[market][isFba(p) ? 'amazon' : 'merchant'];
// Our stock in that market; not tracked = 0, as in Rona's stock column.
const quantity = (p) => (isFba(p) ? '' : String(Math.max(0, Math.floor(Number(p._stock?.available) || 0))));

// Search terms: ONE cell, single words, English + French + Spanish, at most
// 250 bytes (a French accent counts twice, so the 250-character limit always
// holds). Composite granite sinks always carry "composite" and "granite".
const KEYWORD_STOP = new Set([
  'a', 'an', 'and', 'the', 'with', 'for', 'of', 'in', 'on', 'to', 'by', 'or', 'x',
  'de', 'du', 'des', 'la', 'le', 'les', 'et', 'pour', 'avec', 'en', 'à', 'au', 'aux', 'un', 'une', 'sur', 'po',
  'stylish', 'azuni',
]);
const words = (phrases) => list(phrases)
  .flatMap((s) => String(s).toLowerCase().split(/[\s,;/()"“”]+/))
  .map((w) => w.replace(/^[-'.]+|[-'.]+$/g, ''))
  .filter((w) => w && !KEYWORD_STOP.has(w) && !/^[\d.]+(in|po|mm|cm)?$/.test(w));
// The PIM has no Spanish keywords: these words describe the sink itself.
const spanishWords = (p) => {
  const out = ['fregadero', 'cocina', 'lavaplatos', 'tarja'];
  const m = String(p.material ?? '');
  if (/stainless/i.test(m)) out.push('acero', 'inoxidable');
  if (isCompositeGranite(p)) out.push('granito', 'compuesto', 'cuarzo');
  const inst = installLabel(p);
  if (inst === 'Undermount' || inst === 'Dual Mount') out.push('submontaje');
  if (inst === 'Drop-In' || inst === 'Top Mount' || inst === 'Dual Mount') out.push('sobreponer');
  const b = bowlKind(p);
  if (b === 'Double Bowl') out.push('doble');
  if (b === 'Single Bowl') out.push('sencillo');
  if (/workstation/i.test(`${p.product_type ?? ''} ${attr(p).general_title_en ?? ''}`)) out.push('estación', 'trabajo');
  if (/farmhouse|apron/i.test(`${p.product_type ?? ''} ${attr(p).general_title_en ?? ''}`)) out.push('granja');
  const f = String(p.finish ?? '').toLowerCase();
  if (/black/.test(f)) out.push('negro');
  if (/white/.test(f)) out.push('blanco');
  if (/gr[ae]y/.test(f)) out.push('gris');
  return out;
};
const MAX_KEYWORD_BYTES = 250;
const genericKeywords = (p) => {
  const bytes = (s) => new TextEncoder().encode(s).length;
  const lists = [words(attr(p).keywords_en), words(attr(p).keywords_fr), spanishWords(p)];
  const seen = new Set();
  let out = '';
  const add = (w) => {
    if (seen.has(w)) return;
    const next = out ? `${out} ${w}` : w;
    if (bytes(next) > MAX_KEYWORD_BYTES) return;
    seen.add(w);
    out = next;
  };
  if (isCompositeGranite(p)) { add('composite'); add('granite'); }
  // Round robin, so the three languages all make it before the limit.
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) add(l[i]);
  return out;
};

// Column letters in the comments are the Canada template's.
export const AMAZON_KITCHEN_SINK_RULES = {
  // A: the listing's Amazon Seller SKU (Aliases tab → Amazon Canada / USA), never ours.
  'SKU': (p) => p._amazon?.sellerSku || p.sku,
  // L (USA: L Item Type Keyword).
  'Recommended Browse Nodes': bowlNode('Recommended Browse Nodes'),
  'Item Type Keyword': bowlNode('Item Type Keyword'),
  // AH: the swatch is the main picture.
  'Swatch Image URL': (p) => (p._images ?? [])[0] ?? '',
  'Generic Keyword': genericKeywords,
  // AU: composite granite is listed as Quartz.
  'Material': (p) => (isCompositeGranite(p) ? ['Quartz'] : list(attr(p).material ?? p.material).slice(0, 5)),
  // BQ: every component in one cell, one per line.
  'Included Components': (p) => list(attr(p).accessories_included).join('\n'),
  // CF: every sink drains through a grid strainer.
  'Drain Type': () => 'Grid',
  // CG / CH: only top-mount sinks, and always one hole.
  'Hole Count': (p) => (installLabel(p) === 'Top Mount' ? '1' : ''),
  'Hole Count Unit': (p) => (installLabel(p) === 'Top Mount' ? 'Holes' : ''),
  // CY: the first two measures + a short description.
  'Set Name': (p) => {
    const d = attr(p).external_dimensions_in ?? {};
    const size = num(d.length) && num(d.width) ? `${num(d.length)}" x ${num(d.width)}"` : '';
    return [size, bowlKind(p), installLabel(p), 'Kitchen Sink'].filter(Boolean).join(' ');
  },
  // CZ: only composite granite sinks.
  'Rock Material Type': (p) => (isCompositeGranite(p) ? 'Granite' : ''),
  'Skip Offer': () => 'No',
  // DG / DH: the list price is MAP Blue of the market (the USA file has no
  // currency column).
  'List Price Currency': (p, ctx) => (ctx?.market === 'us' ? (num(p.map_usd) ? 'USD' : '') : (num(p.map_cad) ? 'CAD' : '')),
  'List Price': (p, ctx) => (ctx?.market === 'us' ? num(p.map_usd) : num(p.map_cad)),
  // EE / EF / FI: shipped by us from that market's stock.
  'Fulfillment Channel Code (CA)': fulfilment('ca'),
  'Fulfillment Channel Code (US)': fulfilment('us'),
  'Quantity (CA)': quantity,
  'Quantity (US)': quantity,
  'Shipping Template (CA)': () => 'ALL CANADA SHIPPING CHARGES',
  // The USA template's one shipping template.
  'Shipping Template (US)': () => 'FBM USA',
  // FR: a "-2" SKU ships in two boxes.
  'Number of Boxes': (p) => (/-2$/.test(p.sku) ? '2' : '1'),
  // FS (the USA template has no Safety Warning column).
  'Safety Warning': () => 'No',
  // GE / HK: left empty (the USA template has no HK).
  'Are batteries included?': () => '',
  'Contains Liquid Contents?': () => '',
  // IN: the installation manual of the sink's own mounting, English or EN-FR
  // (the en_US labels read these en_CA rules).
  'Compliance Media Source Location (en_CA, Installation Manual)': installManual,
  'Compliance Media Source Location (en_CA, Specification Sheet)': (p, ctx) => englishDoc(p, ['spec_sheet'], ctx),
};
