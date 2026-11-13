// What a promotion's list is checked for before it is saved (user, 2026-11-11:
// "hay que meter validaciones en el módulo de pricing … hazlas todas"). Plain
// functions over data the caller loads (api/promoChecks.js), so the form, the
// card and the import dialog say the same things:
//   · errors STOP the save — a file's promo price above the regular MAP, a
//     file's promo cost that is not under the promo price;
//   · everything else is a warning the person can go on from — no price in
//     the market's currency, switched off for the portal, a level that lowers
//     nothing, more than 40 % off, another deal on the same portal and days.
import { BIG_DISCOUNT } from '../../products/lib/priceRules.js';

const BLUE = { ca: 'map_cad', us: 'map_usd' };
const CURRENCY = { ca: 'CAD', us: 'USD' };
const MARKET_NAME = { ca: 'Canada', us: 'the USA' };
// The promo cost groups of each market's file that are in the market's own
// currency. Wayfair Canada's cost is in USD: there is no price to hold it to.
const COMPARABLE_COSTS = {
  ca: { rona_hd_cad: 'Rona / Home Depot', sod_cad: 'Small Online Dealers' },
  us: { lowes_sod_bbb_usd: "Lowe's / HD USA / SOD / BB&B", wayfair_usd: 'Wayfair', menards_usd: 'Menards' },
};

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};
const levelName = (level) => (level === 'purple' ? 'Purple' : 'Orange');
export const listOf = (items, max = 12) => `${items.slice(0, max).join(', ')}${items.length > max ? ` and ${items.length - max} more` : ''}`;
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One market's list of a promotion — a file's rows or a pasted list — against
 * the products.
 *
 * @param {object[]} rows         [{ sku, price, costs }]: what the file GIVES for this market (price null = none; a pasted list gives none)
 * @param {'ca'|'us'} market
 * @param {string}   kind         the promotion's kind
 * @param {object}   levelFields  LEVEL_FIELDS of the kind's level
 * @param {Map}      products     sku → product (api/promoChecks.js loadCheckProducts)
 * @returns {{ notInPim: string[], errors: string[], noPrice: string[], noDiscount: string[], bigDiscount: string[] }}
 */
export function checkMarketList({ rows, market, kind = 'monthly', levelFields, products }) {
  const out = { notInPim: [], errors: [], noPrice: [], noDiscount: [], bigDiscount: [] };
  const levelCol = market === 'us' ? levelFields.promo_price_usd : levelFields.promo_price_cad;
  // A monthly promotion in the USA takes the level over the file (rule
  // 2026-10-02); everything else takes the file over the level.
  const levelFirst = kind === 'monthly' && market === 'us';
  for (const r of rows) {
    const p = products.get(r.sku);
    if (!p) { out.notInPim.push(r.sku); continue; }
    const blue = num(p[BLUE[market]]);
    const level = num(p[levelCol]);
    const given = num(r.price);
    const price = levelFirst ? level ?? given : given ?? level;
    const above = given != null && blue != null && given > blue;
    if (above) out.errors.push(`${r.sku}: its promo price ${given} is above its regular MAP ${blue} ${CURRENCY[market]}`);
    for (const [slug, label] of Object.entries(COMPARABLE_COSTS[market])) {
      const givenCost = num(r.costs?.[slug]);
      if (givenCost == null) continue;
      // only a cost the file decides (the USA's monthly cost is the level's when it has one)
      if (levelFirst && num(p[levelFields.costs[slug]]) != null) continue;
      if (price != null && givenCost >= price) out.errors.push(`${r.sku}: its promo cost for ${label} (${givenCost}) is not under its promo price ${price} ${CURRENCY[market]}`);
    }
    if (price == null) { out.noPrice.push(r.sku); continue; }
    if (blue == null || above) continue;
    if (price >= blue) out.noDiscount.push(r.sku);
    else if (price < blue * (1 - BIG_DISCOUNT)) out.bigDiscount.push(r.sku);
  }
  return out;
}

