import { findCountry } from '@/features/products/lib/countries';
import { isFaucetCategory, SINK_CATEGORIES, hasCutOut } from '@/features/products/lib/categories';

// What goes in each column of Menards' Syndigo files, and how a value is made
// to fit the column: no file is read or written here (menardsExport.js does).
//
// The rules are the file Vladimir completed for C234L (2026-11-25, "NEW
// Template to be created.xlsx": Menards Product Content, requirement set 39).
// A product's row answers the same way: what is the company's own with Menards
// is a constant of that file (MENARDS_ACCOUNT), what is the product's comes
// from the PIM, and a column the PIM has nothing for stays empty and is named
// after the export. A column with a list takes one of the file's own entries,
// in the file's own spelling ("Y" in one column, "Yes" in the next).

// The company's account with Menards, the same on every product: the answers
// of Vladimir's file. A change of merchant, terms or carrier is made here.
export const MENARDS_ACCOUNT = {
  'Vendor Number': 'STYLI001',
  Merchant: 'Alexander Perrine (aperrine)|1662206',
  'Associate Merchant': 'Crystine Adams (cadams)|1630168',
  'Sales Unit': 'EACH',
  'Warranty UOM': 'month',
  'Expiration Date Required': false,
  'Payment Terms': 'Net 30 Days',
  'Limited Quantity': false,
  'Min Order Qty - Vendor': 1,
  'Lead Time': 1,
  'Order Lead Time UOM': 'day',
  'Vendor Item Enrichment Needed': 'N/A',
  'Shipping Method': 'OTHER',
  'Ship Combination': true,
  'Retail Pack Qty': 1,
  'Retail Packaging Type': 'Menards.com only-Direct to Guest',
  // "Is the item imported by Menards?" — we are the importer.
  'Imported Flag': false,
  'Container Qty': 1,
  'Import Container Size': 'N/A',
  'Refrigerated Van': false,
  'Heated Van Required': false,
  'Freight Type': 'UNITS',
  'Freight Min Description': '1',
  'Vendor Ships Via': 'FED EX GROUND',
  'Truckload Qty': 0,
  'Retail Nestable': false,
  FOB: 'MENARD',
  DDP: 'N/A',
  'Inner Packaging Type': 'As is product- No Inner Package',
  'Master Pack Qty': 1,
  'Master Cubes Qty': 0,
  'Master Packaging Type': 'Regular-all right angles-Corrugated Box',
  'Pallet Layer Qty': 0,
  'AGA Certified': false,
  // His file declares no certification on a cUPC sink: no mark, no file number.
  'ANSI Compliant': false,
  'Certified Mark Name': 'NOT REQUIRED',
  'Perishable Item': false,
  'Hazard Code Required': false,
  'Prop 65 Item': false,
  'Labeled For Prop 65': 'Not Labeled',
  'OSHA Approved': false,
  'Energy Star': false,
  'Lithium Type': 'Does not Use or Contain Lithium Batteries/Cells',
  'Retail Peggable': false,
};

// The port a country's products leave from, by ISO code. Only what his file
// says: a country without one is left empty and named (Vietnam: not known yet).
const PORT_OF_ORIGIN = { CN: 'China - Guangzhou' };
// "If Country of Origin is US, Canada or Mexico, please populate Port of Origin as None" (the file's own help).
const NO_PORT = new Set(['US', 'CA', 'MX']);

// Duty paid on a tariff code from a country, as a share: only the pair his
// file gives. Any other pair is left empty — a rate is never worked out here.
const DUTY_RATE = { '7324.10.0050|CN': 0.284 };

// Text columns the file caps lower than Menards takes: his Long Description
// has 640 characters where the file says 255.
const NO_CAP = new Set(['Long Description']);

// How an image cell names its picture: 'name' = the file's name, as in his
// file (the pictures are then in Menards' Syndigo library under that name: the
// export hands them over beside the workbook); 'url' = the PIM's public link.
// The user chose the name (2026-11-26); whether Syndigo's import takes a link
// for a product that is new there was not confirmed.
export const MENARDS_IMAGE_CELL = 'name';

