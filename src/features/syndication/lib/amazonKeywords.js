// Amazon generic keywords (search terms) — user rule 2026-10-14: ONE cell of
// phrases about the product, separated by commas: an English part, then a
// Spanish part, then a French part, at most 250. Amazon counts bytes, so an
// accent counts twice and the 250-character limit always holds.
//
// English and French come from the PIM's own keywords (keywords_en /
// keywords_fr, in their order). The PIM has no Spanish keywords, so the
// Spanish part — and the English or French part of a product without
// keywords — is built from the product's own data: what it is, its material,
// mounting, bowls, size, features and color. The three parts take turns, one
// phrase each, so all three make it before the limit; a phrase that adds no
// new word to its part is skipped. A composite granite sink always says
// "composite" and "granite" in English.

import { channelCategory, isFaucetCategory } from '@/features/products/lib/categories';

const MAX_BYTES = 250;
const attr = (p) => p.attributes || {};
const s = (v) => String(v ?? '').trim();
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const bytes = (t) => new TextEncoder().encode(t).length;
const numText = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? String(Math.round(n * 100) / 100) : '';
};
const isCompositeGranite = (p) => /composite\s*granite|granite\s*composite/i.test(s(p.material));

// ---------- what the product is ----------
function kindOf(p) {
  const c = String(p.category ?? '');
  const title = s(attr(p).general_title_en).toLowerCase();
  const t = `${s(p.product_type)} ${title} ${s(p.model_name)}`.toLowerCase();
  if (c === 'pot_filler' || /pot filler/.test(t)) return 'pot_filler';
  if (c === 'cold_water_tap' || (c === 'kitchen_faucet' && /drinking water|cold water/.test(t))) return 'water_tap';
  if (c === 'bathroom_faucet') return 'bathroom_faucet';
  if (isFaucetCategory(c)) return 'kitchen_faucet';
  if (channelCategory(p) === 'bathroom_sink') return 'bathroom_sink';
  if (c === 'laundry_sink') return 'laundry_sink';
  if (c === 'outdoor_sink') return 'outdoor_sink';
  if (c === 'bar_prep_sink') return 'bar_sink';
  if (c === 'kitchen_sink') return 'kitchen_sink';
  if (/workstation kit|accessories kit/.test(t) || /kit$/i.test(p.sku)) return 'workstation_kit';
  if (/drying mat/.test(t)) return 'drying_mat';
  if (/dish organizer/.test(t)) return 'dish_organizer';
  if (/cutting board/.test(t)) return 'cutting_board';
  if (/serving board/.test(t)) return 'serving_board';
  if (/drying rack|dish rack/.test(t)) return 'drying_rack';
  if (/colander/.test(t)) return 'colander';
  if (/disposal/.test(t)) return 'disposal_adapter';
  if (/strainer cover|cover cap|cap flow/.test(t)) return 'strainer_cover';
  if (/strainer|sink basket/.test(t)) return 'strainer';
  if (/(ceramic|drain) cap$/.test(title)) return 'drain_cap';
  if (/overflow/.test(t) && !/drain/.test(t)) return 'overflow_trim';
  if (/drain/.test(t)) return 'drain';
  if (/deck plate|faucet plate/.test(t)) return 'deck_plate';
  if (/soap|lotion/.test(t)) return 'soap_dispenser';
  if (/hose/.test(t)) return 'faucet_hose';
  if (/scratch|rust|clean/.test(t)) return 'cleaning_kit';
  if (/grid/.test(t)) return 'sink_grid';
  if (/\blid\b/.test(t)) return 'sink_lid';
  return 'sink_accessory';
}