/** The warnings of a market's list, as lines to show: [{ title, text }]. */
export function marketWarnings(check, market, { level = 'orange', withBasics = false } = {}) {
  const lines = [];
  const where = MARKET_NAME[market];
  if (withBasics && check.notInPim.length) lines.push({ title: `${check.notInPim.length} not in the PIM (skipped):`, text: listOf(check.notInPim, 40) });
  if (withBasics && check.noPrice.length) lines.push({ title: `${check.noPrice.length} with no promotion price in ${CURRENCY[market]}:`, text: `${listOf(check.noPrice, 40)} — no ${levelName(level)} price in the product's Pricing tab and none in the file` });
  if (check.noDiscount.length) lines.push({ title: `${check.noDiscount.length} whose promo price in ${where} is not under the regular MAP:`, text: `${listOf(check.noDiscount)} — the promotion lowers nothing for ${check.noDiscount.length === 1 ? 'it' : 'them'}` });
  if (check.bigDiscount.length) lines.push({ title: `${check.bigDiscount.length} more than ${Math.round(BIG_DISCOUNT * 100)}% under the regular MAP in ${where}:`, text: `${listOf(check.bigDiscount)} — check ${check.bigDiscount.length === 1 ? 'it is' : 'they are'} not a typo` });
  return lines;
}

/**
 * A flash deal / MK event / peak season event's SKU list against the
 * products, portal by portal.
 *
 * @param {string[]} skus
 * @param {string[]} portals    PROMO_CHANNELS keys the deal goes to
 * @param {object[]} channels   PROMO_CHANNELS
 * @param {Function} levelOf    (channel) → 'orange' | 'purple', the level the deal runs at on that portal
 * @param {object}   levels     LEVEL_FIELDS
 * @param {Map}      products   sku → product
 * @param {object[]} others     the other deals on those days: [{ name, marketplaces, skus: Set }]
 * @param {object}   [lists]    { ca: [skus], us: [skus] } — an event made from a file per country (a peak
 *                              season event, 2026-11-13): each portal is checked on its own country's list
 */
export function checkDealList({ skus, portals, channels, levelOf, levels, products, others = [], lists = null }) {
  const known = skus.filter((s) => products.has(s));
  const out = { notInPim: skus.filter((s) => !products.has(s)), portals: [], overlaps: [] };
  const onList = lists ? { ca: new Set(lists.ca ?? []), us: new Set(lists.us ?? []) } : null;
  for (const key of portals) {
    const ch = channels.find((c) => c.key === key);
    if (!ch) continue;
    const level = levelOf(ch);
    const col = ch.market === 'us' ? levels[level].promo_price_usd : levels[level].promo_price_cad;
    const offKey = ch.exclusionKey ?? ch.key;
    const row = { key, label: ch.label, market: ch.market, level, noPrice: [], switchedOff: [], notSold: [], noDiscount: [], bigDiscount: [] };
    const mine = onList ? known.filter((s) => onList[ch.market]?.has(s)) : known;
    for (const sku of mine) {
      const p = products.get(sku);
      if ((p.channel_exclusions ?? []).includes(offKey)) { row.switchedOff.push(sku); continue; }
      if (ch.discounts) {
        // A Stylish store: the discount is the event's own (no level price),
        // and an Azuni product is never sold there.
        if (String(p.brand ?? '').toLowerCase() === 'azuni') row.notSold.push(sku);
        continue;
      }
      const price = num(p[col]);
      const blue = num(p[BLUE[ch.market]]);
      if (price == null) { row.noPrice.push(sku); continue; }
      if (blue == null) continue;
      if (price >= blue) row.noDiscount.push(sku);
      else if (price < blue * (1 - BIG_DISCOUNT)) row.bigDiscount.push(sku);
    }
    out.portals.push(row);
    for (const o of others) {
      if (!(o.marketplaces ?? []).includes(key)) continue;
      const shared = mine.filter((s) => o.skus.has(s));
      if (shared.length) out.overlaps.push({ promotion: o.name, portal: ch.label, skus: shared });
    }
  }
  return out;
}