const attr = (p) => p.attributes ?? {};
const words = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const flat = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const num = (v) => {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(String(v).match(/-?\d+(\.\d+)?/)?.[0]);
  return Number.isFinite(n) ? n : '';
};
// A size, a weight or a price: a 0 stored in the PIM is a field nobody filled, never a measure to send.
const amount = (v) => { const n = num(v); return n === '' || n <= 0 ? '' : n; };
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const yes = (v) => v === true || /^(yes|y|true)$/i.test(words(v)) || (/(compliant|certified)$/i.test(words(v)) && !/^(no|not|non)\b/i.test(words(v)));
const plain = (html) => words(String(html ?? '')
  .replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|li|h\d|div)>/gi, ' ').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'"));
const titleOf = (p) => words(attr(p).general_title_en);
const isSink = (p) => SINK_CATEGORIES.includes(p.category);
const isFaucet = (p) => isFaucetCategory(p.category);
const countryOf = (p) => findCountry(attr(p).country_of_origin);
export const menardsUpc = (p) => String(attr(p).upc ?? '').replace(/\D/g, '');

// A phrase cut at a word to at most `max` characters.
function cutAtWord(text, max) {
  const t = words(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.5 ? cut.slice(0, at) : t.slice(0, max)).replace(/[\s,;:·/-]+$/, '');
}
const firstThatFits = (candidates, max) => {
  const clean = candidates.map(words).filter(Boolean);
  return clean.find((c) => c.length <= max) ?? cutAtWord(clean[clean.length - 1] ?? '', max);
};

