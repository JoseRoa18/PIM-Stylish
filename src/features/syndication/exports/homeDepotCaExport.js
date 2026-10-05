import {
  openTemplate,
  sheetPathByName,
  buildCell,
  colToIndex,
  downloadZip,
  templateExt,
  mergeRows,
  fetchImagesBySku,
  fetchDocsBySku,
  setFormulaResults,
  recalcOnOpen,
  mediaFileName,
  downloadMediaZip,
} from './templateFiller';
import { accessoryKind } from '@/features/templates/api/templates';
import { countryFromList } from '@/features/products/lib/countries';

// Fills "The Home Depot Canada.xlsm" — HD Canada's own multi-sheet vendor
// workbook (NOT Mirakl like Home Depot US). Six editable sheets share the key
// (Vendor Part Number on "Basic Data"; the satellites mirror it by formula):
//
//   Basic Data (87 cols)   — identity, department, packaging L1, cost, MSRP
//   Online Core Attributes — category tree, EN/FR names, marketing & bullets
//   Add EAN UPC            — D L1-Primary UPC = the product's UPC (user,
//                            2026-10-05); the additional barcodes stay empty
//   Digital Assets         — image / PDF file NAMES (the files go in a .zip,
//                            one folder per part number)
//   ECO Options, HAZMAT    — questionnaires (all "No" for our catalog)
//   Consolidated Data      — "DO NOT EDIT": never touched
//
// Every sheet ships with its 2000 data rows already present (formulas in
// place), so cells are MERGED into existing rows. Headers are row 1, hint
// row 2, data starts ROW 3.
//
// The "Do not edit" columns are formulas (vendor currency, cost / MSRP
// currency and UOM, the satellites' part number and description, shipping
// method…). They are kept as they are, and each filled row also gets their
// RESULT as the cached value, so the file shows them without a recalc (and
// a portal reading it sees them); Excel recalculates on open as well.
//
// Column rules from the user's review of the file (2026-10-05).
// Category values are the template's own named-range strings
// ("Label_____rangeName"); each L(n) value names the range holding its
// children, so the chains below were read straight out of the workbook.

// Stylish's Home Depot Canada vendor number; VendorData gives it CAD.
const VENDOR_NUMBER = 70007082;
const VENDOR_CURRENCY = 'CAD';
const L1_UOM = 'EA_each';

// Document types Digital Assets can carry (raw type → slot).
const HDCA_DOC_TYPES = {
  spec_sheet: 'spec_sheet',
  installation_manual: 'installation_manual',
  installation_dual_mount: 'installation_manual',
  installation_undermount: 'installation_manual',
  installation_drop_in: 'installation_manual',
  installation_top_mount: 'installation_manual',
  warranty_file: 'warranty_file',
};

const attr = (p) => p.attributes || {};
const num = (v) => {
  if (v == null || v === '') return '';
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : '';
};
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
// Digits only, kept as text (Basic Data W and Add EAN UPC D).
const upcOf = (p) => String(attr(p).upc ?? p.upc ?? '').replace(/\D/g, '');
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
const isFaucet = (p) => /faucet|pot_filler/.test(p.category ?? '');

const installText = (p) =>
  `${p.product_type ?? ''} ${[attr(p).installation_type ?? []].flat().join(' ')} ${attr(p).mounting_type ?? ''}`;

// ---- Department (E) + breakdown (F) — Department sheet values, verbatim ----
// Kitchen sinks and kitchen faucets: 29 Kitchen / In-Stock Countertops/Kitchen
// Sinks; accessories (drains, plates, strainers, colanders, dispensers): 26
// Plumbing / Plumbing Repair; the bath stays in 29 Bath (user, 2026-10-05).
const KITCHEN = { dept: '29 Kitchen', breakdown: 'In-Stock Countertops/Kitchen Sinks_____29_Kitchen_l2_1' };
const PLUMBING = { dept: '26 Plumbing', breakdown: 'Plumbing Repair_____26_Plumbing_l2_6' };
const department = (p) => {
  switch (p.category) {
    case 'kitchen_sink':
    case 'bar_prep_sink':
    case 'outdoor_sink':
    case 'kitchen_faucet':
    case 'pot_filler':
      return KITCHEN;
    case 'accessory':
    case 'colander_drying_rack':
      return PLUMBING;
    case 'bathroom_faucet':
      return { dept: '29 Bath', breakdown: 'Faucets_____29_Bath_l2_1' };
    case 'bathroom_sink':
    case 'laundry_sink':
      return { dept: '29 Bath', breakdown: 'Bath Fixtures_____29_Bath_l2_3' };
    default:
      return PLUMBING;
  }
};