/**
 * The warnings of a deal's list, as lines to show: [{ title, text }].
 * `fromFile`: the event's prices come from a file per country, whose own check
 * (checkMarketList) already says what is priced wrong or not at all — only
 * what is about the portals is said here.
 */
export function dealWarnings(check, { fromFile = false } = {}) {
  const lines = [];
  if (!fromFile && check.notInPim.length) lines.push({ title: `${check.notInPim.length} not in the PIM (skipped):`, text: listOf(check.notInPim, 40) });
  for (const p of check.portals) {
    const cur = CURRENCY[p.market];
    if (!fromFile && p.noPrice.length) lines.push({ title: `${p.label}: ${p.noPrice.length} with no ${levelName(p.level)} price in ${cur}:`, text: `${listOf(p.noPrice)} — no deal price for ${p.noPrice.length === 1 ? 'it' : 'them'} until the product's Pricing tab has it` });
    if (p.switchedOff.length) lines.push({ title: `${p.label}: ${p.switchedOff.length} switched off for this marketplace:`, text: `${listOf(p.switchedOff)} — left out of its file and its sends` });
    if (p.notSold.length) lines.push({ title: `${p.label}: ${count(p.notSold.length, 'Azuni product')} not sold on that store:`, text: listOf(p.notSold) });
    if (!fromFile && p.noDiscount.length) lines.push({ title: `${p.label}: ${p.noDiscount.length} whose ${levelName(p.level)} price is not under the regular MAP:`, text: `${listOf(p.noDiscount)} — the deal lowers nothing for ${p.noDiscount.length === 1 ? 'it' : 'them'}` });
    if (!fromFile && p.bigDiscount.length) lines.push({ title: `${p.label}: ${p.bigDiscount.length} more than ${Math.round(BIG_DISCOUNT * 100)}% under the regular MAP:`, text: `${listOf(p.bigDiscount)} — check ${p.bigDiscount.length === 1 ? 'it is' : 'they are'} not a typo` });
  }
  for (const o of check.overlaps) {
    lines.push({ title: `${o.portal}: ${o.skus.length} already in "${o.promotion}" on those days:`, text: `${listOf(o.skus, 8)} — two deals on the same product and days` });
  }
  return lines;
}

/**
 * What importing a market's list into an existing promotion would do, before
 * anything is written: the list is REPLACED, so the products not in it leave.
 *
 * @param {object[]} existing  the promotion's rows (promotion_prices)
 * @param {object[]} incoming  the rows to import, the PIM's products only
 * @param {'ca'|'us'} market
 * @param {Function} onList    (row, market) → is the row on that market's list (onMarketList)
 */
export function planMarketImport({ existing, incoming, market, onList }) {
  const givenKey = market === 'us' ? 'promo_price_usd' : 'promo_price_cad';
  const storedKey = market === 'us' ? 'set_price_usd' : 'set_price_cad';
  const before = new Map((existing ?? []).filter((r) => onList(r, market)).map((r) => [r.sku, r]));
  const coming = new Set(incoming.map((r) => r.sku));
  const stay = incoming.filter((r) => before.has(r.sku));
  return {
    total: incoming.length,
    joined: incoming.filter((r) => !before.has(r.sku)).map((r) => r.sku),
    left: [...before.keys()].filter((s) => !coming.has(s)),
    stay: stay.length,
    repriced: stay
      .filter((r) => num(r[givenKey]) !== num(before.get(r.sku)[storedKey]))
      .map((r) => ({ sku: r.sku, from: num(before.get(r.sku)[storedKey]), to: num(r[givenKey]) })),
  };
}
