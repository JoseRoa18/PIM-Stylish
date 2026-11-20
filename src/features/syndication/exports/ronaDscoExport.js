import { supabase } from '@/lib/supabase';
import { getMediaUrl } from '@/features/media/api/media';
import { isKitchenFaucetCategory } from '@/features/products/lib/categories';
import { countryFromList } from '@/features/products/lib/countries';
import { WAREHOUSE, boxCount, boxSize, competitorPrices } from './ronaExport';
import {
  buildCell, columnStyles, downloadZip, fetchDocsBySku, fetchImagesBySku, fetchVideosBySku, indexToCol, injectRows, isYes, mergeRows, norm, sheetPathByName,
  sheetToGrid, templateExt,
} from './templateFiller';

// Rona's catalog file of its DSCO portal (user, 2026-11-19: "el que hay que
// llenar es el que te acabo de subir" — "RONA Catalog Items - Bathroom Sink
// Faucets.xlsx"). One file per Rona category:
//   "Catalog Data"       names on row 1, one row per product from row 2. The
//                        file comes with row 2 holding only its retailer id and
//                        its category (the last columns): every row carries them.
//   "Help and Glossary"  the same columns again — their names, what each asks,
//                        Required / Recommended / Optional, its type, and under
//                        them the values a pick list takes.
// The columns are found by their names, never by letter: a category's own
// attributes come after the columns every category shares, and the next
// category's file has others. A pick list takes only a value of the file's own
// list, a column the PIM has nothing for is left empty, and what was left empty
// among the Required ones is named (the readiness report).

const DATA_SHEET = 'Catalog Data';
const HELP_SHEET = 'Help and Glossary';
const MAX_BOXES = 10;

// What a file is for, by the last part of its category, and the PIM products
// that belong in it. A category not listed here takes what Templates gave it.
const CATEGORY_FITS = [
  [/bathroom sink faucets?$/i, (p) => p.category === 'bathroom_faucet', 'bathroom faucets'],
  [/bathroom sinks?$/i, (p) => p.category === 'bathroom_sink', 'bathroom sinks'],
  // Combos, cold water taps and pot fillers are kitchen faucets for Rona (its Faucet Type has "Pot filler").
  [/kitchen faucets?$/i, (p) => isKitchenFaucetCategory(p.category) || p.category === 'pot_filler', 'kitchen faucets'],
  // Bar / prep, laundry and outdoor sinks have Rona categories of their own (as on the Vendor Quote Sheet).
  [/kitchen sinks?$/i, (p) => p.category === 'kitchen_sink', 'kitchen sinks'],
];

const attr = (p) => p.attributes ?? {};
const num = (v) => { const n = Number(v); return v !== null && v !== '' && v !== undefined && Number.isFinite(n) ? n : ''; };
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const words = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const yesNo = (v) => (v ? 'Yes' : 'No');
// A switch of the product page: never stored means off, like a stored No.
const switchOn = (v) => v === true || isYes(v);
const plain = (html) => words(String(html ?? '')
  .replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|li|h\d)>/gi, ' ').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'"));