// Its names, most searched first; after the first, short ones (the first
// already says what it is, and every byte counts). Spanish and French nouns carry their gender
// ("f:") so a color agrees with them (tarja negra, fregadero negro).
const NOUNS = {
  kitchen_sink: { en: ['kitchen sink', 'sink'], es: ['fregadero de cocina', 'f:tarja', 'lavaplatos'], fr: ['évier de cuisine', 'évier'] },
  bar_sink: { en: ['bar sink', 'prep sink'], es: ['fregadero de bar', 'f:tarja auxiliar', 'fregadero pequeño'], fr: ['évier de bar', 'évier de préparation'] },
  laundry_sink: { en: ['laundry sink', 'utility sink'], es: ['fregadero de lavandería', 'lavadero', 'f:tarja de servicio'], fr: ['évier de buanderie', 'évier utilitaire'] },
  outdoor_sink: { en: ['outdoor sink', 'outdoor kitchen sink'], es: ['fregadero para exteriores', 'f:tarja para exterior'], fr: ['évier extérieur', 'évier de cuisine extérieure'] },
  bathroom_sink: { en: ['bathroom sink', 'vanity sink'], es: ['lavabo de baño', 'lavamanos', 'f:tarja de baño'], fr: ['lavabo de salle de bain', 'f:vasque'] },
  kitchen_faucet: { en: ['kitchen faucet', 'kitchen sink faucet'], es: ['grifo de cocina', 'f:llave', 'f:mezcladora'], fr: ['robinet de cuisine', 'mitigeur de cuisine'] },
  water_tap: { en: ['drinking water faucet', 'cold water tap'], es: ['grifo de agua potable', 'f:llave de agua fría'], fr: ["robinet d'eau potable", "robinet d'eau froide"] },
  pot_filler: { en: ['pot filler faucet', 'wall mount pot filler'], es: ['grifo llenaollas', 'f:llave de pared para cocina'], fr: ['robinet remplisseur de casseroles', 'robinet mural de cuisine'] },
  bathroom_faucet: { en: ['bathroom faucet', 'vanity faucet'], es: ['grifo de baño', 'f:llave para lavabo', 'f:mezcladora para lavabo'], fr: ['robinet de salle de bain', 'robinet de lavabo'] },
  cutting_board: { en: ['sink cutting board', 'chopping board'], es: ['f:tabla de cortar para fregadero', 'f:tabla de picar'], fr: ['f:planche à découper pour évier', 'f:planche à hacher'] },
  serving_board: { en: ['sink serving board', 'serving tray'], es: ['f:tabla de servir para fregadero', 'f:bandeja para servir'], fr: ['f:planche de service pour évier', 'm:plateau de service'] },
  colander: { en: ['sink colander', 'strainer basket'], es: ['colador para fregadero', 'escurridor de verduras'], fr: ['f:passoire pour évier', 'm:panier égouttoir'] },
  drying_rack: { en: ['dish drying rack', 'over the sink drying rack'], es: ['escurridor de platos', 'escurreplatos para fregadero'], fr: ['égouttoir à vaisselle', "égouttoir au-dessus de l'évier"] },
  drying_mat: { en: ['dish drying mat', 'trivet'], es: ['tapete escurridor de platos', 'salvamanteles'], fr: ['tapis égouttoir', 'dessous de plat'] },
  dish_organizer: { en: ['sink dish organizer', 'dish rack'], es: ['organizador de platos para fregadero', 'escurridor de platos'], fr: ['organisateur de vaisselle pour évier', 'égouttoir à vaisselle'] },
  workstation_kit: { en: ['workstation sink accessories', 'sink accessory kit'], es: ['kit de accesorios para fregadero', 'accesorios para tarja'], fr: ["ensemble d'accessoires pour évier", "kit d'accessoires d'évier"] },
  strainer: { en: ['kitchen sink strainer', 'sink drain basket'], es: ['f:coladera para fregadero', 'f:canastilla de desagüe'], fr: ["f:crépine d'évier", "panier de bonde d'évier"] },
  strainer_cover: { en: ['sink strainer cover', 'drain cover cap'], es: ['f:tapa para coladera de fregadero', 'f:tapa de desagüe'], fr: ['couvercle de crépine', "f:bonde d'évier"] },
  disposal_adapter: { en: ['garbage disposal adapter', 'sink flange adapter'], es: ['adaptador para triturador de basura', 'adaptador de brida para fregadero'], fr: ['adaptateur pour broyeur', "adaptateur de bride d'évier"] },
  drain: { en: ['pop-up sink drain', 'bathroom sink drain stopper'], es: ['desagüe pop-up para lavabo', 'tapón de lavabo'], fr: ['f:bonde clic-clac de lavabo', 'drain de lavabo'] },
  drain_cap: { en: ['pop-up drain cap', 'drain stopper cap'], es: ['f:tapa de desagüe para lavabo', 'tapón de cerámica'], fr: ['capuchon de bonde de lavabo', 'bouchon en céramique'] },
  overflow_trim: { en: ['sink overflow cover', 'overflow ring'], es: ['f:tapa de rebosadero', 'aro de rebosadero para lavabo'], fr: ['cache trop-plein', 'anneau de trop-plein'] },
  deck_plate: { en: ['faucet deck plate', 'sink hole cover'], es: ['f:placa para grifo', 'f:tapa de orificio de fregadero'], fr: ['f:plaque de robinet', "cache-trou d'évier"] },
  soap_dispenser: { en: ['sink soap dispenser', 'kitchen soap dispenser'], es: ['dispensador de jabón para fregadero', 'despachador de jabón'], fr: ['distributeur de savon pour évier', 'distributeur de savon'] },
  faucet_hose: { en: ['faucet supply hose', 'braided faucet connector'], es: ['f:manguera para grifo', 'f:manguera trenzada'], fr: ['tuyau flexible de robinet', 'flexible tressé'] },
  cleaning_kit: { en: ['stainless steel sink scratch remover', 'rust remover kit'], es: ['removedor de rayones para fregadero', 'kit quitaóxido para acero inoxidable'], fr: ['kit anti-rayures pour évier inox', 'détachant de rouille'] },
  sink_grid: { en: ['sink bottom grid', 'sink protector'], es: ['f:rejilla para fregadero', 'protector de fondo'], fr: ["f:grille de fond d'évier", 'protège-évier'] },
  sink_lid: { en: ['sink cover lid'], es: ['f:tapa para fregadero'], fr: ["couvercle d'évier"] },
  sink_accessory: { en: ['sink accessory'], es: ['accesorio para fregadero'], fr: ["accessoire d'évier"] },
};
// The short name a feature or a color goes with ("escurridor enrollable",
// "desagüe con rebosadero", "placa negra mate").
const FAUCET_SHORT = { en: 'faucet', es: 'grifo', fr: 'robinet' };
const SINK_SHORT = { en: 'sink', es: 'fregadero', fr: 'évier' };
const SHORT = {
  kitchen_sink: SINK_SHORT, bar_sink: SINK_SHORT, outdoor_sink: SINK_SHORT,
  laundry_sink: { en: 'utility sink', es: 'lavadero', fr: 'évier' },
  bathroom_sink: { en: 'vanity sink', es: 'lavabo', fr: 'lavabo' },
  kitchen_faucet: FAUCET_SHORT, water_tap: FAUCET_SHORT, pot_filler: FAUCET_SHORT, bathroom_faucet: FAUCET_SHORT,
  cutting_board: { en: 'cutting board', es: 'f:tabla', fr: 'f:planche' },
  serving_board: { en: 'serving board', es: 'f:tabla', fr: 'f:planche' },
  colander: { en: 'colander', es: 'colador', fr: 'f:passoire' },
  drying_rack: { en: 'drying rack', es: 'escurridor', fr: 'égouttoir' },
  drying_mat: { en: 'drying mat', es: 'tapete', fr: 'tapis' },
  dish_organizer: { en: 'dish organizer', es: 'organizador', fr: 'organisateur' },
  workstation_kit: { en: 'sink accessory kit', es: 'kit', fr: 'kit' },
  strainer: { en: 'sink strainer', es: 'f:coladera', fr: 'f:crépine' },
  strainer_cover: { en: 'strainer cover', es: 'f:tapa', fr: 'couvercle' },
  disposal_adapter: { en: 'disposal adapter', es: 'adaptador', fr: 'adaptateur' },
  drain: { en: 'sink drain', es: 'desagüe', fr: 'f:bonde' },
  drain_cap: { en: 'drain cap', es: 'tapón', fr: 'capuchon' },
  overflow_trim: { en: 'overflow cover', es: 'aro de rebosadero', fr: 'cache trop-plein' },
  deck_plate: { en: 'deck plate', es: 'f:placa', fr: 'f:plaque' },
  soap_dispenser: { en: 'soap dispenser', es: 'dispensador', fr: 'distributeur' },
  faucet_hose: { en: 'faucet hose', es: 'f:manguera', fr: 'tuyau' },
  cleaning_kit: { en: 'sink cleaner', es: 'limpiador', fr: 'nettoyant' },
  sink_grid: { en: 'sink grid', es: 'f:rejilla', fr: 'f:grille' },
  sink_lid: { en: 'sink lid', es: 'f:tapa', fr: 'couvercle' },
  sink_accessory: { en: 'sink accessory', es: 'accesorio', fr: 'accessoire' },
};
const nounOf = (raw) => {
  const m = String(raw).match(/^([mf]):(.*)$/);
  return m ? { text: m[2], g: m[1] } : { text: raw, g: 'm' };
};