// Online category chain (Categories sheet named ranges, verbatim).
const categoryChain = (p) => {
  const t = installText(p);
  switch (p.category) {
    case 'kitchen_sink':
    case 'bar_prep_sink':
    case 'outdoor_sink': {
      let l3 = 'Kitchen_Undermount_Sinks_____l3_kitchenundermountsinks';
      if (/workstation/i.test(`${t} ${list(attr(p).accessories_included).join(' ')}`)) l3 = 'Kitchen_Workstation_Sinks_____l3_kitchenworkstationsinks';
      else if (/farm|apron/i.test(t)) l3 = 'Farmhouse_Sinks_____l3_farmhousesinks';
      else if (/bar|prep|outdoor/i.test(`${t} ${p.category}`)) l3 = 'Prep_and_Bar_Sinks_____l3_prepandbarsinks';
      else if (/drop|top.?mount|dual/i.test(t)) l3 = 'Kitchen_Drop_In_Sinks_____l3_kitchendropinsinks';
      return ['Kitchen_____l1_kitchen', 'Kitchen_and_Bar_Sinks_____l2_kitchen_sinks', l3];
    }
    case 'bathroom_sink': {
      let l3 = 'Undermount_Sinks_____l3_undermountsinks2016';
      if (/vessel/i.test(t)) l3 = 'Vessel_Sinks_____l3_vesselsinks';
      else if (/pedestal|console/i.test(t)) l3 = 'Console_and_Pedestal_Sinks_____l3_pedestalsconsoles';
      else if (/wall/i.test(t)) l3 = 'Wall_Mount_Sinks_____l4_wallmountsinks2016';
      else if (/drop|top.?mount|dual/i.test(t)) l3 = 'Drop_In_Sinks_____l3_bathsinks';
      return ['Bath_____l1_bath', 'Bathroom_Sinks_____l2_sinks', l3];
    }
    case 'kitchen_faucet':
    case 'pot_filler': {
      const s = `${t} ${attr(p).spout_type ?? ''} ${attr(p).spray_type ?? ''}`;
      let l3 = 'Pull_Down_Faucets_____l3_pulldownfaucetsh20';
      if (/pot ?filler/i.test(`${s} ${p.category}`)) l3 = 'Pot_Fillers_____l3_potfillersh20';
      else if (/pull.?out/i.test(s)) l3 = 'Pull_Out_Faucets_____l3_pulloutfaucetsh20';
      else if (/bar |beverage|drinking|filtration/i.test(s)) l3 = 'Bar_Faucets_____l3_bagfaucetsh20';
      else if (/bridge/i.test(s)) l3 = 'Bridge_Faucets_____l3_bridgefaucetsh20';
      else if (/wall/i.test(s)) l3 = 'Wall_Mounted_Faucets_____l3_wallmountedh20';
      return ['Kitchen_____l1_kitchen', 'Kitchen_and_Bar_Faucets_____l2_kitchen_faucets', l3];
    }
    case 'bathroom_faucet':
      return ['Bath_____l1_bath', 'Bathroom_Faucets_and_Shower_Heads_____l2_bath_faucets', 'Bathroom_Sink_Faucets_____1010154'];
    case 'laundry_sink':
      return ['Bath_____l1_bath', 'Laundry_Sinks_and_Faucets_____category_laundryroombath', 'Laundry_Sinks_and_Tubs_____category_laundrysinksb'];
    case 'colander_drying_rack':
      return ['Kitchen_____l1_kitchen', 'Kitchen_and_Sink_Accessories_____l2_kitchen_sinkaccessories', 'Colanders_____l3_cuttingboards_colanders'];
    case 'accessory': {
      // The template's tree has no drain or deck-plate category (Plumbing's
      // Sink Drains / Escutcheons & Plates aren't reachable from its Level 1
      // list): drains go with the drain hardware, deck plates with the
      // fittings (user, 2026-10-01).
      const byKind = {
        strainer: 'Sink_Strainers_and_Disposal_Flange_____l3_sinkstrainers_disposalflange',
        drain: 'Sink_Strainers_and_Disposal_Flange_____l3_sinkstrainers_disposalflange',
        grid: 'Sink_Grids_and_Rinse_Baskets_____l3_sinkgrids_rinsebaskets',
        'soap dispenser': 'Soap_Lotion_Dispensers_____l3_soap_lotiondispensers',
        'faucet plate': 'Kitchen_Fittings_____l3_kitchenfittings',
      };
      const l3 = byKind[accessoryKind(p)] ?? 'Colanders_____l3_cuttingboards_colanders';
      return ['Kitchen_____l1_kitchen', 'Kitchen_and_Sink_Accessories_____l2_kitchen_sinkaccessories', l3];
    }
    default:
      return ['', '', ''];
  }
};

