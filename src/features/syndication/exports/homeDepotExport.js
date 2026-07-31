import {
  openTemplate,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  indexToCol,
  injectRows,
  downloadZip,
  templateExt,
  norm,
  fetchImagesBySku,
  fetchDocsBySku,
} from './templateFiller';

// Fills a Home Depot USA (Mirakl) template in place.
//
// Layout ("Data" sheet): R1 = display labels, R2 = attribute GUID codes,
// data starts R3. Closed lists live on "ReferenceData": each column is headed
// by an attribute GUID with its allowed values below — values are snapped
// against them per column. The "Columns" sheet carries requiredness per
// Product Category (collection); it's documentation, not needed to fill.
//
// v1 covers the Kitchen Faucets file (collections: Beverage Faucets /
// Pot Filler / Pull Down / Pull Out). Rules are keyed by normalized label,
// so shared identity/compliance labels carry over to future HD categories.

const HD_DOC_TYPES = {
  spec_sheet: 'spec_sheet',
  installation_manual: 'installation_manual',
  installation_dual_mount: 'installation_manual',
  installation_undermount: 'installation_manual',
  installation_drop_in: 'installation_manual',
  installation_top_mount: 'installation_manual',
  warranty_file: 'warranty_file',
  owner_manual: 'owner_manual',
};

const attr = (p) => p.attributes || {};
const num = (v) => {
  if (v == null || v === '') return '';
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? m[0] : '';
};
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const stripHtml = (h) =>
  String(h || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{2,}/g, '\n')
    .trim();
const brandMap = (b) => (/azuni/i.test(b || '') ? 'AZUNI' : 'Stylish');
const docUrl = (p, kind) => (p._docs ?? []).find((d) => d.raw === kind)?.url ?? '';
// Sink manuals split by installation type in the PIM — HD has ONE slot, so
// pick by relevance: dual-mount manual covers both, then the specific ones.
const INSTALL_DOC_ORDER = ['installation_manual', 'installation_dual_mount', 'installation_undermount', 'installation_drop_in', 'installation_top_mount'];
const installDocUrl = (p) => {
  for (const k of INSTALL_DOC_ORDER) {
    const u = docUrl(p, k);
    if (u) return u;
  }
  return '';
};

// HD faucet collection from the PIM's product_type/spray wording.
const faucetCollection = (p) => {
  const t = `${p.product_type ?? ''} ${attr(p).spout_type ?? ''} ${attr(p).spray_type ?? ''}`;
  if (/pot ?filler/i.test(t)) return 'Pot Filler';
  if (/pull.?out/i.test(t)) return 'Pull Out';
  if (/beverage|bar |drinking|filtration|water filter/i.test(t)) return 'Beverage Faucets';
  return 'Pull Down';
};