// ---- Description 1: what the product is, in a few words (40 characters) -------
// His C234L reads "Workstation Double Bowl" (Description 2 carries the SKU).
const SHORT_MAX = 40;
const mountOf = (p) => {
  const t = words(`${attr(p).mounting_type ?? ''} ${list(attr(p).installation_type).join(' ')} ${p.product_type ?? ''}`);
  if (/farmhouse|apron/i.test(t)) return 'Farmhouse';
  if (/vessel/i.test(t)) return 'Vessel';
  if (/dual/i.test(t)) return 'Dual Mount';
  if (/under/i.test(t)) return 'Undermount';
  if (/drop|top/i.test(t)) return 'Drop-In';
  return '';
};
const bowlsOf = (p) => {
  const b = words(attr(p).bowl_configuration);
  const n = /triple/i.test(b) ? 3 : /double/i.test(b) ? 2 : /single/i.test(b) ? 1 : num(attr(p).number_of_bowls);
  return n === 3 ? 'Triple Bowl' : n === 2 ? 'Double Bowl' : n === 1 ? 'Single Bowl' : '';
};
const SINK_KIND = { bar_prep_sink: 'Bar/Prep Sink', laundry_sink: 'Laundry Sink', outdoor_sink: 'Outdoor Sink', bathroom_sink: 'Bathroom Sink' };
export function menardsShortName(p) {
  const title = titleOf(p);
  const text = `${p.product_type ?? ''} ${title}`;
  const workstation = /workstation/i.test(text);
  if (p.category === 'kitchen_sink') {
    const lead = workstation ? 'Workstation' : mountOf(p);
    return firstThatFits([`${lead} ${bowlsOf(p)}`, bowlsOf(p), 'Kitchen Sink'].map(words).filter((c) => /\w/.test(c)), SHORT_MAX) || 'Kitchen Sink';
  }
  if (isSink(p)) {
    const kind = /ice chest/i.test(text) ? 'Ice Chest Sink' : /concealed/i.test(text) ? 'Concealed Outdoor Sink' : SINK_KIND[p.category];
    return firstThatFits([`${workstation ? 'Workstation' : mountOf(p)} ${kind}`, kind], SHORT_MAX);
  }
  if (p.category === 'kitchen_faucet_combo') {
    const extra = title.match(/\bwith\s+(.+?)(?:\s*\(|$)/i)?.[1];
    return firstThatFits([extra ? `Kitchen Faucet with ${extra}` : '', 'Kitchen Faucet Combo'], SHORT_MAX);
  }
  if (p.category === 'cold_water_tap') return 'Cold Water Drinking Tap';
  if (p.category === 'pot_filler') return firstThatFits([/wall/i.test(text) ? 'Wall-Mount Pot Filler' : '', 'Pot Filler'], SHORT_MAX);
  if (p.category === 'bathroom_faucet') {
    const kind = /vessel/i.test(text) ? 'Vessel Bathroom Faucet' : /pull.?down/i.test(text) ? 'Pull-Down Bathroom Faucet' : /wall/i.test(text) ? 'Wall-Mount Bathroom Faucet' : 'Bathroom Faucet';
    const handles = num(attr(p).number_of_handles);
    return firstThatFits([`${handles === 1 ? 'Single Handle' : handles === 2 ? 'Two Handle' : ''} ${kind}`, kind], SHORT_MAX);
  }
  if (isFaucet(p)) return firstThatFits([p.product_type, words(p.product_type).replace(/\bsensor\s+/i, ''), 'Kitchen Faucet'], SHORT_MAX);
  // An accessory's model name is what it is ("Over the Sink Colander", "Basket Strainer").
  return firstThatFits([p.model_name, p.product_type, title], SHORT_MAX);
}

// ---- MCOM Short Description: Brand® Model™ and the PIM's title ---------------
// His reads "Azuni&reg; Laval&trade; 32 inch Dual Mount … Kitchen Sink with
// Accessories". A sink or a faucet has a name of its own; an accessory's model
// name is its description ("Workstation Colander") and takes no mark, nor does
// a combo's ("Combo").
export function menardsWebTitle(p) {
  const title = titleOf(p);
  const brand = words(p.brand);
  if (!title || !brand) return '';
  const model = words(p.model_name);
  const named = model && (isSink(p) || isFaucet(p)) && !/^combo$/i.test(model);
  // The title without the brand or the name it may already start with.
  let rest = title;
  for (const lead of [brand, named ? model : '']) {
    if (lead && rest.toLowerCase().startsWith(`${lead.toLowerCase()} `)) rest = rest.slice(lead.length + 1);
  }
  return `${brand}&reg; ${named ? `${model}&trade; ` : ''}${rest}`;
}

// ---- Warranty, in months: "Lifetime" is his 9999 ----------------------------
function warrantyMonths(p) {
  const t = words(attr(p).warranty_length);
  if (/lifetime/i.test(t)) return 9999;
  const m = t.match(/(\d+(?:\.\d+)?)\s*-?\s*(year|month)/i);
  if (!m) return '';
  return /year/i.test(m[2]) ? Number(m[1]) * 12 : Number(m[1]);
}

// ---- What the tariff code is for: "Handmade kitchen sinks" ------------------
const TARIFF_KIND = {
  kitchen_sink: 'kitchen sinks', bar_prep_sink: 'bar and prep sinks', laundry_sink: 'laundry sinks', outdoor_sink: 'outdoor sinks',
  bathroom_sink: 'bathroom sinks', kitchen_faucet: 'kitchen faucets', kitchen_faucet_combo: 'kitchen faucets',
  cold_water_tap: 'drinking water taps', pot_filler: 'pot fillers', bathroom_faucet: 'bathroom faucets',
};
function tariffDescription(p) {
  if (!words(attr(p).hs_code)) return '';
  const kind = TARIFF_KIND[p.category];
  if (!kind) return words(p.model_name || p.product_type);
  if (!isSink(p)) return `${kind[0].toUpperCase()}${kind.slice(1)}`;
  const lead = /handmade/i.test(attr(p).craftsmanship ?? '') ? 'Handmade' : words(p.material);
  return words(`${lead} ${kind}`).replace(/^./, (c) => c.toUpperCase());
}

// ---- Sizes ------------------------------------------------------------------
// Menards' Width is the PIM's length, its Depth the PIM's width (his file: a
// box of 37 × 24 × 13.5 goes as Width 37, Depth 24, Height 13.5).
const box = (p, side) => amount(attr(p).shipping_dimensions_in?.[side]);
const outside = (p, side) => amount(attr(p).external_dimensions_in?.[side]);
const boxWeight = (p) => amount(p.shipping_weight_lb);
const assembledHeight = (p) => (isFaucet(p) ? amount(attr(p).faucet_height_in) : outside(p, 'height') === '' ? outside(p, 'depth') : outside(p, 'height'));
// A measure's unit, only beside its measure: the one entry of the column's own
// list ("inches" in the new file, "inch" in the older category files).
const withUnit = (value, unit, x) => (value === '' ? '' : x?.options?.length === 1 ? x.options[0] : unit);

// ---- The old category file's own columns (requirement set 30, kitchen sinks):
// kept as they were, each now held to its list by the same check.
const colorFamily = (p) => {
  const f = String(p.finish ?? '').toLowerCase();
  if (/black/.test(f)) return 'Black';
  if (/gold/.test(f)) return 'Gold';
  if (/stainless|chrome|silver/.test(f)) return 'Silver';
  if (/white/.test(f)) return 'White';
  if (/grey|gray/.test(f)) return 'Gray';
  if (/brown|bamboo/.test(f)) return 'Brown';
  return '';
};
const interiorPerBowl = (p) => {
  const d = attr(p).internal_dimensions_in ?? {};
  return d.length && d.width && d.depth ? `${d.length} in x ${d.width} in x ${d.depth} in` : '';
};
// A vessel sink has no cut-out (user, 2026-11-27): empty there, whatever is stored.
const cutOut = (p, side) => (hasCutOut(p) ? amount(attr(p).cut_out_dimensions_in?.[side]) : '');
const cabinet = (p) => amount(attr(p).min_external_cabinet_size_in);

// Rules by the column's name (row 5). A rule answers with a text, a number, a
// yes / no (true / false: spelled as the column's list spells it) or '' (empty).
export const MENARDS_RULES = {
  ...Object.fromEntries(Object.entries(MENARDS_ACCOUNT).map(([name, value]) => [name, () => value])),

  // Who it is
  'Model Number': (p) => p.sku,
  // The dimension files of a category find their product by these three.
  'MFG Part # (OEM)': (p) => p.sku,
  'MFG Model # (Series)': (p) => p.sku,
  UPC: menardsUpc,
  'Description 1': menardsShortName,
  'Description 2': (p) => p.sku,
  'MCOM Short Description': menardsWebTitle,
  'Long Description': (p) => plain(p.description),
  'Brand Name': (p) => p.brand,

  // Where it comes from
  'Country Of Origin': (p, x) => {
    const c = countryOf(p);
    if (!c) return '';
    return x.options.find((o) => o.endsWith(`(${c.code})`)) ?? `${c.name} (${c.code})`;
  },
  'Mfg Location': (p) => { const c = countryOf(p); return !c ? '' : c.code === 'US' ? 'Made in the USA' : 'None / Outside the USA'; },
  'Product Port Of Origin': (p) => { const c = countryOf(p); return !c ? '' : NO_PORT.has(c.code) ? 'None' : PORT_OF_ORIGIN[c.code] ?? ''; },
  'HTSUS Description': tariffDescription,
  'HTSUS Number': (p) => words(attr(p).hs_code),
  'Duty Rate': (p) => { const c = countryOf(p); return DUTY_RATE[`${words(attr(p).hs_code)}|${c?.code ?? ''}`] ?? ''; },

  // Warranty and money: Menards' MSRP is the MAP, its cost the WC Menards (both Blue, USD)
  'Mfr Warranty': warrantyMonths,
  Cost: (p) => amount(p.cost_usd_menards),
  MSRP: (p) => amount(p.map_usd),
  Minimum_Advertised_Price: (p) => amount(p.map_usd),

  // The box it ships in: one unit a box, so the master pack is the same box
  'Retail Pack Width': (p) => box(p, 'length'),
  'Package Width UOM': (p, x) => withUnit(box(p, 'length'), 'inches', x),
  'Retail Pack Depth': (p) => box(p, 'width'),
  'Package Depth UOM': (p, x) => withUnit(box(p, 'width'), 'inches', x),
  'Retail Pack Height': (p) => box(p, 'height'),
  'Package Height UOM': (p, x) => withUnit(box(p, 'height'), 'inches', x),
  'Retail Pack Weight': boxWeight,
  'Package Weight UOM': (p, x) => withUnit(boxWeight(p), 'pounds', x),
  'Retail Pack UPC': menardsUpc,
  'Master Pack Width': (p) => box(p, 'length'),
  'Master Pack Width UOM': (p, x) => withUnit(box(p, 'length'), 'inches', x),
  'Master Pack Depth': (p) => box(p, 'width'),
  'Master Pack Depth UOM': (p, x) => withUnit(box(p, 'width'), 'inches', x),
  'Master Pack Height': (p) => box(p, 'height'),
  'Master Pack Height UOM': (p, x) => withUnit(box(p, 'height'), 'inches', x),
  'Master Pack Weight': boxWeight,
  'Master Pack Weight UOM': (p, x) => withUnit(boxWeight(p), 'pounds', x),
  'Master Pack UPC': menardsUpc,
  'Master SSCC-14': (p) => { const upc = menardsUpc(p); return upc ? upc.padStart(14, '0') : ''; },

  // The product out of its box
  'Assembled_Height': assembledHeight,
  'Assembled_Width': (p) => outside(p, 'length'),
  'Assembled_Length': (p) => outside(p, 'width'),
  'Assembled_Weight': (p) => amount(attr(p).product_weight_lb),

  'ADA Compliant': (p) => yes(attr(p).ada_compliant),

  // ---- the kitchen sinks category file (requirement set 30) ----
  Includes: (p) => list(attr(p).accessories_included).join(', '),
  'Product Type': (p) => p.product_type || '',
  Application: (p) => attr(p).application || 'Kitchen',
  'Manufacturer Warranty': (p) => attr(p).warranty_length || '',
  Gauge: (p) => num(attr(p).gauge),
  'Sink Material': (p) => p.material || '',
  'Sink Shape': (p) => attr(p).sink_shape || '',
  'Number of Bowls': (p) => num(attr(p).number_of_bowls),
  'Bowl Configuration': (p) => attr(p).bowl_configuration || attr(p).basin_split || '',
  'Mounting Type': (p) => { const m = mountOf(p); return m === 'Farmhouse' ? 'Apron/Farmhouse' : m === 'Vessel' ? '' : m; },
  'Color/Finish': (p) => p.finish || '',
  'Color/Finish Family': colorFamily,
  'Drain Location': (p) => attr(p).drain_hole_location || '',
  'Number of Faucet Holes': (p) => { const n = num(attr(p).number_of_faucet_holes); return n === '' ? 0 : n; },
  'Interior Dimensions Per Bowl': interiorPerBowl,
  'Overall Width': (p) => outside(p, 'length'),
  'Overall Width UOM': (p, x) => withUnit(outside(p, 'length'), 'inch', x),
  Width: (p) => outside(p, 'length'),
  'Overall Depth': (p) => outside(p, 'width'),
  Depth: (p) => outside(p, 'width'),
  'Overall Depth UOM': (p, x) => withUnit(outside(p, 'width'), 'inch', x),
  'Overall Height': assembledHeight,
  'Overall Height UOM': (p, x) => withUnit(assembledHeight(p), 'inch', x),
  Weight: (p) => amount(attr(p).product_weight_lb),
  'Weight UOM': (p, x) => withUnit(amount(attr(p).product_weight_lb), 'pound', x),
  'Cutout Left-to-Right Width': (p) => cutOut(p, 'length'),
  'Cutout Front-to-Back Depth': (p) => cutOut(p, 'width'),
  'Cutout Below Counter Height': (p) => cutOut(p, 'depth'),
  'Minimum Cabinet Size': cabinet,
  'Minimum Cabinet Size UOM': (p, x) => withUnit(cabinet(p), 'inch', x),
  'Minimum Countertop Length': cabinet,
  'Minimum Countertop Length UOM': (p, x) => withUnit(cabinet(p), 'inch', x),
};

const BULLET = /^Bullet_(\d+)$/;
const ALTERNATE_VIEW = /^Alternate Product View (\d+)$/;
const MASTER_IMAGE = 'Master Image (Front View)';

// The pictures a row names, the main one first: the USA's choice of artwork
// (English, else English-Spanish, else English-French) and the photos without
// a language. The gray Sinks Direct photo never leaves the PIM (it is not in `images`).
export function menardsGallery(images) {
  const all = images ?? [];
  const set = [['en'], ['en_es'], ['en_fr']].find((langs) => all.some((m) => m.language === langs[0])) ?? [];
  return all.filter((m) => !m.language || set.includes(m.language)).map((m) => m.storage_path).filter(Boolean);
}
/** A stored picture's own file name ("…/C234L/c234l_00_e-i1o1lj.jpg" → "c234l_00_e-i1o1lj.jpg"). */
export function menardsImageName(url) {
  const last = String(url ?? '').split(/[?#]/)[0].split('/').pop() ?? '';
  try { return decodeURIComponent(last); } catch { return last; }
}

/**
 * The file's "Reference" sheet as a list by attribute name: what each column
 * takes. `grid` is the sheet as rows of texts (row 1 its headers; a list's
 * entries from column H on, one a cell).
 */
export function readMenardsReference(grid) {
  const byName = new Map();
  for (const row of (grid ?? []).slice(1)) {
    const name = words(row?.[0]);
    if (!name) continue;
    const choices = (row ?? []).slice(7).map((v) => String(v ?? '')).filter((v) => v.trim() !== '');
    const spec = { requirement: words(row[1]), type: words(row[2]), format: words(row[4]), choices };
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(spec);
  }
  return byName;
}

/**
 * The columns of a data sheet, each with its rule and what it takes.
 * @param {string[]} names        row 5 (the columns' names)
 * @param {string[]} requirement  row 4 (Required / Conditional / Optional)
 * @param {Map} reference         readMenardsReference()
 */
export function menardsColumns(names, requirement, reference) {
  const seen = new Map();
  return names.map((raw, ci) => {
    const name = words(raw);
    if (!name) return null;
    const nth = seen.get(name) ?? 0;
    seen.set(name, nth + 1);
    const specs = reference.get(name) ?? [];
    const spec = specs[Math.min(nth, specs.length - 1)] ?? { requirement: '', type: '', format: '', choices: [] };
    const bullet = BULLET.exec(name);
    const view = ALTERNATE_VIEW.exec(name);
    let rule = MENARDS_RULES[name] ?? null;
    if (bullet) rule = (p) => list(attr(p).bullet_points)[Number(bullet[1]) - 1] ?? '';
    // A row's pictures: the main one, then the gallery by its place (his file:
    // the 2nd picture in "Alternate Product View 02"; 01 is the main one's place).
    if (name === MASTER_IMAGE) rule = (p, x) => x.picture(0);
    if (view) rule = (p, x) => (Number(view[1]) >= 2 ? x.picture(Number(view[1]) - 1) : '');
    const [, whole, decimals] = spec.format.match(/^(\d+)\.(\d+)$/) ?? [];
    return {
      ci,
      name,
      rule,
      // Its picture's place in the row's gallery (0 = the main one), for the columns that name one.
      picture: name === MASTER_IMAGE ? 0 : view && Number(view[1]) >= 2 ? Number(view[1]) - 1 : null,
      required: /^required$/i.test(words(requirement?.[ci]) || spec.requirement),
      type: spec.type,
      options: spec.choices,
      number: /^(number|currency)$/i.test(spec.type),
      decimals: /^currency$/i.test(spec.type) ? 2 : decimals === undefined ? 5 : Number(decimals),
      digits: whole === undefined ? null : Number(whole),
      max: /^text$/i.test(spec.type) && /^\d+$/.test(spec.format) && !NO_CAP.has(name) ? Number(spec.format) : null,
      upc: /^upc$/i.test(spec.type),
    };
  });
}

// A yes / no as the column's own list spells it ("Y" / "N", "Yes" / "No").
function spelled(answer, options) {
  const want = answer ? ['y', 'yes'] : ['n', 'no'];
  return options.find((o) => want.includes(words(o).toLowerCase())) ?? (answer ? 'Yes' : 'No');
}

/**
 * One product's row: Map(column index → text) of the cells to write, every one
 * a text as in Menards' own files. `report` collects what a person must look at.
 * @param {object} product
 * @param {Array} columns   menardsColumns()
 * @param {{ gallery: string[], imageCell?: 'name' | 'url' }} ctx
 * @param {{ offList: Map, cut: string[], bad: string[] }} report
 */
export function menardsRow(product, columns, ctx, report) {
  const gallery = ctx.gallery ?? [];
  const cell = ctx.imageCell ?? MENARDS_IMAGE_CELL;
  const picture = (i) => (gallery[i] ? (cell === 'url' ? gallery[i] : menardsImageName(gallery[i])) : '');
  const cells = new Map();
  for (const c of columns) {
    if (!c?.rule) continue;
    let raw;
    try { raw = c.rule(product, { options: c.options, picture }); } catch { raw = ''; }
    if (typeof raw === 'boolean') raw = c.options.length ? spelled(raw, c.options) : raw ? 'Yes' : 'No';
    let value = '';
    if (raw === '' || raw === null || raw === undefined) value = '';
    else if (c.options.length) {
      // A list: the file's own spelling of the answer, or nothing.
      const text = words(raw);
      value = c.options.find((o) => o === text) ?? c.options.find((o) => words(o).toLowerCase() === text.toLowerCase()) ?? c.options.find((o) => flat(o) === flat(text)) ?? '';
      if (!value && text) {
        const seen = report.offList.get(c.name) ?? new Map();
        seen.set(text, [...(seen.get(text) ?? []), product.sku]);
        report.offList.set(c.name, seen);
      }
    } else if (c.number) {
      const n = num(raw);
      if (n === '' || n < 0) { if (n !== '') report.bad.push(`${product.sku}: ${c.name} ${raw} is below 0`); } else {
        const fixed = Number(n.toFixed(c.decimals));
        if (c.digits !== null && Math.trunc(fixed).toString().length > c.digits) report.bad.push(`${product.sku}: ${c.name} ${fixed} has more digits than Menards takes`);
        else value = String(fixed);
      }
    } else if (c.upc) {
      const digits = String(raw).replace(/\D/g, '');
      if ([8, 12, 13, 14].includes(digits.length)) value = digits;
      else if (digits) report.bad.push(`${product.sku}: ${c.name} must have 8, 12, 13 or 14 digits`);
    } else {
      value = words(raw);
      if (c.max !== null && value.length > c.max) {
        value = cutAtWord(value, c.max);
        report.cut.push(`${product.sku}: ${c.name} cut to ${c.max} characters`);
      }
    }
    if (value !== '') cells.set(c.ci, value);
  }
  return cells;
}

/** What a person still has to look at after an export, shortest first. */
export function menardsNotes({ columns, rows, products, report, fileLabel = '' }) {
  const few = (skus) => `${skus.slice(0, 6).join(', ')}${skus.length > 6 ? ` and ${skus.length - 6} more` : ''}`;
  // The required columns left empty, those of the same products said together
  // (a box's sides go to the retail and the master pack). A unit follows its measure: not named.
  const empty = new Map(); // the products without it → the columns' names
  for (const c of columns) {
    if (!c?.required || / UOM$/.test(c.name)) continue;
    const without = products.filter((p, i) => !rows[i].has(c.ci)).map((p) => p.sku);
    if (without.length) empty.set(without.join('|'), [...(empty.get(without.join('|')) ?? []), c.name]);
  }
  const groups = [...empty].map(([key, names]) => ({ skus: key.split('|'), names }));
  const everywhere = groups.filter((g) => g.skus.length === products.length && products.length > 1).flatMap((g) => g.names);
  const some = groups.filter((g) => !(g.skus.length === products.length && products.length > 1));
  const lead = fileLabel ? `${fileLabel} — ` : '';
  return [
    everywhere.length ? `${lead}required by Menards and empty on every product: ${everywhere.join(', ')}` : '',
    ...some.map((g) => `${lead}${g.names.join(', ')} ${g.names.length === 1 ? 'is' : 'are'} empty: ${few(g.skus)}`),
    ...[...report.offList].flatMap(([name, values]) => [...values].map(([value, skus]) => `${lead}${name} "${value}" is not on Menards' list: ${few(skus)}`)),
    ...report.bad,
    ...report.cut,
  ].filter(Boolean);
}