const isFragile = (p) =>
  /fireclay|porcelain|ceramic|glass|granite|composite/i.test(`${p.material ?? ''} ${attr(p).material ?? ''}`) ? 'Yes' : 'No';

const titleEn = (p) => attr(p).general_title_en || p.model_name || p.sku;
const titleFr = (p) => attr(p).general_title_fr || '';

// ---- Article description (G / H): at most 35 characters ---------------------
// The template rejects more than 35; the PIM titles average 74. Model + a
// short product type + the SKU, EN and FR (user, 2026-10-05).
const DESC_MAX = 35;
const INSTALL = {
  Undermount: { en: 'Undermount', fr: 'sous-plan' },
  'Dual Mount': { en: 'Dual Mount', fr: 'double montage' },
  'Top Mount': { en: 'Top Mount', fr: 'à encastrer' },
  'Drop-In': { en: 'Drop-In', fr: 'à encastrer' },
};
const FINISH = {
  'Brushed Stainless Steel': { en: 'Stainless', fr: 'inox brossé' },
  'Stainless Steel': { en: 'Stainless', fr: 'inox' },
  White: { en: 'White', fr: 'blanc' },
  'Matte Black': { en: 'Matte Black', fr: 'noir mat' },
  'Brushed Gold': { en: 'Brushed Gold', fr: 'or brossé' },
  Black: { en: 'Black', fr: 'noir' },
  'Polished Chrome': { en: 'Chrome', fr: 'chrome poli' },
  Gray: { en: 'Gray', fr: 'gris' },
  'Dark Gray': { en: 'Dark Gray', fr: 'gris foncé' },
  'honey-toned brown': { en: 'Brown', fr: 'brun miel' },
  'Brushed Nickel': { en: 'Brushed Nickel', fr: 'nickel brossé' },
  'Graphite Black': { en: 'Graphite Black', fr: 'noir graphite' },
  'Nano Graphite Black Dura-Tek': { en: 'Graphite Black', fr: 'noir graphite' },
  'Matte Black With Gold': { en: 'Black/Gold', fr: 'noir et or' },
  'Matte Black with Brushed Gold': { en: 'Black/Gold', fr: 'noir et or' },
  'Matte Black with Brushed Stainless Steel': { en: 'Black/Stainless', fr: 'noir et inox' },
  Red: { en: 'Red', fr: 'rouge' },
  Gold: { en: 'Gold', fr: 'or' },
  'Glossy Black': { en: 'Glossy Black', fr: 'noir lustré' },
  Gunmetal: { en: 'Gunmetal', fr: 'gris métal' },
};
// Accessories carry their kind as the model name ("Pop-Up Drain"…).
const ACCESSORY_FR = [
  [/pop.?up drain/i, 'Bonde à clapet'],
  [/faucet plate/i, 'Plaque de robinet'],
  [/strainer/i, 'Crépine'],
  [/drying rack/i, 'Égouttoir'],
  [/drying mat/i, 'Tapis de séchage'],
  [/colander/i, 'Passoire'],
  [/soap|lotion/i, 'Distributeur de savon'],
  [/grid/i, 'Grille de fond'],
  [/cutting board/i, 'Planche à découper'],
  [/drain/i, 'Drain'],
];
const ACCESSORY_EN = { strainer: 'Strainer', drain: 'Drain', grid: 'Sink Grid', 'soap dispenser': 'Soap Dispenser', 'faucet plate': 'Faucet Plate' };

