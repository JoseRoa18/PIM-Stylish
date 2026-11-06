// What a product's page on Best Buy Canada takes from the PIM: one row of its
// content import (Mirakl P41), by the attributes Best Buy asks for in each of
// the four categories our offers sit in (read from its PM11 / VL11 on
// 2026-11-06; user: "mappea todos los campos necesarios"). Used by the
// product's "Push Best Buy" and the channel page's Push Content.
//
// - The offer decides the category and the UPC: an offer stays where Best Buy
//   has it (34 bathroom sinks sit in "Bathroom Sink Faucets") and its UPC is the
//   identity anchor, whatever the PIM holds.
// - A field the PIM has no value for is left out of the row, never sent empty,
//   so Best Buy keeps what it has.
// - Best Buy takes English only: its import has no French field but the warranty
//   URL. Prices, stock and the offer are not content (bestbuy-push-price,
//   bestbuy-inventory).
// - Left out on purpose: French Compliant (an N needs a Best Buy VP's approval,
//   and the PIM does not say), the French warranty URL (our /fr/warranty page is
//   still in English), Variant Group Code (it would merge listings on Best Buy),
//   Sales Tax Code, Web Hierarchy Location.

import { isFaucetCategory } from '@/features/products/lib/categories';

const CAT = { kitchen: 'CAT_660943', faucets: 'CAT_37129', kitchenAccessories: 'CAT_314937', bathAccessories: 'CAT_328963' };
const code = (base, cat) => `_${base}_${cat}_EN`;
const root = (base) => `_${base}_Category_Root_EN`;
const sizes = (cat) => ({
  width: code('Width_6823', cat), widthIn: code('WidthInches_25132', cat),
  depth: code('Depth_14236', cat), depthIn: code('DepthInches_25133', cat),
  height: code('Height_15404', cat), heightIn: code('HeightInches_25131', cat),
});