// ---------- the product's data in three languages ----------
const MATERIALS = [
  [/granite/i, { en: 'granite composite', es: 'de granito compuesto', fr: 'en granit composite' }],
  [/silicone coating/i, { en: 'silicone coated stainless steel', es: 'de acero inoxidable con silicona', fr: 'en acier inoxydable et silicone' }],
  [/stainless/i, { en: 'stainless steel', es: 'de acero inoxidable', fr: 'en acier inoxydable' }],
  [/porcelain|ceramic/i, { en: 'porcelain', es: 'de porcelana', fr: 'en porcelaine' }],
  [/brass/i, { en: 'brass', es: 'de latón', fr: 'en laiton' }],
  [/bamboo/i, { en: 'bamboo', es: 'de bambú', fr: 'en bambou' }],
  [/wood fiber/i, { en: 'wood fiber', es: 'de fibra de madera', fr: 'en fibre de bois' }],
  [/silicone/i, { en: 'silicone', es: 'de silicona', fr: 'en silicone' }],
];
// m / f forms; English has one
const COLORS = [
  [/graphite/i, { en: 'graphite black', es: ['negro grafito', 'negra grafito'], fr: ['noir graphite', 'noire graphite'] }],
  [/matte black/i, { en: 'matte black', es: ['negro mate', 'negra mate'], fr: ['noir mat', 'noire mat'] }],
  [/black/i, { en: 'black', es: ['negro', 'negra'], fr: ['noir', 'noire'] }],
  [/white/i, { en: 'white', es: ['blanco', 'blanca'], fr: ['blanc', 'blanche'] }],
  [/dark gr[ae]y/i, { en: 'dark gray', es: ['gris oscuro', 'gris oscuro'], fr: ['gris foncé', 'gris foncé'] }],
  [/gr[ae]y/i, { en: 'gray', es: ['gris', 'gris'], fr: ['gris', 'grise'] }],
  [/brushed gold/i, { en: 'brushed gold', es: ['dorado cepillado', 'dorada cepillada'], fr: ['or brossé', 'or brossé'] }],
  [/gold/i, { en: 'gold', es: ['dorado', 'dorada'], fr: ['doré', 'dorée'] }],
  [/brushed nickel/i, { en: 'brushed nickel', es: ['níquel cepillado', 'níquel cepillado'], fr: ['nickel brossé', 'nickel brossé'] }],
  [/chrome/i, { en: 'chrome', es: ['cromado', 'cromada'], fr: ['chromé', 'chromée'] }],
  [/gunmetal/i, { en: 'gunmetal', es: ['gris metálico', 'gris metálico'], fr: ['gris métal', 'gris métal'] }],
  [/red/i, { en: 'red', es: ['rojo', 'roja'], fr: ['rouge', 'rouge'] }],
];
const firstMatch = (table, text) => table.find(([re]) => re.test(text))?.[1] ?? null;

