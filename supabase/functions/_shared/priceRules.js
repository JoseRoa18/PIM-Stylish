// What a product's prices must keep to be saved (user, 2026-11-11: "hay que
// meter validaciones en el módulo de pricing … hazlas todas"):
//   · a price or a cost is more than 0 (an empty one is no price);
//   · the Orange and the Purple MAP are never above the Blue MAP — a promotion
//     level cannot be above the regular price;
//   · a cost (WC) is under the MAP of its own level.
// The database refuses anything else whoever writes it — price_problem() /
// products_valid_prices, 20261111_products_valid_prices.sql — and this is the
// same rule in the same words, for the product page's Pricing tab, the
// import preview and a price change the in-app assistant is asked to prepare
// (assistantTools.js, propose_action: a change these rules refuse is never
// shown to the person). Like the UPC rules, only a price that is being set or
// changed is checked. Change the rule there, never only here.
//
// Lives in supabase/functions/_shared so the `assistant` edge function and the
// app run the same code; src/features/products/lib/priceRules.js re-exports it.

const LEVELS = [['', 'Blue'], ['_orange', 'Orange'], ['_purple', 'Purple']];

// One block per price table of the product's Pricing tab. `map(suffix)` and a
// cost's `col(suffix)` name the products column of a level ("" = Blue); the
// labels are the import's column names (PRICE_DEFS in importSchema.js).
const GROUPS = [
  {
    map: (s) => `map${s}_cad`, label: 'MAP CAD', msrp: ['msrp_cad', 'MSRP CAD$'],
    costs: [[(s) => `cost_cad_rona_hd${s}`, 'WC Rona / Home Depot CAD'], [(s) => `cost_cad_wayfair_sod${s}`, 'WC Small Online Dealers CAD']],
  },
  {
    map: (s) => `map${s}_usd`, label: 'MAP USD', msrp: ['msrp_usd', 'MSRP USD$'],
    costs: [[(s) => `cost_usd_lowes_sod_bbb${s}`, "WC Lowe's / HD USA / SOD / BB&B USD"], [(s) => `cost_usd_wayfair${s}`, 'WC Wayfair USD'], [(s) => `cost_usd_menards${s}`, 'WC Menards USD']],
  },
  {
    map: (s) => `map_usd_wayfair_ca${s}`, label: 'MAP Wayfair Canada USD', msrp: null,
    costs: [[(s) => `cost_usd_wayfair_ca${s}`, 'WC Wayfair Canada USD']],
  },
];

const LABELS = {};
for (const g of GROUPS) {
  if (g.msrp) LABELS[g.msrp[0]] = g.msrp[1];
  for (const [sfx, level] of LEVELS) {
    LABELS[g.map(sfx)] = `${g.label} (${level})`;
    for (const [col, name] of g.costs) LABELS[col(sfx)] = `${name} (${level})`;
  }
}

/** Every price column of a product: the MSRPs, the MAPs and the costs of the three levels. */
export const PRICE_KEYS = Object.keys(LABELS);
export const priceLabel = (key) => LABELS[key] ?? key;

/** A discount this deep is worth a second look (a 79 typed for 790). */
export const BIG_DISCOUNT = 0.4;

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};
const text = (n) => String(n);

/** The price columns whose value is not the same in `after` as in `before`. */
export function changedPriceKeys(before, after) {
  return PRICE_KEYS.filter((k) => num(after?.[k]) !== num(before?.[k]));
}

/**
 * What stops these prices from being saved, in words — an empty list when
 * they are fine. `changed` (optional): only the rules that involve one of
 * these columns are checked, the way the database checks a save; left out,
 * every rule is checked (a new product).
 */
export function priceProblems(values, changed = null) {
  const touched = (...keys) => !changed || keys.some((k) => changed.includes(k));
  const problems = [];
  // a price said to be 0 or less is not compared with the others as well
  const said = new Set();
  for (const key of PRICE_KEYS) {
    const v = num(values?.[key]);
    if (v != null && v <= 0 && touched(key)) {
      problems.push(`${LABELS[key]} must be more than 0 (it is ${text(v)}).`);
      said.add(key);
    }
  }
  for (const g of GROUPS) {
    const blueKey = g.map('');
    const blue = num(values?.[blueKey]);
    for (const [sfx] of LEVELS.slice(1)) {
      const key = g.map(sfx);
      const v = num(values?.[key]);
      if (v != null && blue != null && v > blue && touched(key, blueKey) && !said.has(key) && !said.has(blueKey)) {
        problems.push(`${LABELS[key]} is ${text(v)}, above ${LABELS[blueKey]} ${text(blue)}: a promotion level cannot be above the regular price.`);
      }
    }
  }
  for (const g of GROUPS) {
    for (const [sfx] of LEVELS) {
      const mapKey = g.map(sfx);
      const map = num(values?.[mapKey]);
      for (const [col] of g.costs) {
        const key = col(sfx);
        const cost = num(values?.[key]);
        if (cost != null && map != null && cost >= map && touched(key, mapKey) && !said.has(key) && !said.has(mapKey)) {
          problems.push(`${LABELS[key]} is ${text(cost)}, not under ${LABELS[mapKey]} ${text(map)}: a cost must be under the MAP of its level.`);
        }
      }
    }
  }
  return problems;
}

/**
 * Things worth a look that do not stop a save: a promotion level that lowers
 * nothing, the Purple MAP above the Orange one, a MAP above the MSRP, a level
 * more than 40 % under the regular price.
 */
export function priceNotes(values) {
  const notes = [];
  for (const g of GROUPS) {
    const blueKey = g.map('');
    const blue = num(values?.[blueKey]);
    const orangeKey = g.map('_orange');
    const orange = num(values?.[orangeKey]);
    const purpleKey = g.map('_purple');
    const purple = num(values?.[purpleKey]);
    const msrp = g.msrp ? num(values?.[g.msrp[0]]) : null;
    if (msrp != null && blue != null && blue > msrp) notes.push(`${LABELS[blueKey]} (${text(blue)}) is above ${g.msrp[1]} (${text(msrp)}).`);
    for (const [key, v] of [[orangeKey, orange], [purpleKey, purple]]) {
      if (v == null || blue == null || v > blue) continue;
      if (v === blue) notes.push(`${LABELS[key]} is the same as ${LABELS[blueKey]} (${text(blue)}): a promotion at that level lowers nothing.`);
      else if (v < blue * (1 - BIG_DISCOUNT)) notes.push(`${LABELS[key]} (${text(v)}) is ${Math.round((1 - v / blue) * 100)}% under ${LABELS[blueKey]} (${text(blue)}): check it is not a typo.`);
    }
    if (orange != null && purple != null && purple > orange) notes.push(`${LABELS[purpleKey]} (${text(purple)}) is above ${LABELS[orangeKey]} (${text(orange)}).`);
  }
  return notes;
}