// Each category's columns. An attribute can hang from the category or from its
// parent (CAT_27316 Kitchen & Dining, CAT_35719 Bathroom); a list is every code
// Best Buy offers for the same thing.
const COLUMNS = {
  [CAT.kitchen]: {
    condition: code('ProductCondition_20257570', CAT.kitchen),
    colour: code('Colour_5105', CAT.kitchen),
    material: code('Material_23642', CAT.kitchen),
    finish: code('Finish_9214', CAT.kitchen),
    series: code('StyleSeries_29070', CAT.kitchen),
    type: code('Type_5984', CAT.kitchen),
    country: code('CountryofOrigin_26726', CAT.kitchen),
    pieces: code('TotalNumberofPieces_28905', CAT.kitchen),
    care: code('CareInstructions_36172', CAT.kitchen),
    features: code('OtherFeatures_26219', CAT.kitchen),
    box: code('WhatsintheBox_4667', CAT.kitchen),
    certifications: code('Certifications_27183', CAT.kitchen),
    weight: code('Weight_5302', CAT.kitchen),
    ...sizes(CAT.kitchen),
  },
  [CAT.faucets]: {
    condition: code('ProductCondition_20257570', CAT.faucets),
    colour: code('Colour_5105', CAT.faucets),
    colourFamily: code('ColourFamily_30576', CAT.faucets),
    material: code('Material_23642', CAT.faucets),
    materialFamily: code('BathroomMaterialFamily_14021032', CAT.faucets),
    series: code('CollectionSeries_27223', CAT.faucets),
    country: code('CountryofOrigin_26726', CAT.faucets),
    features: code('OtherFeatures_26219', CAT.faucets),
    box: code('WhatsintheBox_4667', CAT.faucets),
    weight: code('Weight_5302', CAT.faucets),
    environment: code('Operatingenvironment_640568', CAT.faucets),
    forBathrooms: code('SuitableforBathrooms_12112664', CAT.faucets),
    forKitchens: code('SuitableforKitchens_12112660', CAT.faucets),
    appEnabled: code('AppEnabled_31804', CAT.faucets),
    faucetType: code('FaucetType_35648', CAT.faucets),
    outerHoles: code('DistancebetweenOuterHoles_35655', CAT.faucets),
    valve: code('ValveType_35656', CAT.faucets),
    spoutType: code('SpoutType_35657', CAT.faucets),
    spoutHeight: code('SpoutHeight_35658', CAT.faucets),
    spoutReach: code('SpoutReach_35659', CAT.faucets),
    pullout: code('PulloutSpout_35660', CAT.faucets),
    drainIncluded: code('DrainAssemblyIncluded_35661', CAT.faucets),
    handles: code('NumberofHandles_35664', CAT.faucets),
    flow: code('FlowRate_35665', CAT.faucets),
    waterSaving: code('WaterSavingFeature_35634', CAT.faucets),
    ...sizes(CAT.faucets),
  },
  [CAT.kitchenAccessories]: {
    condition: code('ProductCondition_20257570', CAT.kitchenAccessories),
    accessoryType: code('KitchenAccessoryType_823728', CAT.kitchenAccessories),
    dishwasher: code('DishwasherSafe_28279', CAT.kitchenAccessories),
    microwave: code('MicrowaveSafe_28904', CAT.kitchenAccessories),
    oven: code('OvenSafe_823729', CAT.kitchenAccessories),
    colour: code('Colour_5105', CAT.kitchenAccessories),
    colourFamily: code('ColourFamily_30576', CAT.kitchenAccessories),
    material: code('Material_23642', CAT.kitchenAccessories),
    pieces: code('TotalNumberofPieces_28905', CAT.kitchenAccessories),
    piecesList: code('PiecesinSet_28906', CAT.kitchenAccessories),
    box: code('WhatsintheBox_4667', 'CAT_27316'),
    certifications: code('Certifications_27183', 'CAT_27316'),
    weight: code('Weight_6738', 'CAT_27316'),
    ...sizes('CAT_27316'),
  },
  [CAT.bathAccessories]: {
    condition: code('ProductCondition_20257570', CAT.bathAccessories),
    bathType: code('Type_17305230', CAT.bathAccessories),
    colour: code('Colour_5105', 'CAT_35719'),
    colourFamily: [code('ColourFamily_30576', CAT.bathAccessories), code('ColourFamily_30576', 'CAT_35719')],
    material: code('Material_23642', 'CAT_35719'),
    materialFamily: [code('BathroomMaterialFamily_14021032', CAT.bathAccessories), code('BathroomMaterialFamily_14021032', 'CAT_35719')],
    finish: code('Finish_9214', 'CAT_35719'),
    series: code('CollectionSeries_27223', 'CAT_35719'),
    country: code('CountryofOrigin_26726', 'CAT_35719'),
    pieces: code('TotalNumberofPieces_28905', 'CAT_35719'),
    features: code('OtherFeatures_26219', 'CAT_35719'),
    box: code('WhatsintheBox_4667', 'CAT_35719'),
    weight: code('Weight_5302', 'CAT_35719'),
    ...sizes('CAT_35719'),
  },
};

