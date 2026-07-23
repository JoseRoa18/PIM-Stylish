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

// HD faucet collection from the PIM's product_type/spray wording.
const faucetCollection = (p) => {
  const t = `${p.product_type ?? ''} ${attr(p).spout_type ?? ''} ${attr(p).spray_type ?? ''}`;
  if (/pot ?filler/i.test(t)) return 'Pot Filler';
  if (/pull.?out/i.test(t)) return 'Pull Out';
  if (/beverage|bar |drinking|filtration|water filter/i.test(t)) return 'Beverage Faucets';
  return 'Pull Down';
};

// UPC-12 → GTIN-14 (left-pad with zeros).
const gtin14 = (p) => {
  const upc = String(attr(p).upc ?? '').replace(/\D/g, '');
  return upc ? upc.padStart(14, '0') : '';
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

// HD's Finish Family closed list — our finishes map near-verbatim.
const finishFamily = (finish) => {
  const f = String(finish || '');
  if (/matte black/i.test(f)) return 'Matte Black';
  if (/stainless/i.test(f)) return 'Stainless Steel';
  if (/brushed gold|satin gold/i.test(f)) return 'Brushed Gold';
  if (/gunmetal|matte gr[ae]y/i.test(f)) return 'Matte Gray';
  if (/chrome/i.test(f)) return 'Brushed Chrome';
  if (/nickel/i.test(f)) return 'Polished Nickel';
  return f;
};

// Keyed by normalized R1 label. Scalars fill EVERY occurrence of a repeated
// label (HD repeats e.g. "Features" once per collection — only one applies).
export const HOME_DEPOT_RULES = {
  'Product Category': (p, ctx) =>
    ctx.categories.find((c) => c.endsWith(`/${faucetCollection(p)}`)) ?? ctx.categories[0] ?? '',
  'Shop SKU': (p) => p.sku,
  'Product Name (120)': (p) => (attr(p).general_title_en || p.model_name || p.sku).slice(0, 120),
  'UPC': (p) => attr(p).upc || '',
  'globalTradeItemNumber (GTIN)': gtin14,
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
  // 'Vendor Processing Days' + 'GLN': HD-account terms — business fills them.

  'Product Highlight 1': (p) => list(attr(p).bullet_points)[0] ?? '',
  'Product Highlight 2': (p) => list(attr(p).bullet_points)[1] ?? '',
  'Product Highlight 3': (p) => list(attr(p).bullet_points)[2] ?? '',
  'Marketing Copy (1500)': (p) => stripHtml(p.description).slice(0, 1500),

  'Product Image': (p) => (p._images ?? [])[0] ?? '',
  'Alternate Image View 1': (p) => (p._images ?? [])[1] ?? '',
  'Alternate Image View 2': (p) => (p._images ?? [])[2] ?? '',
  'Alternate Image View 3': (p) => (p._images ?? [])[3] ?? '',
  'Alternate Image View 4': (p) => (p._images ?? [])[4] ?? '',
  'Alternate Image View 5': (p) => (p._images ?? [])[5] ?? '',
  'Alternate Image View 6': (p) => (p._images ?? [])[6] ?? '',

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
  'Proposition 65 warning required?': () => 'No',
  'Is your product a textile, or does it contain a textile article, as described in California AB1817 (the Safer Clothing and Textiles Act)?': () => 'No',
  'Does this product contain electronic equipment (does it contain a circuit board, computer chip, copper wiring, or other electrical components)?': () => 'No',
  'Is this item governed by the Textile and Wool Labeling Act as administered by the Federal Trade Commission?': () => 'No',

  // Documents
  'Warranty': (p) => docUrl(p, 'warranty_file'),
  'Installation Guide': (p) => docUrl(p, 'installation_manual'),
  'Use and Care Manual': (p) => docUrl(p, 'owner_manual'),
  'Specification': (p) => docUrl(p, 'spec_sheet'),

  // Faucet attributes
  'Faucet Type': (p) => faucetCollection(p),
  'Commercial / Residential': () => 'Residential',
  'Manufacturer Warranty': (p) => {
    const parts = [attr(p).warranty_length, attr(p).warranty].filter(Boolean);
    return parts.length ? `${parts.join(' ')} warranty`.replace(/\s+/g, ' ') : '';
  },
  'Faucet Height (in.) (in)': (p) => num(attr(p).faucet_height_in ?? attr(p).external_dimensions_in?.height),
  'Flow rate (gallons per minute)': (p) => num(attr(p).max_flow_rate),
  'Color Family': (p) => colorFamily(p.finish),
  'Color/Finish': (p) => p.finish || '',
  'Finish Family': (p) => finishFamily(p.finish),
  'Certifications and Listings': (p) =>
    attr(p).cupc_certified ? 'UPC Certified (Uniform Plumbing Code)' : '',
  // Faucets ship with their mounting kit (hoses/supply lines confirm it).
  'Included Components': (p) =>
    attr(p).supply_line_included || attr(p).hose_included ? 'All Mounting Hardware' : '',
  'Number of Faucet Handles': (p) => num(attr(p).number_of_handles) || '1',
  'Mount Location': (p) => (/wall/i.test(attr(p).mounting_type || '') ? 'Wall Mount' : 'Deck Mount'),
  'Sensor Activation': (p) => {
    const t = `${attr(p).spray_function_activation ?? ''} ${attr(p).spray_type ?? ''}`;
    if (/touchless|sensor|motion/i.test(t)) return 'Touchless';
    if (/touch/i.test(t)) return 'Touch';
    return 'No Sensor';
  },
  // "Pull Down Spray Wand"/"Pull Out Spray Wand" are the safe single values
  // from HD's kitchen Features list (multi-value separators are undocumented).
  'Features': (p) => {
    const c = faucetCollection(p);
    if (c === 'Pull Down') return 'Pull Down Spray Wand';
    if (c === 'Pull Out') return 'Pull Out Spray Wand';
    return '';
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

  let rowsXml = '';
  products.forEach((p, pi) => {
    const rowNum = DATA_ROW + pi;
    p._images = (imgBySku[p.sku] || []).map((m) => m.storage_path);
    p._docs = docBySku[p.sku] || [];
    let cells = '';
    for (let ci = 0; ci < labels.length; ci++) {
      const label = labels[ci];
      if (!label) continue;
      const rule = HOME_DEPOT_RULES[String(label).trim()];
      if (!rule) continue;
      let v = '';
      try { v = rule(p, ctx); } catch { v = ''; }
      if (v === '' || v == null) continue;
      v = snapTo(v, validByGuid[String(guids[ci] ?? '')]);
      cells += buildCell(`${indexToCol(ci + 1)}${rowNum}`, v);
    }
    rowsXml += `<row r="${rowNum}" spans="1:${labels.length}">${cells}</row>`;
  });

  zip.file(tplPath, injectRows(sheetXml, rowsXml, DATA_ROW - 1 + products.length));
  await downloadZip(zip, fileName, templateExt(templateStoragePath));

  return { count: products.length };
}
