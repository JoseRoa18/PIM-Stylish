// The EOS ScoreCard rows that read the PIM as it is now: MAP %, promotions,
// deals and coupons. The scorecard-fill crons work them out (user, 2026-11-09:
// the tab had to be opened for them to change). A column holds the week before
// it: deals and coupons of those 7 days, the monthly promotion running on the
// last of them (or today, while the week is in progress) and today's Price
// Alignment.
import { promoWindow, shiftDay, windowContains } from './promoCalendar.ts';
import { alignmentSummary } from './alignmentSummary.js';

export const LIVE_KEYS = ['map_pct', 'promo_skus', 'flash_skus', 'event_skus', 'flash_count', 'event_count', 'deal_count', 'coupon_count'];

const DEAL_KINDS_OF = {
  flash_skus: ['flash', 'mk_event'],
  flash_count: ['flash', 'mk_event'],
  event_skus: ['special'],
  event_count: ['special'],
  deal_count: ['flash', 'mk_event', 'special'],
};
const EXCLUSION_KEY = { overstock: 'bbb' }; // the two share one switch
const ALWAYS_ON = new Set(['wix_sinksdirect_ca', 'wix_sinksdirect_us']); // the websites carry every product

const day10 = (v) => (v ? String(v).slice(0, 10) : null);
/** Ended before `day` (a promotion marked ended early is over from then on). */
const endedBy = (p, day) => p.status === 'ended' && day10(p.ended_at) != null && day10(p.ended_at) <= day;

function onMarketList(row, market) {
  const flag = market === 'us' ? row.in_us : row.in_ca;
  if (flag != null) return flag;
  return (market === 'us' ? row.promo_price_usd : row.promo_price_cad) != null;
}

/** `targets`: alignTargets(); `latestReport`: createPriceAlignment's. */
export function createScorecardLive({ db, targets, latestReport }) {
  const once = new Map();
  const load = (key, loader) => {
    if (!once.has(key)) once.set(key, loader());
    return once.get(key);
  };
  const read = async (query) => {
    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  };
  const promotions = () => load('promotions', () => read(db.from('promotions').select('id, kind, status, period, marketplaces, ended_at, starts_on, ends_on, ca_starts_on, ca_ends_on, us_starts_on, us_ends_on')));
  const pricesOf = (id) => load(`prices:${id}`, () => read(db.from('promotion_prices').select('sku, promo_price_cad, promo_price_usd, in_ca, in_us').eq('promotion_id', id)));
  const coupons = () => load('coupons', () => read(db.from('coupons').select('marketplace, starts_on, ends_on, ended_at')));
  const exclusions = () => load('exclusions', async () => {
    const rows = await read(db.from('products').select('sku, channel_exclusions').not('channel_exclusions', 'is', null));
    return new Map(rows.map((p) => [p.sku, new Set(p.channel_exclusions ?? [])]));
  });

  /** SKUs of a promotion the board sells on `market`: on its list, not switched off on every one of its channels. */
  async function membersOf(promotion, market, channels) {
    const [rows, off] = await Promise.all([pricesOf(promotion.id), exclusions()]);
    const out = new Set();
    for (const r of rows) {
      if (!onMarketList(r, market)) continue;
      const ex = off.get(r.sku);
      if (channels.some((c) => ALWAYS_ON.has(c) || !ex?.has(EXCLUSION_KEY[c] ?? c))) out.add(r.sku);
    }
    return out;
  }
  const countMembers = async (list, market, channels) => {
    const skus = new Set();
    for (const p of list) for (const s of await membersOf(p, market, channels)) skus.add(s);
    return skus.size;
  };

  /**
   * The values of `keys` for the column of `column` (its Sunday), { key: number };
   * a key the PIM has nothing for (no Price Alignment report yet) is left out.
   */
  async function values({ keys, market, channels, align, column, today }) {
    const week = shiftDay(column, -7);
    const weekEnd = shiftDay(column, -1);
    const promoDay = today < weekEnd ? today : weekEnd;
    const out = {};
    for (const key of keys) {
      if (key === 'promo_skus') {
        const running = (await promotions()).filter((p) => p.kind === 'monthly' && windowContains(promoWindow(p, market), promoDay) && !endedBy(p, promoDay));
        out[key] = await countMembers(running, market, channels);
      } else if (DEAL_KINDS_OF[key]) {
        const deals = (await promotions()).filter((p) => {
          if (!DEAL_KINDS_OF[key].includes(p.kind) || endedBy(p, week)) return false;
          if (!(p.marketplaces ?? []).some((c) => channels.includes(c))) return false;
          const w = promoWindow(p, market);
          return w.start <= weekEnd && w.end >= week;
        });
        out[key] = key.endsWith('_count') ? deals.length : await countMembers(deals, market, channels);
      } else if (key === 'coupon_count') {
        out[key] = (await coupons()).filter((c) => channels.includes(c.marketplace) && c.starts_on <= weekEnd && c.ends_on >= week && !(day10(c.ended_at) != null && day10(c.ended_at) <= week)).length;
      } else if (key === 'map_pct') {
        let aligned = 0;
        let comparable = 0;
        for (const target of align) {
          const s = alignmentSummary(await load(`report:${target}`, () => latestReport(targets[target])));
          aligned += s.aligned;
          comparable += s.comparable;
        }
        if (comparable > 0) out[key] = Math.round((aligned / comparable) * 10000) / 10000;
      }
    }
    return out;
  }
  return { values };
}