// The name each field has on Best Buy, for the product page's preview.
const LABELS = {
  title: 'Title', short: 'Short description', long: 'Long description', brand: 'Brand', upc: 'Primary UPC (Best Buy\'s)',
  model: 'Model number', mpn: "Manufacturer's part number", warrantyUrl: 'Warranty & repair URL', condition: 'Product condition',
  colour: 'Colour', colourFamily: 'Colour family', material: 'Material', materialFamily: 'Bathroom material family', finish: 'Finish',
  series: 'Collection / series', type: 'Type', bathType: 'Type', accessoryType: 'Kitchen accessory type', country: 'Country of origin',
  pieces: 'Total number of pieces', piecesList: 'Pieces in set', care: 'Care instructions', features: 'Other features', box: "What's in the box",
  certifications: 'Certifications', weight: 'Weight (kg)', width: 'Width (cm)', widthIn: 'Width (in)', depth: 'Depth (cm)', depthIn: 'Depth (in)',
  height: 'Height (cm)', heightIn: 'Height (in)', environment: 'Operating environment', forBathrooms: 'Suitable for bathrooms', forKitchens: 'Suitable for kitchens',
  appEnabled: 'App enabled', faucetType: 'Faucet type', outerHoles: 'Distance between outer holes', valve: 'Valve type', spoutType: 'Spout type',
  spoutHeight: 'Spout height (in)', spoutReach: 'Spout reach (in)', pullout: 'Pull-out spout', drainIncluded: 'Drain assembly included', handles: 'Number of handles',
  flow: 'Flow rate (L/min)', waterSaving: 'Water saving feature', dishwasher: 'Dishwasher safe', microwave: 'Microwave safe', oven: 'Oven safe',
};
const REQUIRED = new Set(['title', 'short', 'brand', 'upc', 'model', 'mpn', 'condition', 'accessoryType', 'dishwasher']);

const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '', gt: '', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', deg: '°', reg: '®', trade: '™', eacute: 'é', frac12: '½', frac14: '¼', frac34: '¾', times: '×' };
const stripHtml = (h) => String(h ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&([a-z0-9]+);/gi, (m, name) => ENTITIES[name] ?? m)
  .replace(/[<>]/g, '')
  .replace(/\s+/g, ' ')
  .trim();