// Resolve the template's Product Category (full collection path) for any
// product: derive family + mount terms, then pick the path matching most.
// Covers the Faucets file (4 collections) and the Sinks file (Bar/Bathroom/
// Kitchen Sinks × mount, 8 collections).
const hdCollection = (p, categories) => {
  if (!categories?.length) return '';
  const t = `${p.product_type ?? ''} ${[attr(p).installation_type ?? []].flat().join(' ')} ${attr(p).mounting_type ?? ''}`;
  const terms = [];
  if (/sink/i.test(p.category ?? '')) {
    terms.push(/bath/i.test(p.category) ? 'Bathroom Sinks' : /bar/i.test(t) ? 'Bar Sinks' : 'Kitchen Sinks');
    if (/vessel/i.test(t)) terms.push('Vessel');
    else if (/dual/i.test(t)) terms.push('Dual Mount');
    else if (/farm|apron/i.test(t)) terms.push('Farmhouse');
    else if (/drop|top.?mount/i.test(t)) terms.push('Drop-in');
    else terms.push('Undermount');
  } else {
    terms.push('Faucets', faucetCollection(p));
  }
  let best = categories[0];
  let bestScore = -1;
  for (const c of categories) {
    const lc = c.toLowerCase();
    const score = terms.reduce((n, w) => n + (lc.includes(w.toLowerCase()) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
};

// GTIN = the UPC with "00" prefixed (HD correction, 2026-07-29).
const gtin14 = (p) => {
  const upc = String(attr(p).upc ?? '').replace(/\D/g, '');
  return upc ? `00${upc}` : '';
};

// HD's GLN is one account-wide constant (HD correction, 2026-07-29).
const HD_GLN = '0840994000057';

// Business confirmed "No" for BOTH sinks and faucets (2026-07-30) on the
// per-jurisdiction VOC questions and plastic/resin.
const alwaysNo = () => 'No';

// Hard caps from HD content review: cut at a word boundary within `max`.
const clamp = (text, max) => {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : s.slice(0, max)).trim();
};

const colorFamily = (finish) => {
  const f = String(finish || '');
  if (/stainless|chrome|nickel|silver|steel/i.test(f)) return 'Stainless Steel';
  if (/white/i.test(f)) return 'White';
  if (/black|gunmetal/i.test(f)) return 'Black';
  if (/gold|brass/i.test(f)) return 'Gold';
  if (/bronze|copper/i.test(f)) return 'Bronze';
  if (/gr[ae]y|graphite/i.test(f)) return 'Gray';
  return f;
};

// HD's Finish Family is a DIFFERENT closed list per file: the faucets one has
// finish names (Matte Black, Brushed Gold…), the sinks one has treatments
// (Matte, Gloss, Stainless Steel…) — every value below is verified against
// the respective ReferenceData tab.
const finishFamily = (p) => {
  const f = String(p.finish || '');
  if (/sink/.test(p.category ?? '')) {
    const m = String(attr(p).material ?? p.material ?? '');
    if (/stainless/i.test(f) || /stainless/i.test(m)) return 'Stainless Steel';
    if (/porcelain|fireclay|ceramic/i.test(m)) return 'High Gloss';
    if (/granite|composite|quartz/i.test(m)) return 'Matte';
    if (/gloss/i.test(f)) return 'High Gloss';
    if (/matte/i.test(f)) return 'Matte';
    return '';
  }
  if (/matte black/i.test(f)) return 'Matte Black';
  if (/stainless/i.test(f)) return 'Stainless Steel';
  if (/brushed gold|satin gold/i.test(f)) return 'Brushed Gold';
  if (/gunmetal|matte gr[ae]y/i.test(f)) return 'Matte Gray';
  if (/polished chrome/i.test(f)) return 'Polished Chrome';
  if (/chrome/i.test(f)) return 'Brushed Chrome';
  if (/brushed nickel/i.test(f)) return 'Brushed Nickel';
  if (/nickel/i.test(f)) return 'Polished Nickel';
  return f;
};

// Keyed by normalized R1 label. Scalars fill EVERY occurrence of a repeated
// label (HD repeats e.g. "Features" once per collection — only one applies).
export const HOME_DEPOT_RULES = {
  'Product Category': (p, ctx) => hdCollection(p, ctx.categories),
  'Shop SKU': (p) => p.sku,
  'Product Name (120)': (p) => (attr(p).general_title_en || p.model_name || p.sku).slice(0, 120),
  'UPC': (p) => attr(p).upc || '',
  'globalTradeItemNumber (GTIN)': gtin14,
  'GLN': () => HD_GLN,
  'MFG Model #': (p) => p.sku,
  'MFG Part #': (p) => p.sku,
  'MFG Brand Name': (p) => brandMap(p.brand),
  'Item Weight (lb)': (p) => num(attr(p).product_weight_lb),
  'Packaged Depth (in) (in)': (p) => num(attr(p).shipping_dimensions_in?.length),
  'Packaged Width (in) (in)': (p) => num(attr(p).shipping_dimensions_in?.width),
  'Packaged Height (in) (in)': (p) => num(attr(p).shipping_dimensions_in?.height),
  'Packaged Gross Weight (lb) (lb)': (p) => num(p.shipping_weight_lb),
  'Is this product sold exclusively to and by The Home Depot?': () => 'No',
  'Is this a new version of an existing item?': () => 'No',
  'COUNTRY OF ORIGIN': (p) => (/china|^cn$/i.test(attr(p).country_of_origin || 'China') ? 'CN' : ''),
  'Country of Origin Name': (p) => (/china|^cn$/i.test(attr(p).country_of_origin || 'China') ? 'CHINA' : ''),
  'Sellable Unit?': () => 'Y',
  'Sell Pkg Qty (as sold to consumer)': () => '1',
  'Sell UOM (as sold to consumer)': () => 'EA-Each',
  'Made-To-Order': () => 'No',
  'Number of Boxes Shipped to Consumer': () => '1',
  // 'Vendor Processing Days': HD-account term — business fills it.

  // Highlights cap at 65 chars, marketing copy at 1000 (HD content review;
  // the header still says 1500 but HD trims at 1000).
  'Product Highlight 1': (p) => clamp(list(attr(p).bullet_points)[0] ?? '', 65),
  'Product Highlight 2': (p) => clamp(list(attr(p).bullet_points)[1] ?? '', 65),
  'Product Highlight 3': (p) => clamp(list(attr(p).bullet_points)[2] ?? '', 65),
  'Marketing Copy (1500)': (p) => clamp(stripHtml(p.description), 1000),

  // Images are NOT rule-mapped: they flow into CONSECUTIVE columns starting
  // at "Product Image", ignoring the per-view headers — see the fill loop.

  // Hazmat / compliance — constants for our faucet catalog.
  'Does the item contain Mercury (ex: fluorescent light bulb, HVAC, switch, thermostat)?': () => 'N',
  'Is the item a liquid or contain a liquid (this does not include appliances or heaters that contain totally enclosed liquids)?': () => 'N',
  'Is the item a chemical / solvent or contain a chemical / solvent?': () => 'N',
  'Is the item an aerosol or contain an aerosol?': () => 'N',
  'Is the item a pesticide or contain a pesticide, herbicide, fungicide?': () => 'N',
  'Is the item or does the item contain a battery (lithium, alkaline, lead-acid, etc.)?': () => 'N',
  'Is the item or does the item contain a compressed gas?': () => 'N',
  'Are your products labeled with age - grading or otherwise packaged, labeled or marketed for children?': () => 'No',
  'Is your product intended to be put into children’s mouths, intended to be applied to children’s bodies, or is it mouthable (able to be sucked or chewed) by children under 3 years of age?': () => 'No',
  'Is your product primarily designed and intended for children 12 years of age and under?': () => 'No',
  'Will children be exposed to your product for more than an hour (Ex. clothing, footwear, jewelry, certain toys)?': () => 'No',
  'Is this product regulated by a type of VOC guideline or rule at the state level?': () => 'No',
  // Per-jurisdiction VOC questions + plastic/resin — business confirmed "No"
  // for sinks AND faucets. Their follow-up columns (Categorize/Level/UOM/
  // Exempt) stay blank, consistent with a No.
  'Is this type of product regulated for VOC level by California Code of Regulations for Consumer Products?': alwaysNo,
  'Is this type of product regulated by Delaware for VOC content limits for architectural coatings or consumer products?': alwaysNo,
  'Is this type of product regulated by Maryland for VOC content limits for architectural and industrial maintenance coatings or control of emissions of VOC from consumer products?': alwaysNo,
  'Is this type of product regulated by New Hampshire for VOC limits for Consumer Products?': alwaysNo,
  'Is this type of product regulated for VOC level by California SCAQMD?': alwaysNo,
  'Does your product contain plastic or resin?': alwaysNo,
  'Proposition 65 warning required?': () => 'No',
  'Is your product a textile, or does it contain a textile article, as described in California AB1817 (the Safer Clothing and Textiles Act)?': () => 'No',
  // This one's list is Y/N, unlike its sibling questions.
  'Does this product contain electronic equipment (does it contain a circuit board, computer chip, copper wiring, or other electrical components)?': () => 'N',
  'Is this item governed by the Textile and Wool Labeling Act as administered by the Federal Trade Commission?': () => 'No',

  // Documents
  'Warranty': (p) => docUrl(p, 'warranty_file'),
  'Installation Guide': installDocUrl,
  'Use and Care Manual': (p) => docUrl(p, 'owner_manual'),
  'Specification': (p) => docUrl(p, 'spec_sheet'),

  // Faucet attributes
  'Faucet Type': (p) => {
    const c = faucetCollection(p);
    return c === 'Beverage Faucets' ? 'Beverage Faucet' : c; // list option is singular
  },
  'Commercial / Residential': () => 'Residential',
  'Manufacturer Warranty': (p) => {
    const parts = [attr(p).warranty_length, attr(p).warranty].filter(Boolean);
    return parts.length ? `${parts.join(' ')} warranty`.replace(/\s+/g, ' ') : '';
  },
  'Faucet Height (in.) (in)': (p) => num(attr(p).faucet_height_in ?? attr(p).external_dimensions_in?.height),
  'Flow rate (gallons per minute)': (p) => num(attr(p).max_flow_rate),
  'Color Family': (p) => colorFamily(p.finish),
  'Color/Finish': (p) => p.finish || '',
  'Finish Family': finishFamily,
  // Never blank on a list column — "No Certifications or Listings" is an option.
  'Certifications and Listings': (p) =>
    attr(p).cupc_certified || attr(p).upc_certified
      ? 'UPC Certified (Uniform Plumbing Code)'
      : 'No Certifications or Listings',
  // Faucets ship with their mounting kit (hoses/supply lines confirm it).
  'Included Components': (p) =>
    attr(p).supply_line_included || attr(p).hose_included ? 'All Mounting Hardware' : '',
  // The list is textual ("1 Handle"), not numeric.
  'Number of Faucet Handles': (p) => `${num(attr(p).number_of_handles) || '1'} Handle`,
  'Mount Location': (p) => (/wall/i.test(attr(p).mounting_type || '') ? 'Wall Mount' : 'Deck Mount'),
  'Sensor Activation': (p) => {
    const t = `${attr(p).spray_function_activation ?? ''} ${attr(p).spray_type ?? ''}`;
    if (/touchless|sensor|motion/i.test(t)) return 'Touchless';
    if (/touch/i.test(t)) return 'Touch';
    return 'No Sensor';
  },
  // "Features" repeats once per collection with a DIFFERENT list each time
  // (the kitchen-sinks one has Workstation/Zero Radius/Low Divide, the
  // bathroom one has Rust/Scratch Resistant…). The rule returns ordered
  // CANDIDATES; each column takes the first one its own list accepts.
  'Features': (p) => {
    if (/sink/i.test(p.category ?? '')) {
      const acc = list(attr(p).accessories_included).join(' ');
      const m = `${attr(p).material ?? p.material ?? ''}`;
      const cands = [];
      if (/workstation/i.test(`${p.product_type ?? ''} ${acc}`)) cands.push('Workstation');
      if (num(attr(p).sink_radius_mm) === '0') cands.push('Zero Radius');
      if (attr(p).low_divider) cands.push('Low Divide');
      if (attr(p).sink_radius_mm != null) cands.push('Tight Radius');
      if (/stainless/i.test(m)) cands.push('Rust Resistant');
      if (/granite|composite|quartz|porcelain|fireclay/i.test(m)) cands.push('Scratch Resistant');
      cands.push('No Additional Features');
      return cands;
    }
    const c = faucetCollection(p);
    if (c === 'Pull Down') return ['Pull Down Spray Wand', 'Gooseneck', 'No Additional Features'];
    if (c === 'Pull Out') return ['Pull Out Spray Wand', 'Pull out sprayer', 'No Additional Features'];
    return ['No Additional Features'];
  },
  'Spout Swivel Type': (p) => {
    const sw = String(attr(p).swivel_spout ?? '');
    if (!sw || /^no/i.test(sw)) return 'Fixed';
    // Degrees aren't a PIM field — recover them from the bullets when stated.
    const deg = String(list(attr(p).bullet_points).join(' ')).match(/(\d{2,3})\s*(?:°|degree)/i);
    return deg ? `${deg[1]} Degree Spout Swivel` : '';
  },
  'Faucet Hole Spacing': (p) =>
    num(attr(p).number_of_installation_holes) === '1' ? 'No Spacing - Single Hole' : '',
  'Faucet Hole Fit': (p) => {
    const n = num(attr(p).number_of_installation_holes);
    return n === '1' ? 'Single Hole' : n ? `${n} Hole` : '';
  },

  // ---- Sinks file (Kitchen / Bathroom / Bar Sinks collections) ----
  // List values verified against ReferenceData ("Kitchen Sink" is singular).
  'Kitchen Product Type': (p) => (/^kitchen/i.test(p.category ?? '') ? 'Kitchen Sink' : ''),
  'Sink Shape': (p) => attr(p).sink_shape || '',
  'Mount Type': (p) => {
    const t = `${p.product_type ?? ''} ${[attr(p).installation_type ?? []].flat().join(' ')} ${attr(p).mounting_type ?? ''}`;
    if (/dual/i.test(t)) return 'Drop-In/Undermount';
    if (/farm|apron/i.test(t)) return 'Farmhouse/Apron-Front';
    if (/vessel/i.test(t)) return 'Drop-In/Topmount';
    if (/drop|top.?mount/i.test(t)) return 'Drop-In';
    if (/wall/i.test(t)) return 'Wall Mount';
    return 'Undermount';
  },
  'Faucet Included': () => 'Without Faucet',
  // Undermount/vessel sinks carry no faucet holes unless the PIM says so.
  // One occurrence's list spells zero as "0", the other as "None".
  'Number of Faucet Holes': (p) => {
    const n = num(attr(p).number_of_faucet_holes);
    return n && n !== '0' ? [n] : ['0', 'None'];
  },
  // HD's list is textual ("50/50 Double Bowl", not "2").
  'Number of Bowls': (p) => {
    const n = Number(num(attr(p).number_of_bowls));
    if (!n) return '';
    if (n === 1) return 'Single Bowl';
    if (n >= 3) return 'Triple Bowl';
    const split = String(attr(p).basin_split ?? '').match(/\d{2}\/\d{2}/)?.[0];
    return split ? `${split} Double Bowl` : 'Double Bowl';
  },
  'Bowl Split': (p) => {
    const n = Number(num(attr(p).number_of_bowls));
    if (n === 1) return 'No Split';
    return String(attr(p).basin_split ?? '').match(/\d{2}\/\d{2}/)?.[0] ?? '';
  },
  // Non-steel sinks (granite composite, porcelain) have no gauge — the list
  // has an explicit option for that instead of leaving the cell blank.
  'Sink Gauge': (p) => {
    const g = num(attr(p).gauge);
    return g ? `${g} Gauge` : 'No Gauge Applicable';
  },
  // "Sink Material" list says "Granite Composite"; the generic "Material"
  // list only has "Composite". PIM stores "Composite Granite".
  'Sink Material': (p) => {
    const m = String(attr(p).material ?? p.material ?? '');
    if (/granite|composite/i.test(m)) return 'Granite Composite';
    return m || (num(attr(p).gauge) ? 'Stainless Steel' : '');
  },
  'Material': (p) => {
    const m = String(attr(p).material ?? p.material ?? '');
    if (/sink/.test(p.category ?? '') && /granite|composite/i.test(m)) return 'Composite';
    return m || (num(attr(p).gauge) ? 'Stainless Steel' : '');
  },
  // HD sink axes: Length = left-to-right (PIM length), Width = front-to-back
  // (PIM width), Depth = top-to-bottom (PIM depth/height).
  'Sink Left to Right Length (in.) (in)': (p) => num(attr(p).external_dimensions_in?.length),
  'Sink Front to Back Width (in.) (in)': (p) => num(attr(p).external_dimensions_in?.width),
  'Sink Top to Bottom Depth (in.) (in)': (p) =>
    num(attr(p).external_dimensions_in?.depth ?? attr(p).external_dimensions_in?.height),
  'Bathroom Sink Left to Right Length (In.)': (p) => num(attr(p).external_dimensions_in?.length),
  'Bathroom Sink Front to Back Width (In.)': (p) => num(attr(p).external_dimensions_in?.width),
  'Bathroom Sink Top to Bottom Depth (in.)': (p) =>
    num(attr(p).external_dimensions_in?.depth ?? attr(p).external_dimensions_in?.height),
  'Cut-Out Width (in.) (in)': (p) => num(attr(p).cut_out_dimensions_in?.length),
  'Cut-Out Depth (in.) (in)': (p) => num(attr(p).cut_out_dimensions_in?.width),
  // The list only has whole inches — a 29.25" minimum means the next size up.
  'Minimum Cabinet Size (in.)': (p, ctx, options) => {
    const v = Number(num(attr(p).min_external_cabinet_size_in));
    if (!v) return '';
    const need = Math.ceil(v);
    const ladder = (options ?? []).map(Number).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    const hit = ladder.find((x) => x >= need);
    return String(hit ?? need);
  },
  // PIM wording → HD's closed list (no "Rear Center" / "Side Drain" options).
  'Drain Location': (p) => {
    const d = String(attr(p).drain_hole_location ?? '');
    if (!d) return '';
    if (/side|reversible/i.test(d)) return 'Reversible';
    if (/rear|back/i.test(d)) return 'Rear';
    if (/center/i.test(d)) return 'Center';
    if (/front/i.test(d)) return 'Front';
    if (/left/i.test(d)) return 'Left';
    if (/right/i.test(d)) return 'Right';
    return d;
  },
  // Stylish sinks have no overflow (kitchen never does; bathroom models here
  // don't either) — override via the overflow_location attribute if one ever does.
  'Overflow location': (p) => (/sink/i.test(p.category ?? '') ? attr(p).overflow_location || 'None' : ''),
  'Drain Finish': (p) => (/stainless/i.test(p.finish || '') ? 'Stainless' : ''),
  // Repeated per collection with different lists — ordered candidates.
  'Included': (p) => {
    const acc = list(attr(p).accessories_included).join(' ');
    const cands = [];
    if (/strainer/i.test(acc) || attr(p).strainer_model) cands.push('Strainer Basket', 'Strainer');
    if (/grid/i.test(acc) || attr(p).includes_grids) cands.push('Bottom Grids');
    if (/rack/i.test(acc)) cands.push('Drying Rack');
    cands.push('Mounting Hardware');
    return cands;
  },
};

// Bullet01..Bullet22 all pull from bullet_points in order.
for (let i = 1; i <= 22; i++) {
  const label = `Bullet${String(i).padStart(2, '0')}`;
  HOME_DEPOT_RULES[label] = (p) => list(attr(p).bullet_points)[i - 1] ?? '';
}

const snapTo = (value, options) => {
  if (!options?.length || value === '' || value == null) return value;
  return options.find((o) => norm(o) === norm(value)) ?? value;
};

const isOption = (value, options) => options.some((o) => norm(o) === norm(value));

// Resolve a rule result against ONE column's ReferenceData list. Rules may
// return an array of candidates (ordered by preference) because repeated
// labels carry a different list per collection — each occurrence takes the
// first candidate its own list accepts. A scalar that isn't in the column's
// list is dropped (that occurrence belongs to another collection).
const resolveForColumn = (v, options) => {
  const candidates = Array.isArray(v) ? v.filter((c) => c !== '' && c != null) : [v];
  if (!candidates.length) return null;
  if (!options?.length) return candidates[0];
  for (const c of candidates) {
    const snapped = snapTo(c, options);
    if (isOption(snapped, options)) return snapped;
  }
  return null;
};

/**
 * Fill a Home Depot USA (Mirakl) template (in place) and download it.
 *
 * @param {string} templateStoragePath  path in the `templates` bucket
 * @param {Object[]} products           full product rows
 * @param {string} [fileName]
 */
export async function generateHomeDepotFromTemplate(templateStoragePath, products, fileName = 'HomeDepot_Export') {
  if (!products?.length) throw new Error('No products to export.');

  const { zip, shared } = await openTemplate(templateStoragePath);
  const tplPath = await sheetPathByName(zip, 'Data');
  if (!tplPath) throw new Error('The file has no "Data" sheet — is this a Home Depot (Mirakl) template?');
  const sheetXml = await zip.file(tplPath).async('string');
  const grid = sheetToGrid(sheetXml, shared);

  const labels = grid[0] || [];
  const guids = grid[1] || [];
  const DATA_ROW = 3;
  if (!labels.filter(Boolean).length) throw new Error('Could not read the Home Depot label row.');

  // ReferenceData: GUID-headed columns of allowed values, for snapping.
  const validByGuid = {};
  const refPath = await sheetPathByName(zip, 'ReferenceData');
  if (refPath) {
    const ref = sheetToGrid(await zip.file(refPath).async('string'), shared);
    (ref[0] || []).forEach((guid, ci) => {
      if (!guid) return;
      const vals = [];
      for (let r = 1; r < ref.length; r++) {
        const v = ref[r]?.[ci];
        if (v != null && v !== '') vals.push(String(v));
      }
      if (vals.length) validByGuid[String(guid)] = vals;
    });
  }
  const ctx = {
    // Collection strings for Product Category come from its own value list.
    categories: validByGuid[String(guids[0] ?? '')] ?? [],
  };

  const skus = products.map((p) => p.sku);
  const imgBySku = await fetchImagesBySku(skus);
  const docBySku = await fetchDocsBySku(skus, HD_DOC_TYPES, Object.keys(HD_DOC_TYPES));

  // Image URLs land in CONSECUTIVE columns starting at "Product Image",
  // regardless of the per-view headers between it and the last image slot
  // (Left/Right/Top…, Alternate 1-6, Catalog, Lifestyle) — HD wants the
  // links side by side with no gaps. Bounded by the image-column span so a
  // long gallery can never spill into Color Swatch and beyond.
  const imgStart = labels.findIndex((l) => norm(l ?? '') === norm('Product Image'));
  const imgEnd = labels.findIndex((l) => norm(l ?? '') === norm('Lifestyle Image'));
  const imgSlots = imgStart === -1 ? 0 : (imgEnd > imgStart ? imgEnd - imgStart + 1 : 7);

  let rowsXml = '';
  products.forEach((p, pi) => {
    const rowNum = DATA_ROW + pi;
    p._images = (imgBySku[p.sku] || []).map((m) => m.storage_path);
    p._docs = docBySku[p.sku] || [];
    let cells = '';
    for (let ci = 0; ci < labels.length; ci++) {
      // Consecutive image block wins over whatever rule the header may have.
      if (imgStart !== -1 && ci >= imgStart && ci < imgStart + imgSlots) {
        const img = p._images[ci - imgStart];
        if (img) cells += buildCell(`${indexToCol(ci + 1)}${rowNum}`, img);
        continue;
      }
      const label = labels[ci];
      if (!label) continue;
      const rule = HOME_DEPOT_RULES[String(label).trim()];
      if (!rule) continue;
      const opts = validByGuid[String(guids[ci] ?? '')];
      let v;
      // Rules get the column's ReferenceData options as a 3rd arg for
      // numeric-ladder fields (e.g. Minimum Cabinet Size rounds UP to the
      // next available option).
      try { v = rule(p, ctx, opts); } catch { v = ''; }
      if (v === '' || v == null) continue;
      v = resolveForColumn(v, opts);
      if (v === null || v === '') continue;
      cells += buildCell(`${indexToCol(ci + 1)}${rowNum}`, v);
    }
    rowsXml += `<row r="${rowNum}" spans="1:${labels.length}">${cells}</row>`;
  });

  zip.file(tplPath, injectRows(sheetXml, rowsXml, DATA_ROW - 1 + products.length));
  await downloadZip(zip, fileName, templateExt(templateStoragePath));

  return { count: products.length };
}