// [long, short, shortest] product-type words for EN and FR.
const typeWords = (p) => {
  const spray = `${attr(p).spray_type ?? ''} ${attr(p).spout_type ?? ''}`;
  switch (p.category) {
    case 'kitchen_sink': return { en: ['Kitchen Sink', 'Sink'], fr: ['Évier de cuisine', 'Évier'] };
    case 'bar_prep_sink': return { en: ['Bar Sink', 'Sink'], fr: ['Évier de bar', 'Évier'] };
    case 'outdoor_sink': return { en: ['Outdoor Sink', 'Sink'], fr: ['Évier extérieur', 'Évier'] };
    case 'laundry_sink': return { en: ['Laundry Sink', 'Sink'], fr: ['Évier de buanderie', 'Évier'] };
    case 'bathroom_sink': return { en: ['Bathroom Sink', 'Sink'], fr: ['Lavabo de salle de bain', 'Lavabo'] };
    case 'bathroom_faucet': return { en: ['Bathroom Faucet', 'Faucet'], fr: ['Robinet de salle de bain', 'Robinet de lavabo', 'Robinet'] };
    case 'pot_filler': return { en: ['Pot Filler'], fr: ['Robinet remplisseur', 'Remplisseur'] };
    case 'kitchen_faucet':
      if (/pot ?filler/i.test(spray)) return { en: ['Pot Filler'], fr: ['Robinet remplisseur', 'Remplisseur'] };
      if (/pull.?down/i.test(spray)) return { en: ['Pull-Down Kitchen Faucet', 'Pull-Down Faucet', 'Faucet'], fr: ['Robinet de cuisine à douchette', 'Robinet à douchette', 'Robinet'] };
      if (/pull.?out/i.test(spray)) return { en: ['Pull-Out Kitchen Faucet', 'Pull-Out Faucet', 'Faucet'], fr: ['Robinet de cuisine à douchette', 'Robinet à douchette', 'Robinet'] };
      return { en: ['Kitchen Faucet', 'Faucet'], fr: ['Robinet de cuisine', 'Robinet'] };
    default: return null;
  }
};