const text = (v) => (v == null ? '' : stripHtml(typeof v === 'string' ? v : String(v)));
// A description as one flowing text: the page's bold headline goes (the Title says
// it), and a line with no closing mark gets one, so it never runs into the next.
function prose(html) {
  const lines = String(html ?? '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, '\n')
    .split('\n')
    .map(stripHtml)
    .filter(Boolean);
  if (lines.length > 1 && lines[0].length <= 120 && !/[.!?:]$/.test(lines[0])) lines.shift();
  return lines.map((l) => (/[.!?:;,]$/.test(l) ? l : `${l}.`)).join(' ');
}
// "A single paragraph … in 400 characters or fewer": a whole sentence where one fits, else whole words.
function cutTo(s, max) {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (end >= max / 3) return head.slice(0, end + 1);
  return head.slice(0, head.lastIndexOf(' ')).replace(/[\s,;:–—-]+$/, '');
}
// A list for a field that separates its items with semicolons.
const listOf = (items) => items.map((x) => text(x).replace(/;/g, ',')).filter(Boolean).join('; ');
const listInput = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/;\s*/)).filter(Boolean);
const numberOf = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };
const fixed = (n, d = 2) => String(Math.round(n * 10 ** d) / 10 ** d);
const CM = 2.54;
const KG = 0.45359237;
const LITRES = 3.78541;
// A yes / no mark as the exporters read it (isYes in templateFiller, which a page may not import).
const isYes = (v) => {
  if (v === true) return true;
  const s = String(v ?? '').trim();
  if (!s || /^(n|no|not|na|n\/a|none|false|does not|doesn't|non)\b/i.test(s)) return false;
  return /^(yes|y|true)$/i.test(s) || /(compliant|certified|listed)$/i.test(s);
};
const yesNo = (b) => (b ? 'Yes' : 'No');

const NOUNS = {
  kitchen_sink: 'Kitchen Sink', bathroom_sink: 'Bathroom Sink', bar_prep_sink: 'Bar Sink', laundry_sink: 'Laundry Sink', outdoor_sink: 'Outdoor Sink',
  kitchen_faucet: 'Kitchen Faucet', kitchen_faucet_combo: 'Kitchen Faucet Combo', cold_water_tap: 'Cold Water Tap', pot_filler: 'Pot Filler', bathroom_faucet: 'Bathroom Faucet',
};
const CERTIFICATIONS = [
  ['cupc_certified', 'cUPC'], ['upc_certified', 'UPC'], ['ada_compliant', 'ADA'], ['epa_watersense_certified', 'WaterSense'], ['asse_1001_certified', 'ASSE 1001'],
  ['ab_100_compliant', 'California AB 100'], ['title_20_compliant', 'California Title 20'], ['vermont_act_193_compliant', 'Vermont Act 193'], ['scc_compliant', 'SCC'],
];

// Best Buy's Colour_General list.
function colourFamily(colour) {
  const c = String(colour ?? '').toLowerCase();
  if (!c) return null;
  if (/\band\b|mixed|multi/.test(c)) return 'Multi-colour';
  if (/black|graphite/.test(c)) return 'Black';
  if (/gray|grey|gunmetal/.test(c)) return 'Grey';
  if (/chrome|silver|nickel|stainless/.test(c)) return 'Silver';
  if (/white/.test(c)) return 'White';
  if (/gold/.test(c)) return 'Gold';
  if (/brown|bamboo|wood/.test(c)) return 'Brown';
  if (/red/.test(c)) return 'Red';
  if (/copper/.test(c)) return 'Copper';
  if (/bronze/.test(c)) return 'Bronze';
  if (/beige/.test(c)) return 'Beige';
  return null;
}
// Best Buy's Bathroom Material Family list.
function materialFamily(material) {
  const m = String(material ?? '').toLowerCase();
  if (!m) return null;
  if (/stainless/.test(m)) return 'Stainless Steel';
  if (/porcelain/.test(m)) return 'Porcelain';
  if (/ceramic/.test(m)) return 'Ceramic';
  if (/brass|zinc|metal/.test(m)) return 'Metal';
  if (/copper/.test(m)) return 'Copper';
  if (/bamboo/.test(m)) return 'Bamboo';
  if (/silicone/.test(m)) return 'Silicone';
  if (/glass/.test(m)) return 'Glass';
  return 'Other';
}
// Best Buy's Kitchen Accessory Type list, by what the product is.
function kitchenAccessoryType(name) {
  if (/\bkit\b/i.test(name)) return 'Other Kitchen Tools';
  if (/cutting board/i.test(name)) return 'Cutting Board';
  if (/colander|strainer/i.test(name)) return 'Strainers';
  if (/soap/i.test(name)) return 'Soap Dispensers';
  return 'Other Kitchen Tools';
}

// Overall sizes on Best Buy's axes: width left to right, depth front to back,
// height top to bottom. The PIM's length runs left to right, its width front to
// back, its depth top to bottom. A round drain has no length: its diameter both
// ways. Faucets keep only their height.
function overallSizes(p) {
  const a = p.attributes ?? {};
  if (isFaucetCategory(p.category)) return { height: numberOf(a.faucet_height_in) };
  const d = a.external_dimensions_in ?? {};
  const width = numberOf(d.length) ?? numberOf(d.width);
  return { width, depth: numberOf(d.width), height: numberOf(d.depth) ?? numberOf(d.height) };
}

/** One text set plus every Universal photo, Canada's order; main image first, at most 10 JPG / PNG. */
export function pickBestBuyImages(images) {
  const usable = (images ?? []).filter((m) => /^https?:\/\//i.test(m.storage_path ?? '') && /\.(jpe?g|png)(\?|#|$)/i.test(m.storage_path));
  const set = [['en_fr'], ['en', 'fr'], ['en_es']].find((langs) => usable.some((m) => langs.includes(m.language)));
  const chosen = usable.filter((m) => m.language == null || set?.includes(m.language));
  return [...chosen.filter((m) => m.is_primary), ...chosen.filter((m) => !m.is_primary)].slice(0, 10).map((m) => m.storage_path);
}

/**
 * The content row of one product for its Best Buy offer.
 * @returns { row, fields: [{ key, label, value, required }], images, leftOut: [label], notes: [string], problems: [string] }
 * `problems` = it can't be pushed yet; `row` is null then.
 */
export function buildBestBuyRow(product, offer, imageRows) {
  const a = product.attributes ?? {};
  const columns = COLUMNS[offer?.category_code];
  const problems = [];
  const notes = [];
  if (!columns) problems.push(`Best Buy category ${offer?.category_code ?? '(none)'} is not mapped yet`);
  if (!offer?.upc) problems.push('no UPC on the Best Buy offer');
  const title = text(a.general_title_en);
  if (!title) problems.push('no General Title (EN) in the PIM');
  const short = cutTo(prose(a.marketing_copy) || prose(product.description), 400);
  if (!short) problems.push('no description in the PIM');
  const images = pickBestBuyImages(imageRows);
  if (!images.length) problems.push('no JPG or PNG image in the PIM');
  if (problems.length) return { row: null, fields: [], images, leftOut: [], notes, problems };

  const values = {};
  const brandName = /azuni/i.test(product.brand ?? '') ? 'AZUNI' : 'Stylish';
  // The brand as Best Buy already writes it ("Azuni" / "AZUNI"), when it is the same one.
  values.brand = String(offer.product_brand ?? '').toLowerCase() === brandName.toLowerCase() ? offer.product_brand : brandName;
  values.title = title;
  values.short = short;
  values.long = cutTo(prose(product.description) || prose(a.marketing_copy), 4000);
  values.upc = String(offer.upc);
  values.model = product.sku;
  values.mpn = product.sku;
  if (/^https?:\/\//i.test(a.warranty_url_ca ?? '')) values.warrantyUrl = a.warranty_url_ca;
  values.condition = 'Brand New';

  const colour = text(product.color) || text(product.finish);
  if (colour) values.colour = colour.replace(/\s+and\s+/gi, '; ');
  values.colourFamily = colourFamily(colour);
  values.material = text(product.material);
  values.materialFamily = materialFamily(product.material);
  values.finish = text(product.finish);
  const series = text(product.series);
  values.series = series && !/^(azuni sink|laundry)$/i.test(series) ? series : text(product.model_name);
  values.type = text(product.product_type);
  values.country = text(a.country_of_origin);
  values.care = text(a.product_care || a.care_instructions).replace(/^please refer to the spec sheet\.?$/i, '');
  values.features = listOf(listInput(a.bullet_points));

  const accessories = listInput(a.accessories_included);
  const faucet = isFaucetCategory(product.category);
  const extras = faucet ? [a.supply_line_included === true && 'Supply Lines', a.deck_plate_included === true && 'Deck Plate'].filter(Boolean) : [];
  values.box = listOf([NOUNS[product.category] ?? product.model_name ?? product.sku, ...accessories, ...extras]);
  const pieces = numberOf(a.number_of_pieces);
  if (pieces) values.pieces = String(Math.round(pieces));
  if (pieces > 1 && accessories.length) values.piecesList = listOf(accessories);
  values.certifications = listOf(CERTIFICATIONS.filter(([key]) => isYes(a[key])).map(([, name]) => name));

  const size = overallSizes(product);
  for (const key of ['width', 'depth', 'height']) {
    if (size[key]) { values[key] = fixed(size[key] * CM); values[`${key}In`] = fixed(size[key]); }
  }
  const pounds = numberOf(a.product_weight_lb);
  if (pounds) values.weight = fixed(pounds * KG);

  // Bathroom Sink Faucets holds faucets and, as Best Buy has them, bathroom sinks.
  const bath = /bathroom/.test(product.category ?? '');
  values.environment = 'Indoor';
  values.forBathrooms = yesNo(bath);
  values.forKitchens = yesNo(!bath);
  if (/drain/i.test(accessories.join(' '))) values.drainIncluded = 'Yes';
  if (faucet) {
    values.appEnabled = 'No';
    values.faucetType = text(a.mounting_type);
    if (numberOf(a.faucet_hole_center_spacing)) values.outerHoles = `${a.faucet_hole_center_spacing} in`;
    else if (/does not apply|not applicable/i.test(a.faucet_centers ?? '')) values.outerHoles = 'Not Applicable';
    values.valve = text(a.cartridge_type);
    if (typeof a.aerator_included === 'boolean') values.spoutType = a.aerator_included ? 'Aerated' : 'Non-Aerated';
    if (numberOf(a.spout_height_in)) values.spoutHeight = fixed(numberOf(a.spout_height_in));
    if (numberOf(a.spout_reach_in)) values.spoutReach = fixed(numberOf(a.spout_reach_in));
    values.pullout = yesNo(/pull/i.test(a.spray_type ?? ''));
    // Its compatible drains are sold apart.
    if (!values.drainIncluded && a.compatible_drain_assembly) values.drainIncluded = 'No';
    const handles = numberOf(a.number_of_handles);
    if (handles) values.handles = handles === 1 ? 'Single-handle' : handles === 2 ? 'Two-handle' : `${handles} handles`;
    if (numberOf(a.max_flow_rate)) values.flow = fixed(numberOf(a.max_flow_rate) * LITRES);
    if (isYes(a.epa_watersense_certified)) values.waterSaving = 'Yes';
  }

  const name = `${product.model_name ?? ''} ${a.general_title_en ?? ''}`;
  values.accessoryType = kitchenAccessoryType(name);
  values.bathType = /soap/i.test(name) ? 'Soap / Lotion Dispenser' : 'Other Bathroom Accessory';
  if (columns.dishwasher) {
    const said = [product.description, a.marketing_copy, a.product_care, a.care_instructions, ...listInput(a.bullet_points)].map(text).join(' ');
    // Bamboo: the page's "dishwasher safe" is about the silicone container of the set, never the board.
    const natural = /bamboo/i.test(product.material ?? '');
    const dishwasher = !natural && /dishwasher/i.test(said) && !/not\s+(be\s+)?(put\s+in\s+(the\s+|a\s+)?)?dishwasher|hand[- ]wash only/i.test(said);
    values.dishwasher = yesNo(dishwasher);
    if (!dishwasher) notes.push(natural ? 'Dishwasher safe goes as No: bamboo, whatever the set\'s container allows.' : 'Dishwasher safe goes as No: the PIM does not say it is.');
    if (!natural && /microwave/i.test(said) && !/not\s+(be\s+)?(put\s+in\s+(the\s+|a\s+)?)?microwave/i.test(said)) values.microwave = 'Yes';
    if (/\boven[- ]safe\b/i.test(said)) values.oven = 'Yes';
  }

  // Only what this category has a column for, and only what has a value.
  const row = { BBYCat: offer.category_code, shop_sku: product.sku };
  const fields = [];
  const leftOut = [];
  const put = (key, targets) => {
    const value = values[key];
    if (value == null || value === '') {
      if (LABELS[key]) leftOut.push(LABELS[key]);
      return;
    }
    for (const c of [targets].flat()) row[c] = String(value);
    fields.push({ key, label: LABELS[key] ?? key, value: String(value), required: REQUIRED.has(key) });
  };
  put('title', root('Title_BB'));
  put('short', root('Short_Description_BB'));
  put('long', root('Long_Description_BB'));
  put('brand', root('Brand_Name'));
  put('upc', root('Primary_UPC'));
  put('model', root('Model_Number'));
  put('mpn', root('Manufacturers_Part_Number'));
  put('warrantyUrl', root('Warranty_And_Repair_Disclosure_URL'));
  // The fields that describe a faucet say nothing of the bathroom sinks that share its category.
  const faucetOnly = new Set(['appEnabled', 'faucetType', 'outerHoles', 'valve', 'spoutType', 'spoutHeight', 'spoutReach', 'pullout', 'handles', 'flow', 'waterSaving']);
  for (const [key, target] of Object.entries(columns)) {
    if (!faucet && faucetOnly.has(key)) continue;
    put(key, target);
  }
  images.forEach((url, i) => { row[root(`MP_Source_Image_URL_${String(i + 1).padStart(2, '0')}`)] = url; });
  return { row, fields, images, leftOut, notes, problems };
}