// A text Rona caps: whole words up to the cap, and the cut is said.
function capped(text, max, sku, what, notes) {
  const t = words(text);
  if (t.length <= max) return t;
  notes.push(`${sku}: ${what} cut to ${max} characters`);
  const cut = t.slice(0, max + 1);
  return cut.slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : max).replace(/[\s,;:·-]+$/, '');
}
const titleOf = (p) => attr(p).general_title_en || p.model_name || '';
const tagsOf = (p) => list(attr(p).durability_tags).join(' | ');
const describes = (p) => `${p.product_type ?? ''} ${titleOf(p)} ${list(attr(p).accessories_included).join(' ')}`;
const materials = (p) => `${p.material ?? ''} ${attr(p).handle_material ?? ''} ${titleOf(p)}`;
const isSink = (p) => /sink/i.test(p.category ?? '');
const kitchenSink = (p) => p.category === 'kitchen_sink';
// What comes in the box: the product page's Includes list. On a sink it is kept
// (P-200D is P-200 with its pop-up drain), so a sink without one includes none;
// the PIM keeps no such list for a faucet, and nothing is said for it.
const included = (p) => list(attr(p).accessories_included).map(String);
const includedSkus = (p, re) => included(p).filter((a) => re.test(a)).map((a) => a.match(/\(([A-Za-z0-9-]+)\)/)?.[1]).filter(Boolean);
const withFaucet = (p) => !isSink(p) || /faucet/i.test(`${included(p).join(' ')} ${titleOf(p).replace(/faucet holes?/gi, '')}`);
// A sink's faucet holes: its own count, else the count the faucet fields carry (0 on a sink without a deck).
const faucetHoles = (p) => { const own = num(attr(p).number_of_faucet_holes); return own === '' ? num(attr(p).number_of_installation_holes) : own; };
const outside = (p) => attr(p).external_dimensions_in ?? {};
const mountOf = (p) => words(attr(p).mounting_type || list(attr(p).installation_type)[0] || '');
const escaped = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The longest of a list's names that a text holds as a word ("Graphite Black" → "Black").
const namedIn = (options, text) => options.filter((o) => new RegExp(`\\b${escaped(o)}\\b`, 'i').test(text ?? '')).sort((a, b) => b.length - a.length)[0] ?? '';
const notApplicable = (text) => /does not apply|not applicable|^none$|^no$|^n\/a$/i.test(words(text));
// A faucet's sensor, from its own field, its type and its name.
const sensorOf = (p) => `${attr(p).sensor_activation ?? ''} ${p.product_type ?? ''} ${titleOf(p)}`;
// The spray head's modes ("Shower, Stream, Blade" → 3).
const sprayModes = (p) => String(attr(p).spray_head_functions ?? '').split(/[,;]/).map(words).filter((m) => m && !notApplicable(m));
const bowlCount = (p) => { const b = attr(p).bowl_configuration ?? ''; return /triple/i.test(b) ? 3 : /double/i.test(b) ? 2 : /single/i.test(b) ? 1 : num(attr(p).number_of_bowls); };
const basinSplit = (p) => words(attr(p).basin_split || attr(p).bowl_split).replace(/\s/g, '');
const isJpg = (url) => /\.jpe?g(?:[?#]|$)/i.test(String(url ?? ''));
const isMp4 = (url) => /\.mp4(?:[?#]|$)/i.test(String(url ?? ''));

// Canada's order for artwork with text, as every push to a Canadian store: the
// English-French set, else the English one (with the French one), else
// English-Spanish — plus the photos without language. The main image first.
function canadaGallery(images) {
  const langs = [['en_fr'], ['en', 'fr'], ['en_es']].find((set) => images.some((m) => m.language === set[0])) ?? [];
  return images.filter((m) => !m.language || langs.includes(m.language)).map((m) => getMediaUrl(m.storage_path)).filter(Boolean);
}

// One PDF of a kind for a column's language: its own language first, then the
// bilingual file; a file without language (the brand's warranty) is English.
const DOC_KINDS = {
  installationguide: ['installation_manual', 'installation_undermount', 'installation_dual_mount', 'installation_drop_in', 'installation_top_mount'],
  dimensionguide: ['spec_sheet'],
  warranty: ['warranty_file'],
};
function docFor(docs, kind, french) {
  const types = DOC_KINDS[kind];
  if (!types) return '';
  const order = french ? ['fr', 'en_fr'] : ['en', 'en_fr', ''];
  const mine = docs.filter((d) => types.includes(d.raw) && order.includes(d.lang ?? ''));
  mine.sort((a, b) => order.indexOf(a.lang ?? '') - order.indexOf(b.lang ?? '') || types.indexOf(a.raw) - types.indexOf(b.raw));
  return mine[0] ? getMediaUrl(mine[0].url) : '';
}
function videoFor(videos, french) {
  const order = french ? ['fr', 'en_fr'] : ['en', 'en_fr', ''];
  const mine = videos.filter((v) => isMp4(v.storage_path) && order.includes(v.language ?? ''));
  mine.sort((a, b) => order.indexOf(a.language ?? '') - order.indexOf(b.language ?? ''));
  return mine[0] ? getMediaUrl(mine[0].storage_path) : '';
}

// Rona's colour families from the PIM's Color, and from the Finish where the
// Color is a word the list lacks ("Silver": brushed nickel, stainless steel).
function colorFamily(p, options) {
  const color = words(p.color);
  const has = (name) => options.find((o) => norm(o) === norm(name));
  if (/\band\b|\//i.test(color)) return has('Multiple colors') ?? '';
  // The longest name the finish holds: "Stainless steel" before "Steel".
  const inFinish = options.filter((o) => new RegExp(`\\b${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(p.finish ?? '')).sort((a, b) => b.length - a.length);
  return has(color) ?? inFinish[0] ?? '';
}

// "5 Years" + "Limited" → "5-year limited"; "Lifetime" + "Limited" → "Limited lifetime".
function warrantyChoices(p) {
  const length = words(attr(p).warranty_length);
  const limited = /limited/i.test(`${attr(p).warranty ?? ''} ${length}`);
  if (/lifetime/i.test(length)) return limited ? ['Limited lifetime', 'Lifetime'] : ['Lifetime'];
  const m = length.match(/(\d+)\s*-?\s*(year|month|day)/i);
  if (!m) return [];
  const base = `${m[1]}-${m[2].toLowerCase()}`;
  return limited ? [`${base} limited`, base] : [base];
}

// ---- what each column takes --------------------------------------------------
// Keyed by the column's name without spaces or signs. A rule answers with the
// value (or, for a pick list, the candidates to look up in the file's list);
// `x` holds what was read for the product and the column's own list.
const RULES = {
  sku: (p) => p.sku,
  productstatus: () => 'active',
  productiscurrentlyavailableinronastores: () => 'No',
  manufacturerpartnumber: (p) => p.sku,
  productnameenglish: (p, x) => capped(titleOf(p), 128, p.sku, 'the English name', x.notes),
  productnamefrench: (p, x) => capped(attr(p).general_title_fr, 128, p.sku, 'the French name', x.notes),
  marketingcopyenglish: (p) => plain(p.description),
  marketingcopyfrench: (p) => plain(attr(p).description_fr),
  upc: (p) => String(attr(p).upc ?? '').replace(/\D/g, ''),
  brand: (p) => p.brand ?? '',
  manufacturername: (p) => (/azuni/i.test(p.brand ?? '') ? 'Azuni' : attr(p).manufacturer ?? ''),
  bilingualpackaginganddocumentation: () => 'Bilingual',
  consumerunitsellinguom: () => 'EA - Each',
  unitcostwithoutshippingfees: (p) => num(p.cost_cad_rona_hd),
  // The answers of the file Vladimir filled by hand (user, 2026-11-20: "para
  // tomarlo de ejemplo para llenar dichos campos faltantes"), the same for every
  // product of every category: no shipping cost on top, ships in 1 business day,
  // returns accepted — and the Hazmat code left empty, as he left it.
  unitcostwithshippingfees: () => 0,
  currencycode: () => 'CAD',
  msrp: (p) => num(p.map_cad), // Rona's MSRP is the MAP (user, 2026-11-09)
  map: (p) => num(p.map_cad),
  shippedinhowmanyboxes: (p) => String(boxCount(p, MAX_BOXES)),
  countryoforigin: (p, x) => countryFromList(attr(p).country_of_origin, x.options),
  // Everything ships from the Cambridge warehouse, by parcel (the Vendor Quote Sheet's own answers).
  isyouritemcrossingaborder: () => 'No',
  hscode: (p) => { const d = String(attr(p).hs_code_ca || attr(p).hs_code || '').replace(/\D/g, ''); return d ? d.padEnd(10, '0').slice(0, 10) : ''; },
  isitemonaskid: () => 'No',
  isltlshippingrequired: () => 'No',
  leadtimebusinessdays: () => 1,
  isreturnable: () => 'Yes',
  warehouseaddress1: () => `${WAREHOUSE.address}, ${WAREHOUSE.postalCode}`,
  doesproductcontainswood: (p) => yesNo(/wood|bamboo|acacia|teak|walnut|maple|\boak\b|paper/i.test(materials(p))),
  doesproductcontainscompositewood: (p) => yesNo(/composite wood|wood fib|\bmdf\b|particle ?board|plywood/i.test(materials(p))),
  imagesfrontfacingimageenglish: (p, x) => x.main,
  imagesfrontfacingimagefrench: (p, x) => x.main, // "if only one image is available, use the same for both"
  // Made here only when it is made in Canada, and then a person confirms Rona's three conditions.
  wellmadehere: (p) => (attr(p).country_of_origin && !/^canada$/i.test(attr(p).country_of_origin) ? 'No' : ''),
  title: (p, x) => capped(titleOf(p), 128, p.sku, 'the title', []) || x.none,

  // ---- faucets ----
  '1holesinkcompatible': (p) => holes(p, 1),
  '2holesinkcompatible': (p) => holes(p, 2),
  // A single-hole faucet covers a three-hole sink when its deck plate comes with it.
  '3holesinkcompatible': (p) => (num(attr(p).number_of_installation_holes) === '' ? '' : yesNo(num(attr(p).number_of_installation_holes) === 3 || switchOn(attr(p).deck_plate_included))),
  activationmethod: (p) => {
    const t = `${attr(p).sensor_activation ?? ''} ${titleOf(p)}`;
    if (/touchless|sensor|motion/i.test(t)) return 'Touchless';
    if (/\btouch\b/i.test(t)) return 'Touch';
    return num(attr(p).number_of_handles) > 0 || attr(p).handle_style ? 'Handle' : '';
  },
  antimicrobial: (p) => (/antimicrob|antibacter/i.test(tagsOf(p)) ? 'Yes' : ''),
  // From the PIM's Application; a kitchen sink has none and takes the example's answer.
  commercialresidential: (p) => {
    const a = attr(p).application ?? '';
    const com = /non.?residential|commercial/i.test(a);
    const res = /(^|;|\s)residential/i.test(a.replace(/non.?residential/gi, ''));
    if (com || res) return com && res ? 'Commercial/Residential' : com ? 'Commercial' : 'Residential';
    return kitchenSink(p) ? 'Commercial/Residential' : '';
  },
  // Lead free by the PIM's own marks: Lead Free, California's AB 100, the Safe Drinking Water Act.
  complieswithfederalleadguidelines: (p) => (attr(p).lead_free === true || isYes(attr(p).lead_free) || isYes(attr(p).ab_100_compliant) || isYes(attr(p).sdwa_compliant) ? 'Yes' : ''),
  corrosionresistant: (p) => (/rust|corrosion/i.test(tagsOf(p)) ? 'Yes' : ''),
  deckplateincluded: (p) => yesNo(switchOn(attr(p).deck_plate_included)),
  fingerprintresistant: (p) => (/fingerprint|spot/i.test(tagsOf(p)) ? 'Yes' : ''),
  fixturecolorfamily: (p, x) => colorFamily(p, x.options),
  fixturefinish: (p) => [attr(p).finish_type, { Glossy: 'Gloss' }[attr(p).finish_type]],
  handletype: (p) => attr(p).handle_style ?? '',
  handlesincluded: (p) => yesNo(switchOn(attr(p).handles_included)),
  manufacturercolorfinish: (p) => p.finish ?? '',
  // A sink sold without a faucet has no flow: the list's own "N/A" where it has one.
  maxflowrate: (p, x) => {
    const n = num(attr(p).max_flow_rate);
    if (n !== '') return x.options.find((o) => parseFloat(o) === n) ?? `${n} GPM`;
    return !withFaucet(p) && x.options.some((o) => norm(o) === 'na') ? 'N/A' : '';
  },
  maximumfaucetheightin: (p) => num(attr(p).faucet_height_in),
  mountinglocation: (p) => { const m = `${attr(p).mounting_type ?? ''} ${list(attr(p).installation_type).join(' ')}`; return /wall/i.test(m) ? 'Wall-mount' : /deck|single|hole|centerset|widespread|vessel/i.test(m) ? 'Deck-mount' : ''; },
  mountingtype: (p) => { const m = words(attr(p).mounting_type); return [m, m.replace(/-/g, ' '), /single/i.test(m) ? 'Single hole' : '']; },
  numberoffaucethandles: (p) => { const n = num(attr(p).number_of_handles); return n === '' ? '' : `${n}-handle`; },
  // A faucet sold with its tap or dispenser is more than one item, and the PIM does not count them: left for a person.
  packagequantity: (p) => (p.category === 'kitchen_faucet_combo' ? '' : boxCount(p, 99)),
  // The PIM records a pull-down spray where there is one.
  pulldownsprayer: (p) => yesNo(/pull.?down|pull.?out/i.test(`${attr(p).spray_type ?? ''}`)),
  scratchresistant: (p) => (/scratch/i.test(tagsOf(p)) ? 'Yes' : ''),
  soaporlotiondispenser: (p) => yesNo(/soap|lotion|dispenser/i.test(describes(p))),
  spoutheightin: (p) => num(attr(p).spout_height_in),
  spoutreachin: (p) => num(attr(p).spout_reach_in),
  spouttype: (p) => attr(p).spout_type ?? '',
  supplylinesincluded: (p) => (isSink(p) ? '' : yesNo(switchOn(attr(p).supply_line_included))),
  valveincluded: (p) => yesNo(switchOn(attr(p).valve_included)),
  warranty: (p) => warrantyChoices(p),
  collectionname: (p) => p.series || 'N/A',

  // ---- sinks ----
  // What a sink is, from its own type and name.
  corner: (p) => yesNo(/\bcorner\b/i.test(describes(p))),
  trough: (p) => yesNo(/\btrough\b/i.test(describes(p))),
  cutoutlengthin: (p) => num(attr(p).cut_out_dimensions_in?.length),
  cutoutwidthin: (p) => num(attr(p).cut_out_dimensions_in?.width),
  depthofbowlin: (p) => num(attr(p).internal_dimensions_in?.depth),
  // Rona's length, width and height are the PIM's length, width and depth.
  overalllengthin: (p) => num(outside(p).length),
  overallwidthin: (p) => num(outside(p).width),
  overallheightin: (p) => num(outside(p).depth),
  // A vessel stands on the counter with its whole height; an undermount sink is all below it.
  heightabovecounterin: (p) => (/vessel/i.test(mountOf(p)) ? num(outside(p).depth) : /under/i.test(mountOf(p)) ? 0 : ''),
  weightlbs: (p) => num(attr(p).product_weight_lb),
  drainconnectiondiameterin: (p) => num(attr(p).drain_diameter_in),
  // A kitchen sink's drain is its strainer.
  drainincluded: (p) => (included(p).some((a) => /drain|strainer/i.test(a)) ? 'Yes' : isSink(p) ? 'No' : ''),
  // The finish of the drain that comes with it, as the PIM has that drain.
  drainfinish: (p, x) => {
    if (!isSink(p)) return '';
    const drain = includedSkus(p, /drain/i).map((sku) => x.parts[sku]).find(Boolean);
    if (!included(p).some((a) => /drain/i.test(a))) return 'No drain included';
    return drain ? [drain.finish, drain.color, drain.color && drain.color === p.color ? 'Matches sink' : ''] : '';
  },
  faucetincluded: (p) => (isSink(p) ? yesNo(withFaucet(p)) : ''),
  manufacturerfaucetfinish: (p) => (isSink(p) && !withFaucet(p) ? 'N/A' : ''),
  numberoffaucetholes: (p) => { const n = faucetHoles(p); return n === '' ? '' : String(n); },
  faucetholespacing: (p) => {
    const n = faucetHoles(p);
    if (n === '') return '';
    if (n <= 2) return ['None', 'Single hole', 'Double hole'][n];
    const gap = `${attr(p).faucet_hole_center_spacing ?? ''} ${attr(p).faucet_centers ?? ''}`;
    return /\b4\b/.test(gap) ? '4-in centerset' : /\b8\b/.test(gap) ? '8-in widespread' : '';
  },
  forcommercialuse: (p) => { const a = attr(p).application ?? ''; return a ? yesNo(/commercial|non.?residential/i.test(a)) : ''; },
  material: (p) => [p.material, /vitreous/i.test(p.material ?? '') ? 'Vitreous china' : ''],
  mounttype: (p) => { const m = mountOf(p); return [m, /top.?mount/i.test(m) ? 'Drop-in' : '', /dual/i.test(m) ? 'Drop-in or undermount' : '']; },
  overflowdrain: (p) => { const o = attr(p).overflow; return o === undefined || o === null || o === '' ? '' : yesNo(isYes(o)); },
  sinkshape: (p) => attr(p).sink_shape ?? '',
  stainresistant: (p) => (/stain/i.test(tagsOf(p)) ? 'Yes' : ''),
  faderesistant: (p) => (/fade/i.test(tagsOf(p)) ? 'Yes' : ''),
  rustresistant: (p) => (/rust/i.test(tagsOf(p)) ? 'Yes' : ''),
  // "If item's Material is anything other than Wood, populate with N/A."
  woodspecies: (p, x) => (/wood|bamboo|acacia|teak/i.test(p.material ?? '') ? namedIn(x.options, materials(p)) : 'N/A'),

  // ---- kitchen faucets ----
  '4holesinkcompatible': (p) => holes(p, 4),
  // What the faucet is, from its category, its type and its name. A drinking water tap is none of Rona's types.
  faucettype: (p) => {
    const t = `${p.product_type ?? ''} ${titleOf(p)}`;
    if (p.category === 'pot_filler' || /pot filler/i.test(t)) return 'Pot filler';
    if (p.category === 'cold_water_tap') return '';
    return /pre.?rinse/i.test(t) ? 'Pre-rinse' : /\bbridge\b/i.test(t) ? 'Bridge' : /\bbar\b|\bprep\b/i.test(t) ? 'Bar and prep' : 'Standard';
  },
  maximumdeckthicknessin: (p) => num(attr(p).max_deck_thickness_in),
  // The spray head's holder ("Magnetic Holder", "Self Retracting"); "Does Not Apply" = a faucet with no head to dock.
  securedocking: (p) => { const l = words(attr(p).lock_type); return l ? yesNo(!notApplicable(l)) : ''; },
  dockingtechnology: (p) => { const l = words(attr(p).lock_type); return notApplicable(l) ? '' : l; },
  // The PIM's Spray Type names the spray a faucet has; a side spray is none of ours unless it says so.
  sidesprayincluded: (p) => { const s = words(attr(p).spray_type); return s ? yesNo(/side/i.test(s)) : ''; },
  sprayheadstyle: (p) => { const s = words(attr(p).spray_type); return /pull.?down/i.test(s) ? 'Pull-down' : /pull.?out/i.test(s) ? 'Pull-out' : s ? 'Fixed' : ''; },
  sprayandstream: (p) => { const m = sprayModes(p); return m.length ? yesNo(m.length >= 2 && m.some((w) => /spray|shower|blade|sweep/i.test(w))) : ''; },
  numberofspraysettings: (p) => sprayModes(p).length || '',
  swivel: (p) => { const s = attr(p).swivel_spout; return s === undefined || s === null || s === '' ? '' : yesNo(isYes(s)); },
  valvetype: (p) => { const c = words(attr(p).cartridge_type); return /ceramic/i.test(c) ? 'Ceramic disc valve' : /\bball\b/i.test(c) ? 'Ball valve' : /compression/i.test(c) ? 'Compression valve' : /cartridge/i.test(c) ? 'Cartridge valve' : ''; },
  activationtechnology: (p) => words(attr(p).sensor_activation),
  higharcspout: (p) => { const s = words(attr(p).spout_type); return /high.?arc|gooseneck/i.test(s) ? 'Yes' : /low.?arc|mid.?arc/i.test(s) ? 'No' : ''; },
  leadfree: (p) => { const l = attr(p).lead_free; return l === undefined || l === null || l === '' ? '' : yesNo(l === true || isYes(l)); },
  touchless: (p) => (isSink(p) ? '' : yesNo(/touchless|sensor|motion/i.test(sensorOf(p)))),
  touchsensor: (p) => (isSink(p) ? '' : yesNo(/\btouch\b/i.test(sensorOf(p)))),

  // ---- kitchen sinks ----
  bowlconfiguration: (p) => {
    const n = bowlCount(p);
    if (n === 1) return 'Single bowl';
    if (n === 3) return 'Triple bowl';
    if (n !== 2 || !basinSplit(p)) return '';
    return basinSplit(p) === '50/50' ? 'Double equal bowl' : 'Double offset bowl';
  },
  basinsplit: (p) => (bowlCount(p) > 1 ? basinSplit(p) : ''),
  // Brushed stainless steel is its own family on Rona's list; a colour with two words takes the one the list has.
  colorfinishfamily: (p, x) => [/stainless/i.test(p.material ?? '') && /silver|stainless/i.test(p.color ?? '') ? 'Stainless steel' : '', p.color, namedIn(x.options, p.color)],
  cornerinstallation: (p) => yesNo(/\bcorner\b/i.test(describes(p))),
  // Bowl 1 is the left one of a double sink.
  depthofbowl1in: (p) => { const left = num(attr(p).left_bowl_depth_in); return bowlCount(p) > 1 && left !== '' ? left : num(attr(p).internal_dimensions_in?.depth); },
  depthofbowl2in: (p) => (bowlCount(p) > 1 ? num(attr(p).right_bowl_depth_in) : ''),
  drainboardincluded: (p) => (isSink(p) ? yesNo(included(p).some((a) => /drain ?board/i.test(a))) : ''),
  drainlocation: (p) => { const d = words(attr(p).drain_hole_location || attr(p).drain_position); return /corner/i.test(d) ? 'Corner' : /rear/i.test(d) ? 'Rear' : /cent(er|re)/i.test(d) ? 'Center' : /side|offset/i.test(d) ? 'Offset' : ''; },
  // The PIM's drain location says it ("Side Drain / Reversible"); one that does not ("Rear Center") is a No.
  reversible: (p) => { const d = words(attr(p).drain_hole_location); return d ? yesNo(/reversible/i.test(d)) : ''; },
  // What a kitchen sink answers to the questions the PIM has no field for: the
  // answers of the file Vladimir filled by hand for the Azuni sinks (user,
  // 2026-11-20), taken for every kitchen sink. The heat a sink stands is the
  // stainless steel's: a granite sink's own number is not in the PIM.
  compatiblewithgarbagedisposals: (p) => (kitchenSink(p) ? 'Yes' : ''),
  heatresistanceindegreesf: (p) => (kitchenSink(p) && /stainless/i.test(p.material ?? '') ? '600+' : ''),
  itemsrequiredforassembly: (p) => (kitchenSink(p) ? 'No' : ''),
  knockoutholesincluded: (p) => (kitchenSink(p) ? 'No' : ''),
  mountinghardwareincluded: (p) => (kitchenSink(p) ? 'Yes' : ''),
  noiseinsulation: (p) => (kitchenSink(p) ? 'Yes' : ''),
  safetylisting: (p) => (kitchenSink(p) ? 'Not third party lab tested' : ''),
  style: (p) => (kitchenSink(p) ? 'Modern/Contemporary' : ''),
  finish: (p) => [attr(p).finish_type, { Glossy: 'Gloss' }[attr(p).finish_type]],
  lengthin: (p) => num(outside(p).length),
  widthin: (p) => num(outside(p).width),
  sinkgridincluded: (p) => yesNo(switchOn(attr(p).includes_grids) || switchOn(attr(p).has_grid) || included(p).some((a) => /\bgrids?\b/i.test(a))),
  sinkmounttype: (p) => { const m = mountOf(p); return [/dual/i.test(m) ? 'Drop-in or undermount' : '', /top.?mount/i.test(m) ? 'Drop-in' : '', m]; },
  sinktype: (p) => { const t = `${p.product_type ?? ''} ${titleOf(p)}`; return /farmhouse|apron/i.test(t) ? 'Apron-front' : p.category === 'bar_prep_sink' ? 'Bar & Prep' : 'Standard'; },
  strainerincluded: (p) => (isSink(p) ? yesNo(included(p).some((a) => /strainer/i.test(a))) : ''),
  workstation: (p) => yesNo(attr(p).has_workstation === true || /workstation/i.test(`${p.product_type ?? ''} ${titleOf(p)} ${p.model_name ?? ''}`)),
  // The cabinet the sink needs, on Rona's list of cabinet sizes: the next size up.
  minimumcabinetsize: (p, x) => {
    const n = num(attr(p).min_external_cabinet_size_in);
    if (n === '') return '';
    const sizes = x.options.map((o) => ({ o, size: /^\d/.test(o) ? parseFloat(o) + (/1\/2/.test(o) ? 0.5 : 0) : null })).filter((s) => s.size !== null).sort((a, b) => a.size - b.size);
    if (!sizes.length) return '';
    if (n < sizes[0].size) return x.options.find((o) => /^less than/i.test(o)) ?? '';
    return sizes.find((s) => s.size >= n)?.o ?? x.options.find((o) => /^greater than/i.test(o)) ?? '';
  },
  seriesname: (p) => p.series ?? '',
  sinkgauge: (p) => { const g = num(attr(p).gauge ?? attr(p).material_gauge); return g !== '' ? String(g) : /stainless/i.test(p.material ?? '') ? '' : 'N/A'; },
};
function holes(p, n) {
  const count = num(attr(p).number_of_installation_holes);
  return count === '' ? '' : yesNo(count === n);
}

// Columns that come in numbered groups.
const PATTERNS = [
  [/^box(\d+)shippinginfodescription$/, (p, x, m) => (Number(m[1]) <= x.boxes ? words(titleOf(p)) : '')],
  [/^box(\d+)(depth|width|height|weight)$/, (p, x, m) => {
    if (Number(m[1]) > x.boxes) return '';
    // Rona measures a box by its long side, its short side and its height (as on the Vendor Quote Sheet).
    return { depth: x.box?.length ?? '', width: x.box?.width ?? '', height: x.box?.height ?? '', weight: num(p.shipping_weight_lb ?? attr(p).shipping_weight_lb) }[m[2]];
  }],
  [/^supplierbullet(\d+)$/, (p, x, m) => capped(list(attr(p).bullet_points)[Number(m[1]) - 1] ?? '', 250, p.sku, `bullet ${m[1]}`, x.notes)],
  [/^pdf(.+?)(english|french)$/, (p, x, m) => docFor(x.docs, m[1], m[2] === 'french')],
  [/^videourlproductdemo(english|french)$/, (p, x, m) => videoFor(x.videos, m[1] === 'french')],
  // The prices the PIM read on the other Canadian stores' pages.
  [/^(homedepot|wayfair|walmart|amazon|bestbuy)ca$/, (p, x, m) => x.prices[`${m[1]}_ca`]?.[p.sku] ?? ''],
];
// The image columns after the two front-facing ones take the rest of the
// gallery in the PIM's own order: the PIM does not say which photo is a silo,
// a lifestyle or a close-up.
const GALLERY_SLOT = /^images(silo|roomlifestyle|detailfeature|vignettelifestyle)/;

/** The PIM's own record of what comes with the products ("Pop-up Drain (D-701H)" → D-701H): sku → { sku, color, finish }. */
async function includedParts(products) {
  const skus = [...new Set(products.flatMap((p) => includedSkus(p, /./)))];
  const out = {};
  for (let i = 0; i < skus.length; i += 100) {
    const { data, error } = await supabase.from('products').select('sku, color, finish').in('sku', skus.slice(i, i + 100));
    if (error) throw error;
    for (const part of data ?? []) out[part.sku] = part;
  }
  return out;
}

/** The help sheet as columns: [{ requirement, type, options }] by column index. */
function readGlossary(grid) {
  const head = grid.findIndex((row) => row && norm(row[0] ?? '') === 'sku');
  if (head === -1) throw new Error(`Rona changed its DSCO file: the "${HELP_SHEET}" sheet no longer lists the columns from "sku".`);
  const names = grid[head] ?? [];
  const requirement = grid[head + 2] ?? [];
  const type = grid[head + 3] ?? [];
  const options = [];
  for (let r = head + 4; r < grid.length; r++) {
    (grid[r] ?? []).forEach((v, ci) => { if (v !== undefined && v !== null && String(v).trim() !== '') (options[ci] ??= []).push(String(v)); });
  }
  return { names, column: (ci) => ({ requirement: requirement[ci] ?? '', type: type[ci] ?? '', options: options[ci] ?? [] }) };
}

/**
 * Fills an opened DSCO catalog file with the products that belong in it.
 * @returns {{ count, skipped, skippedReason, missingData, fillReport }}
 */
export async function fillRonaDsco({ zip, shared }, templateStoragePath, products, fileName, { task = null } = {}) {
  const path = await sheetPathByName(zip, DATA_SHEET);
  const helpPath = await sheetPathByName(zip, HELP_SHEET);
  if (!helpPath) throw new Error(`This Rona DSCO file has no "${HELP_SHEET}" sheet: its columns' lists are read from it.`);
  let xml = await zip.file(path).async('string');
  const grid = sheetToGrid(xml, shared);
  const header = (grid[0] ?? []).map((h) => words(h));
  if (norm(header[0] ?? '') !== 'sku') throw new Error(`Rona changed its DSCO file: "${DATA_SHEET}" no longer starts with the sku column.`);
  const glossary = readGlossary(sheetToGrid(await zip.file(helpPath).async('string'), shared));

  // What the file itself says it is: the retailer id and the category on its first row.
  const col = (name) => header.findIndex((h) => h === name);
  const retailerCol = col('sftp_retailer_id');
  const categoryCol = col('sftp_category');
  const retailerId = retailerCol === -1 ? '' : grid[1]?.[retailerCol] ?? '';
  const categoryPath = categoryCol === -1 ? '' : grid[1]?.[categoryCol] ?? '';
  if (!categoryPath) throw new Error('This Rona DSCO file does not say its category (sftp_category on row 2). Download it again from DSCO for one category.');
  const categoryName = categoryPath.split('||').pop().trim();
  const fits = CATEGORY_FITS.find(([re]) => re.test(categoryName));
  const kept = fits ? products.filter(fits[1]) : products;
  const skipped = products.filter((p) => !kept.includes(p)).map((p) => p.sku);
  if (!kept.length) {
    throw new Error(`This DSCO file is Rona's "${categoryName}" category: it takes ${fits[2]} only, and none of the products chosen is one. Upload the DSCO file of their own category in Templates.`);
  }

  const skus = kept.map((p) => p.sku);
  task?.progress(0.1, 'Reading images, documents and store prices…');
  const [images, docs, videos, prices, parts] = await Promise.all([fetchImagesBySku(skus), fetchDocsBySku(skus), fetchVideosBySku(skus), competitorPrices(skus), includedParts(kept)]);
  task?.progress(0.45, 'Filling the sheet…');

  // Each column once: its rule, its list and whether Rona requires it.
  const gallerySlots = new Map(); // column index → place in the gallery
  const columns = header.map((name, ci) => {
    if (!name) return null;
    const key = norm(name);
    const spec = glossary.column(norm(glossary.names[ci] ?? '') === key ? ci : glossary.names.findIndex((n) => norm(n ?? '') === key));
    let rule = null;
    let match = null;
    if (GALLERY_SLOT.test(key)) {
      gallerySlots.set(ci, gallerySlots.size);
      rule = (p, x) => x.gallery[gallerySlots.get(ci)] ?? '';
    } else if (RULES[key]) rule = RULES[key];
    else {
      const hit = PATTERNS.find(([re]) => re.test(key));
      if (hit) { rule = hit[1]; match = key.match(hit[0]); }
    }
    // The DSCO platform's own optional columns repeat Rona's under other names ("msrp", "warranty"): left alone.
    if (/^optional$/i.test(spec.requirement)) rule = null;
    // A list's entry is looked up as it is written first: without their signs "600+" and "600" are the same word.
    const byText = new Map(spec.options.map((o) => [words(o).toLowerCase(), o]));
    return { ci, name, rule, match, required: /^required$/i.test(spec.requirement), number: /^number/i.test(spec.type), whole: /no decimal/i.test(spec.type), options: spec.options, byText, byNorm: new Map(spec.options.map((o) => [norm(o), o])) };
  });

  const styles = columnStyles(xml);
  const notes = []; // texts that were cut
  const offList = new Map(); // column name → Map(value → [sku])
  const empty = new Map(); // required column name → [sku]
  const filled = new Map(); // required column index → rows filled
  const rowCells = kept.map((p) => {
    const all = images[p.sku] ?? [];
    const pictures = canadaGallery(all).filter(isJpg);
    const main = all[0] && isJpg(all[0].storage_path) ? getMediaUrl(all[0].storage_path) : '';
    if (all[0] && !main) notes.push(`${p.sku}: its main image is not a JPG, and Rona takes JPG only`);
    const x = { notes, prices, parts, docs: docs[p.sku] ?? [], videos: videos[p.sku] ?? [], main, gallery: pictures.filter((u) => u !== main), box: boxSize(p), boxes: boxCount(p, MAX_BOXES), none: '' };
    const cells = new Map();
    for (const c of columns) {
      if (!c) continue;
      let value = '';
      if (c.ci === retailerCol) value = num(retailerId) === '' ? retailerId : num(retailerId);
      else if (c.ci === categoryCol) value = categoryPath;
      else if (c.rule) {
        const raw = c.rule(p, { ...x, options: c.options }, c.match);
        if (c.options.length) {
          // A pick list: the file's own spelling of one of the candidates, or nothing.
          const tries = [raw].flat().map((v) => words(v)).filter(Boolean);
          value = tries.map((t) => c.byText.get(t.toLowerCase()) ?? c.byNorm.get(norm(t))).find(Boolean) ?? '';
          if (!value && tries.length) {
            const seen = offList.get(c.name) ?? new Map();
            seen.set(tries[0], [...(seen.get(tries[0]) ?? []), p.sku]);
            offList.set(c.name, seen);
          }
        } else if (c.number) {
          const n = num(raw);
          value = n === '' ? '' : c.whole ? Math.round(n) : n;
        } else value = typeof raw === 'number' ? raw : words(raw);
      }
      if (c.required) {
        if (value === '') empty.set(c.name, [...(empty.get(c.name) ?? []), p.sku]);
        else filled.set(c.ci, (filled.get(c.ci) ?? 0) + 1);
      }
      if (value !== '') cells.set(c.ci + 1, value);
    }
    return cells;
  });

  // Row 2 is in the file (its retailer id and category): the first product goes
  // into it, the others into rows of the same shape after it.
  const rowAttrs = xml.match(/<row r="2"([^>]*?)\/?>/)?.[1]?.replace(/\/\s*$/, '') ?? '';
  const xmlOf = (cells, row) => new Map([...cells].map(([ci, v]) => [ci, buildCell(`${indexToCol(ci)}${row}`, v, typeof v === 'number' ? null : styles.get(ci) ?? null)]));
  xml = mergeRows(xml, new Map([[2, xmlOf(rowCells[0], 2)]]));
  const more = rowCells.slice(1).map((cells, i) => {
    const row = 3 + i;
    const body = [...xmlOf(cells, row)].sort((a, b) => a[0] - b[0]).map(([, cell]) => cell).join('');
    return `<row r="${row}"${rowAttrs}>${body}</row>`;
  }).join('');
  if (more) xml = injectRows(xml, more, 1 + rowCells.length);
  zip.file(path, xml);
  // Named apart from the Vendor Quote Sheet of the same products.
  await downloadZip(zip, /dsco/i.test(fileName) ? fileName : `${fileName}_DSCO`, templateExt(templateStoragePath), { task: task?.part(0.55, 1) });

  // What a person still has to look at, shortest first.
  const everywhere = [...empty].filter(([, without]) => without.length === kept.length).map(([name]) => name);
  const some = [...empty].filter(([, without]) => without.length < kept.length);
  const few = (names) => `${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}`;
  const missingData = [
    // Named by the file's category: a selection of several categories downloads a file of each.
    everywhere.length ? `${categoryName} — required by Rona and empty on ${kept.length === 1 ? 'it' : 'every product'} (${everywhere.length} columns): ${everywhere.join(', ')}` : '',
    ...some.map(([name, without]) => `${name}: ${few(without)}`),
    ...[...offList].flatMap(([name, values]) => [...values].map(([value, with_]) => `${name} "${value}" is not on Rona's list: ${few(with_)}`)),
    ...notes,
  ].filter(Boolean);
  if (missingData.length) console.warn('[Rona DSCO export] To look at:', missingData);
  const required = columns.filter((c) => c?.required);
  return {
    count: kept.length,
    skipped: skipped.length ? skipped : undefined,
    skippedReason: skipped.length ? `this DSCO file is Rona's "${categoryName}" category` : undefined,
    missingData,
    fillReport: { rows: kept.length, columns: required.map((c) => ({ label: c.name, filled: filled.get(c.ci) ?? 0 })) },
  };
}