function mountOf(p) {
  const t = `${list(attr(p).installation_type).join(' ')} ${s(attr(p).mounting_type)} ${s(p.product_type)} ${s(attr(p).general_title_en)}`;
  if (/farmhouse|apron/i.test(t)) return { en: 'farmhouse', es: 'tipo granja', fr: 'de ferme' };
  if (/vessel/i.test(t)) return { en: 'vessel', es: 'sobre encimera', fr: 'à poser' };
  if (/dual/i.test(t)) return { en: 'dual mount', es: 'bajo encimera o de sobreponer', fr: 'double montage' };
  if (/under/i.test(t)) return { en: 'undermount', es: 'bajo encimera', fr: 'sous plan' };
  if (/drop|top mount/i.test(t)) return { en: 'drop in', es: 'de sobreponer', fr: 'encastrable' };
  if (/wall/i.test(t)) return { en: 'wall mount', es: 'de pared', fr: 'mural' };
  return null;
}

// Phrases built from the data, most relevant first: the name with the
// material, the mounting, the size, the bowls, the features, the color, then
// the other names. A feature or a color goes with the short name.
function builtPhrases(p, lang) {
  const kind = kindOf(p);
  const a = attr(p);
  const title = s(a.general_title_en);
  const nouns = (NOUNS[kind] ?? NOUNS.sink_accessory)[lang].map(nounOf);
  const noun = (i) => nouns[Math.min(i, nouns.length - 1)];
  const short = nounOf((SHORT[kind] ?? SHORT.sink_accessory)[lang]);
  // English puts a word before the name ("roll up drying rack") and a "with …"
  // after it; Spanish and French put both after it.
  const phrase = (n, mod) => (lang === 'en' && !/^with(out)? /.test(mod) ? `${mod} ${n.text}` : `${n.text} ${mod}`);
  const feature = (mods) => phrase(short, mods[lang]);
  const out = [];
  const isSink = /sink$/.test(kind);
  const isFaucet = /faucet|tap|pot_filler/.test(kind);

  const mat = firstMatch(MATERIALS, s(p.material));
  out.push(mat ? phrase(noun(0), mat[lang]) : noun(0).text);
  const mount = mountOf(p);
  if (mount && (isSink || kind === 'pot_filler') && !noun(1).text.includes(mount[lang])) {
    if (lang === 'es' && /o de sobreponer/.test(mount.es)) {
      out.push(phrase(noun(1), 'bajo encimera'), phrase(noun(2), 'de sobreponer'));
    } else out.push(phrase(noun(1), mount[lang]));
  }
  const L = numText(a.external_dimensions_in?.length);
  const inches = (n) => ({ en: `${n} inch`, es: `de ${n} pulgadas`, fr: `de ${n} pouces` }[lang]);
  if (L && isSink) out.push(phrase(noun(lang === 'en' ? 0 : 1), inches(L)));
  // an accessory's title size ("3.5\" Round … Strainer", "16 3/4\" …")
  const titled = title.match(/^(\d+)(?:[ -](\d+)\/(\d+))?(?:\.(\d+))?\s*(?:"|''|in\b|inch)/i);
  if (titled && !isSink && !isFaucet) {
    const n = Number(titled[1]) + (titled[2] ? Number(titled[2]) / Number(titled[3]) : 0) + (titled[4] ? Number(`0.${titled[4]}`) : 0);
    out.push(phrase(short, inches(Math.round(n * 100) / 100)));
  }

  if (isSink && kind !== 'bathroom_sink') {
    const n = Number(a.number_of_bowls);
    const double = n >= 2 || /double/i.test(s(a.bowl_configuration));
    const single = n === 1 || /single/i.test(s(a.bowl_configuration));
    if (double) out.push(phrase(noun(2), { en: 'double bowl', es: 'de doble tina', fr: 'double cuve' }[lang]));
    else if (single) out.push(phrase(noun(2), { en: 'single bowl', es: 'de una tina', fr: 'une cuve' }[lang]));
    if (a.low_divider === true && double) out.push(feature({ en: 'low divider', es: 'con división baja', fr: 'à séparateur bas' }));
    const t = `${s(p.product_type)} ${title} ${list(a.accessories_included).join(' ')}`;
    if (/workstation|cutting board|colander|drying rack/i.test(t)) out.push(feature({ en: 'workstation', es: 'estación de trabajo', fr: 'poste de travail' }));
  }
  if (kind === 'bathroom_sink') {
    const shape = firstMatch([
      [/rectang/i, { en: 'rectangular', es: 'rectangular', fr: 'rectangulaire' }],
      [/oval/i, { en: 'oval', es: 'ovalado', fr: 'ovale' }],
      [/round/i, { en: 'round', es: 'redondo', fr: 'rond' }],
      [/square/i, { en: 'square', es: 'cuadrado', fr: 'carré' }],
    ], s(a.sink_shape));
    if (shape) out.push(phrase(noun(1), shape[lang]));
    if (/^yes$/i.test(s(a.overflow))) out.push(feature({ en: 'with overflow', es: 'con rebosadero', fr: 'avec trop-plein' }));
  }
  if (isFaucet) {
    const t = `${s(p.product_type)} ${title} ${s(a.spray_type)}`;
    if (/pull[- ]?(down|out)/i.test(t)) out.push(phrase(noun(1), { en: /pull[- ]?out/i.test(t) ? 'pull out' : 'pull down', es: 'extraíble', fr: 'à douchette extractible' }[lang]));
    if (s(a.sensor_activation)) out.push(feature({ en: 'touchless', es: 'sin contacto', fr: 'sans contact' }));
    const handles = Number(a.number_of_handles);
    if (handles === 1) out.push(lang === 'fr' ? 'mitigeur monocommande' : feature({ en: 'single handle', es: 'monomando' }));
    else if (handles >= 2) out.push(feature({ en: `${handles} handle`, es: `de ${handles} manijas`, fr: `à ${handles} poignées` }));
    if (/gooseneck|high arc/i.test(s(a.spout_type))) out.push(feature({ en: 'gooseneck', es: 'cuello de cisne', fr: 'col de cygne' }));
    if (/fold/i.test(`${s(a.spout_type)} ${t}`)) out.push(feature({ en: 'foldable', es: 'plegable', fr: 'pliable' }));
    if (a.lead_free === true) out.push(feature({ en: 'lead free', es: 'sin plomo', fr: 'sans plomb' }));
  }
  if (/^(drain|drain_cap|overflow_trim)$/.test(kind)) {
    if (/without overflow|no overflow/i.test(title)) out.push(feature({ en: 'without overflow', es: 'sin rebosadero', fr: 'sans trop-plein' }));
    else if (/overflow/i.test(title) && kind !== 'overflow_trim') out.push(feature({ en: 'with overflow', es: 'con rebosadero', fr: 'avec trop-plein' }));
    if (/vessel/i.test(title)) out.push({ en: 'vessel sink drain', es: 'desagüe para lavabo sobre encimera', fr: 'bonde pour vasque à poser' }[lang]);
  }
  if (a.juice_grooves === true) out.push(feature({ en: 'with juice groove', es: 'con ranura para jugos', fr: 'avec rainure à jus' }));
  // rolls up / folds: only a rack, a mat or an organizer is the thing that does (not a kit holding one)
  if (/^(drying_rack|drying_mat|dish_organizer)$/.test(kind)) {
    if (/roll-?up/i.test(title)) out.push(feature({ en: 'roll up', es: 'enrollable', fr: 'enroulable' }));
    else if (/foldable|collapsible/i.test(title)) out.push(feature({ en: 'foldable', es: 'plegable', fr: 'pliable' }));
  }
  if (a.bpa_free === true) out.push(feature({ en: 'bpa free', es: 'libre de bpa', fr: 'sans bpa' }));

  const color = firstMatch(COLORS, s(p.finish) || s(p.color));
  if (color) out.push(phrase(short, lang === 'en' ? color.en : color[lang][short.g === 'f' ? 1 : 0]));
  for (const n of nouns.slice(1)) out.push(n.text);
  return out;
}

// ---------- the PIM's own keywords ----------
const BRANDS = /\b(stylish|azuni)\b/gi;
const clean = (t) => s(t).toLowerCase().replace(BRANDS, ' ').replace(/[,;"“”]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['a', 'an', 'and', 'the', 'with', 'for', 'of', 'in', 'on', 'to', 'by', 'or', 'x',
  'de', 'del', 'para', 'con', 'el', 'la', 'los', 'las', 'y', 'o', 'sin',
  'du', 'des', 'le', 'les', 'et', 'pour', 'avec', 'en', 'à', 'au', 'aux', 'un', 'une', 'sur', "d'", "l'"]);
const wordsOf = (t) => t.split(/[\s']+/).filter((w) => w && !STOP.has(w));

// A French phrase in the English list is not used (C430L and S-310G hold
// their French title there, 2026-10-14), nor a phrase longer than a third of
// the cell: then the part is built from the data.
const FRENCH = /[éèêàâçùûôî]|\b(évier|robinet|pouces|cuve|bac|planche|acier|inoxydable|avec|pour|sous)\b/i;
function phrasesFor(p, lang) {
  const own = list(attr(p)[`keywords_${lang}`]).map(clean)
    .filter((x) => x && bytes(x) <= MAX_BYTES / 3 && !(lang === 'en' && FRENCH.test(x)));
  const phrases = own.length ? own : builtPhrases(p, lang).map(clean).filter(Boolean);
  if (lang === 'en' && isCompositeGranite(p)) {
    // the first English phrase says "composite" and "granite"
    const i = phrases.findIndex((x) => /composite/.test(x) && /granite/.test(x));
    if (i > 0) phrases.unshift(...phrases.splice(i, 1));
    else if (i < 0) phrases.unshift(`granite composite ${NOUNS[kindOf(p)]?.en[0] ?? 'sink'}`);
  }
  return [...new Set(phrases)];
}

// The phrases each part keeps: { en: [...], es: [...], fr: [...] }.
export function amazonKeywordParts(product) {
  const langs = ['en', 'es', 'fr'];
  const lists = langs.map((lang) => phrasesFor(product, lang));
  const chosen = lists.map(() => []);
  const covered = lists.map(() => new Set());
  const next = lists.map(() => 0);
  const render = () => chosen.flat().join(', ');
  const used = (li) => bytes(chosen[li].join(', '));
  // The part with the fewest bytes so far takes the next phrase, so the three
  // share the 250 evenly; a phrase that does not fit gives way to a shorter one.
  const open = new Set(langs.map((_, li) => li));
  while (open.size) {
    const li = [...open].sort((x, y) => used(x) - used(y) || x - y)[0];
    let added = false;
    while (next[li] < lists[li].length) {
      const phrase = lists[li][next[li]++];
      const ws = wordsOf(phrase);
      if (!ws.length || ws.every((w) => covered[li].has(w))) continue; // says nothing new
      chosen[li].push(phrase);
      if (bytes(render()) > MAX_BYTES) {
        chosen[li].pop();
        continue;
      }
      ws.forEach((w) => covered[li].add(w));
      added = true;
      break;
    }
    if (!added) open.delete(li);
  }
  return Object.fromEntries(langs.map((lang, li) => [lang, chosen[li]]));
}

export function amazonKeywords(product) {
  const { en, es, fr } = amazonKeywordParts(product);
  return [...en, ...es, ...fr].join(', ');
}