// A phrase cut at a word boundary to at most n characters.
const cutWords = (text, n) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const c = t.slice(0, n + 1);
  const i = c.lastIndexOf(' ');
  return (i > 0 ? c.slice(0, i) : t.slice(0, n)).trim();
};
// The first candidate that fits.
const fit = (candidates) => {
  const clean = candidates.map((c) => String(c ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return clean.find((c) => c.length <= DESC_MAX) ?? cutWords(clean[clean.length - 1] ?? '', DESC_MAX);
};

// The SKU closes every description: variants of one model (sets of 2, with
// grid, kits) otherwise read the same — 163 products shared 62 texts. When it
// doesn't fit, the type word gets shorter, then the installation goes, then
// the name is cut at a word; the SKU always stays.
const shortDescriptions = (p) => {
  const sku = String(p.sku);
  const room = DESC_MAX - sku.length - 1;
  const model = String(p.model_name || '').trim();
  const finish = FINISH[String(p.finish ?? attr(p).finish ?? '').trim()] ?? null;
  const install = INSTALL[String([attr(p).installation_type ?? []].flat()[0] ?? '').trim()] ?? null;
  const types = typeWords(p);
  if (types) {
    const name = model || sku;
    const isSink = /sink/.test(p.category ?? '');
    const insEn = isSink && install ? `${install.en} ` : '';
    const insFr = isSink && install ? ` ${install.fr}` : '';
    return {
      en: fit([
        ...types.en.map((t) => `${name} ${insEn}${t} ${sku}`),
        ...types.en.map((t) => `${name} ${t} ${sku}`),
        `${cutWords(name, room)} ${sku}`,
      ]),
      fr: fit([
        ...types.fr.map((t) => `${t}${insFr} ${name} ${sku}`),
        ...types.fr.map((t) => `${t} ${name} ${sku}`),
        `${cutWords(name, room)} ${sku}`,
      ]),
    };
  }
  // Accessories, colanders, racks: the kind is the name ("Pop-Up Drain"…),
  // with the finish when it still fits next to the SKU.
  const kindEn = model || ACCESSORY_EN[accessoryKind(p)] || p.product_type || titleEn(p);
  const kindFr = ACCESSORY_FR.find(([re]) => re.test(kindEn))?.[1] || titleFr(p) || kindEn;
  return {
    en: fit([finish ? `${kindEn} ${finish.en} ${sku}` : '', `${kindEn} ${sku}`, `${cutWords(kindEn, room)} ${sku}`]),
    fr: fit([finish ? `${kindFr} ${finish.fr} ${sku}` : '', `${kindFr} ${sku}`, `${cutWords(kindFr, room)} ${sku}`]),
  };
};

// ---- Till receipt text (I / J): the product's size, at most 12 characters --
// "36x18x10in" / "36x18x10po" — length x width x depth. With decimals that
// don't fit, the unit goes first, then one decimal, then whole inches.
// Faucets carry no overall size: their height ("H16in").
const TILL_MAX = 12;
const tillReceipt = (p, unit) => {
  const d = attr(p).external_dimensions_in ?? {};
  let nums = [d.length, d.width, d.depth ?? d.height].map(Number).filter((n) => Number.isFinite(n) && n > 0);
  let prefix = '';
  if (!nums.length && isFaucet(p) && Number(attr(p).faucet_height_in) > 0) {
    nums = [Number(attr(p).faucet_height_in)];
    prefix = 'H';
  }
  if (!nums.length) return '';
  const fmt = (n, dp) => String(Math.round(n * 10 ** dp) / 10 ** dp);
  for (const dp of [3, 1, 0]) {
    const core = prefix + nums.map((n) => fmt(n, dp)).join('x');
    if ((core + unit).length <= TILL_MAX) return core + unit;
    if (core.length <= TILL_MAX) return core;
  }
  return (prefix + nums.map((n) => fmt(n, 0)).join('x')).slice(0, TILL_MAX);
};

// ---- Weights (lbs) ------------------------------------------------------------
// Gross = the package; Net = the product. Without a product weight, the
// package less 2 lb — unless that leaves 1 lb or less, then the package's
// own weight (user, 2026-10-05).
const grossLb = (p) => num(p.shipping_weight_lb ?? attr(p).shipping_weight_lb);
const netLb = (p) => {
  const w = num(attr(p).product_weight_lb ?? p.weight_lb);
  if (w !== '' && w > 0) return w;
  const g = grossLb(p);
  if (g === '') return '';
  const less = Math.round((g - 2) * 1000) / 1000;
  return less > 1 ? less : g;
};

// ---- Warranty (AO EN / AP FR) -------------------------------------------------
const warrantyParts = (p) => ({
  w: String(p.warranty ?? attr(p).warranty ?? '').trim(),
  len: String(attr(p).warranty_length ?? '').trim(),
});
const warrantyText = (p) => {
  const { w, len } = warrantyParts(p);
  // A warranty that already says its term ("Lifetime", "5 years Full…") is used as is.
  const text = /year|lifetime/i.test(w) ? w : [len, w].filter(Boolean).join(' ');
  if (!text) return '';
  return (/warrant/i.test(text) ? text : `${text} warranty`).replace(/\s+/g, ' ');
};
const WARRANTY_FR_TEXT = {
  '5 years Full Warranty including the electrical components / Lifetime warranty for structure and finishes':
    'Garantie complète de 5 ans incluant les composants électriques / garantie à vie sur la structure et les finis',
};
const warrantyTextFr = (p) => {
  const { w, len } = warrantyParts(p);
  if (WARRANTY_FR_TEXT[w]) return WARRANTY_FR_TEXT[w];
  const kind = /full/i.test(w) ? ' complète' : /limited/i.test(w) ? ' limitée' : '';
  const term = `${len} ${w}`;
  const years = term.match(/(\d+)\s*years?/i);
  let dur = '';
  if (/lifetime/i.test(len) || (!len && /lifetime/i.test(w))) dur = ' à vie';
  else if (years) dur = ` de ${years[1]} an${Number(years[1]) > 1 ? 's' : ''}`;
  if (!kind && !dur) return '';
  return `Garantie${kind}${dur}`;
};

// ---- Shipping method (Online Core AY) — the template's own formula ----------
// Parcel when the package is ≤ 108" long, its girth 2×(W+H) ≤ 165" and the
// net weight ≤ 150 lb; otherwise Less_Than_Truckload; "" without the sizes.
const shippingMethod = (p) => {
  const d = attr(p).shipping_dimensions_in ?? {};
  const len = num(d.length);
  const wid = num(d.width);
  const hei = num(d.height);
  const net = netLb(p);
  if ([len, wid, hei, net].some((v) => v === '')) return '';
  return len <= 108 && 2 * (wid + hei) <= 165 && net <= 150 ? 'Parcel' : 'Less_Than_Truckload';
};

// ---- Per-sheet rules, keyed by column letter (data starts row 3) -----------

const BASIC_DATA_RULES = {
  A: (p) => p.sku,
  B: () => 'Stock_Articles',
  C: () => 'Online Only',
  E: (p) => department(p).dept,
  F: (p) => department(p).breakdown,
  G: (p) => p._desc.en,
  H: (p) => p._desc.fr,
  I: (p) => tillReceipt(p, 'in'),
  J: (p) => tillReceipt(p, 'po'),
  K: () => 'National',
  L: (p) => brandMap(p.brand),
  M: () => VENDOR_NUMBER,
  O: (p) => attr(p).hs_code ?? p.hs_code ?? '',
  P: () => 'No',
  Q: () => L1_UOM,
  R: () => 1,
  S: () => 'Yes',
  T: () => 'Yes',
  U: () => 'Yes',
  W: (p) => upcOf(p),
  X: isFragile,
  Y: () => 'Box',
  Z: grossLb,
  AA: netLb,
  AB: (p) => num(attr(p).shipping_dimensions_in?.height),
  AC: (p) => num(attr(p).shipping_dimensions_in?.width),
  AD: (p) => num(attr(p).shipping_dimensions_in?.length),
  // L2 / L3 / L4 packaging stays empty: only L1 is filled (user, 2026-10-05).
  BQ: () => 'Hard',
  // National Cost = WC Blue (the Rona / Home Depot CAD dealer cost).
  BR: (p) => num(p.cost_cad_rona_hd),
  // L1-MSRP = MAP Blue (CAD).
  BU: (p) => num(p.map_cad),
  CA: () => 'No',
  CB: () => 'No',
  CF: () => 'Others', // cardboard isn't in the list (EPS/PVC/Others)
  CG: (p) => p._country,
};
// The "Do not edit" columns' results for a filled row (their formulas stay).
const BASIC_DATA_RESULTS = () => ({
  N: VENDOR_CURRENCY, // VendorData currency of the vendor number
  BS: VENDOR_CURRENCY, // Hard cost → the vendor's currency
  BT: L1_UOM, // the L1 cost UOM
  BV: 'CAD', // Hard MSRP → CAD
  BW: L1_UOM, // the L1 sellable UOM
});

const ONLINE_CORE_RULES = {
  C: (p) => categoryChain(p)[0],
  D: (p) => categoryChain(p)[1],
  E: (p) => categoryChain(p)[2],
  F: () => '',
  G: () => '',
  H: () => '',
  I: titleEn,
  J: (p) => stripHtml(p.description),
  Y: titleFr,
  Z: (p) => stripHtml(attr(p).description_fr),
  AO: warrantyText,
  AP: warrantyTextFr,
  AQ: () => 'No',
  AR: () => 'No',
  AS: () => 'No',
  AT: netLb,
  // Assembled H = vertical, W = left-to-right (PIM length), D = front-to-back.
  // Faucets carry no overall dimensions: their height is faucet_height_in
  // (user, 2026-10-01); width and depth stay empty.
  AU: (p) => num(attr(p).external_dimensions_in?.height
    ?? (isFaucet(p) ? attr(p).faucet_height_in : null)
    ?? attr(p).external_dimensions_in?.depth),
  // Round drains (D-70x) have no length: their diameter (PIM width) is both
  // width and depth (user, 2026-10-01).
  AV: (p) => num(attr(p).external_dimensions_in?.length ?? (accessoryKind(p) === 'drain' ? attr(p).external_dimensions_in?.width : null)),
  AW: (p) => num(attr(p).external_dimensions_in?.width),
  // AZ Pick SLA — business fills. Ship from: Canada / Ontario / Greater
  // Toronto Area, less than truckload (user, 2026-10-05).
  BA: () => 'CA__Less_than_truckload',
  BB: () => 'Ontario__Less_than_truckload',
  BC: () => 'GreaterTorontoArea__Less_than_truckload',
};
// Row 3 carries the template's example category (Appliances…): the category
// columns are always written, an empty value clearing the example.
const ONLINE_CORE_CLEAR = new Set(['C', 'D', 'E', 'F', 'G', 'H']);
// Bullet1-14: EN in K..X, FR in AA..AN.
for (let i = 0; i < 14; i++) {
  ONLINE_CORE_RULES[colLetter(colToIndex('K') + i)] = (p) => list(attr(p).bullet_points)[i] ?? '';
  ONLINE_CORE_RULES[colLetter(colToIndex('AA') + i)] = (p) => list(attr(p).bullet_points_fr)[i] ?? '';
}
const ONLINE_CORE_RESULTS = (p) => ({
  A: p.sku,
  B: p._desc.en,
  AX: p._country,
  AY: shippingMethod(p),
});
const MIRROR_RESULTS = (p) => ({ A: p.sku, B: p._desc.en });

// Add EAN UPC: the template leaves D (L1-Primary UPC) empty; it gets the
// same UPC as Basic Data W, as text so Excel keeps all 12 digits. A, B and
// C mirror Basic Data by formula.
const EAN_UPC_RULES = { D: (p) => upcOf(p) };
const EAN_UPC_RESULTS = (p) => ({ ...MIRROR_RESULTS(p), C: L1_UOM });

// ECO Options: every question "No" (user, 2026-10-05).
const ECO_RULES = Object.fromEntries(['C', 'D', 'E', 'H', 'I', 'L', 'M', 'P', 'Q', 'S', 'T', 'V'].map((c) => [c, () => 'No']));

// HAZMAT: C..L "No", packing group 0, solid.
const HAZMAT_RULES = {
  ...Object.fromEntries(['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map((c) => [c, () => 'No'])),
  O: () => '0',
  Q: () => 'SOLID',
};

// ---- Digital Assets: file names, the files themselves go in the .zip -------
// Images: SKU.jpg, SKU_2.jpg… (primary first, up to 21). PDFs: #1 spec sheet,
// #2 installation manual, #3 warranty — ONE file each, the English + French
// one, else the English one (user, 2026-10-05). The warranty is the brand's
// single PDF, one name for every product.
const LANG_RANK = { en_fr: 0, en: 1, en_es: 2, '': 3 };
const INSTALL_ORDER = ['installation_manual', 'installation_dual_mount', 'installation_undermount', 'installation_drop_in', 'installation_top_mount'];
const pickDoc = (docs, types) => docs
  .filter((d) => types.includes(d.raw) && (d.lang ?? '') in LANG_RANK)
  .sort((a, b) => LANG_RANK[a.lang ?? ''] - LANG_RANK[b.lang ?? ''] || types.indexOf(a.raw) - types.indexOf(b.raw))[0] ?? null;
const docExt = (url) => (String(url ?? '').match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1] ?? 'pdf').toLowerCase();

const mediaPlan = (p) => {
  const images = (p._images ?? []).slice(0, 21).map((url, i) => ({ url, name: mediaFileName(p.sku, i, url) }));
  const spec = pickDoc(p._docs ?? [], ['spec_sheet']);
  const install = pickDoc(p._docs ?? [], INSTALL_ORDER);
  const warranty = pickDoc(p._docs ?? [], ['warranty_file']);
  const safeSku = String(p.sku).replace(/[\\/:*?"<>|\s]+/g, '-');
  const pdfs = [
    spec && { url: spec.url, name: `${safeSku}_spec_sheet.${docExt(spec.url)}` },
    install && { url: install.url, name: `${safeSku}_installation_manual.${docExt(install.url)}` },
    warranty && { url: warranty.url, name: `${brandMap(p.brand) === 'AZUNI' ? 'Azuni' : 'Stylish'}_warranty.${docExt(warranty.url)}` },
  ];
  return { images, pdfs };
};

const digitalRules = () => {
  const rules = { C: (p) => p._media.images[0]?.name ?? '' };
  for (let i = 0; i < 20; i++) rules[colLetter(colToIndex('D') + i)] = (p) => p._media.images[i + 1]?.name ?? '';
  ['X', 'Y', 'Z'].forEach((col, i) => { rules[col] = (p) => p._media.pdfs[i]?.name ?? ''; });
  return rules;
};

// The template's country list (Validations!T, named range "Countries").
async function templateCountries(zip, shared) {
  const path = await sheetPathByName(zip, 'Validations');
  if (!path) return [];
  const xml = await zip.file(path).async('string');
  const out = [];
  for (const m of xml.matchAll(/<c r="T(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    if (Number(m[1]) < 2) continue;
    const body = m[3] ?? '';
    const v = body.match(/<v>([^<]*)<\/v>/)?.[1];
    const inline = body.match(/<t[^>]*>([^<]*)<\/t>/)?.[1];
    const val = /t="s"/.test(m[2]) ? shared[Number(v)] : inline ?? v;
    if (val) out.push(val);
  }
  return out;
}

/**
 * Fill The Home Depot Canada workbook (in place) and download it, with a
 * .zip of the images and PDFs its Digital Assets sheet names, one folder
 * per part number.
 *
 * @param {string} templateStoragePath  path in the `templates` bucket
 * @param {Object[]} products           full product rows
 * @param {string} [fileName]
 */
export async function generateHomeDepotCaFromTemplate(templateStoragePath, products, fileName = 'HomeDepotCA_Export') {
  if (!products?.length) throw new Error('No products to export.');

  const { zip, shared } = await openTemplate(templateStoragePath);
  const countries = await templateCountries(zip, shared);

  const skus = products.map((p) => p.sku);
  const imgBySku = await fetchImagesBySku(skus);
  const docBySku = await fetchDocsBySku(skus, HDCA_DOC_TYPES, Object.keys(HDCA_DOC_TYPES));
  for (const p of products) {
    p._images = (imgBySku[p.sku] || []).map((m) => m.storage_path);
    p._docs = docBySku[p.sku] || [];
    p._desc = shortDescriptions(p);
    // An unset country is China, as on every other marketplace export.
    p._country = countryFromList(attr(p).country_of_origin || 'China', countries);
    p._media = mediaPlan(p);
  }

  const DATA_ROW = 3;
  const fillSheet = async (sheetName, rules, { results = null, clear = null } = {}) => {
    const path = await sheetPathByName(zip, sheetName);
    if (!path) throw new Error(`The file has no "${sheetName}" sheet — is this the Home Depot Canada template?`);
    let xml = await zip.file(path).async('string');
    const cellsByRow = new Map();
    const resultsByRow = new Map();
    products.forEach((p, pi) => {
      const rowNum = DATA_ROW + pi;
      const cells = new Map();
      for (const [col, rule] of Object.entries(rules)) {
        let v;
        try { v = rule(p); } catch { v = ''; }
        if (v === '' || v == null) {
          if (clear?.has(col)) cells.set(colToIndex(col), '');
          continue;
        }
        cells.set(colToIndex(col), buildCell(`${col}${rowNum}`, v));
      }
      if (cells.size) cellsByRow.set(rowNum, cells);
      if (results) resultsByRow.set(rowNum, new Map(Object.entries(results(p))));
    });
    // keepStyle: the template's pre-formatted rows keep their cell formats.
    xml = mergeRows(xml, cellsByRow, true);
    if (results) xml = setFormulaResults(xml, resultsByRow);
    zip.file(path, xml);
  };

  await fillSheet('Basic Data', BASIC_DATA_RULES, { results: BASIC_DATA_RESULTS });
  await fillSheet('Online Core Attributes', ONLINE_CORE_RULES, { results: ONLINE_CORE_RESULTS, clear: ONLINE_CORE_CLEAR });
  await fillSheet('Add EAN UPC', EAN_UPC_RULES, { results: EAN_UPC_RESULTS });
  await fillSheet('Digital Assets', digitalRules(), { results: MIRROR_RESULTS });
  await fillSheet('ECO Options', ECO_RULES, { results: MIRROR_RESULTS });
  await fillSheet('HAZMAT', HAZMAT_RULES, { results: MIRROR_RESULTS });
  // Excel recalculates every formula when the file is opened.
  await recalcOnOpen(zip);

  await downloadZip(zip, fileName, templateExt(templateStoragePath));
  // One folder per part number with its images and PDFs (user, 2026-10-05).
  const media = await downloadMediaZip(
    products.flatMap((p) => [...p._media.images, ...p._media.pdfs.filter(Boolean)].map((e) => ({ ...e, folder: p.sku }))),
    fileName,
  );
  return { count: products.length, media };
}

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
