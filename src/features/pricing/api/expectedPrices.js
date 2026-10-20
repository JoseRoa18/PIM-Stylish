// Expected prices per marketplace, read live from the PIM: the regular price
// field and the market's running promotion (monthly, or a flash deal / special
// event on that marketplace). Shared by Price Alignment and the Amazon update
// listing (moved out of priceAlignment.js, 2026-10-14, so an exporter does not
// load the Wix / Best Buy / Walmart sync modules).
import { supabase } from '@/lib/supabase';
import { etToday, promoWindow, windowContains, periodOfDay, prevPeriod, shiftDay, PROMO_DATE_COLUMNS } from '../lib/promoCalendar';

// Reads shared by the targets of one Price Alignment view (performance pass
// 2026-09-29): the page loads all eight targets at once and each one used to
// read the products table and the active promotions again (~30 queries). A
// read is shared for a few seconds; a manual pull drops its channel's
// snapshot first, so a refreshed report is always read fresh.
const SHARED_TTL_MS = 10000;
const shared = new Map(); // key → { at, promise }
// A manual pull drops its channel's snapshot so the next read is fresh.
export const dropShared = (key) => shared.delete(key);
export function sharedLoad(key, loader) {
  const hit = shared.get(key);
  if (hit && Date.now() - hit.at < SHARED_TTL_MS) return hit.promise;
  const promise = loader();
  shared.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (shared.get(key)?.promise === promise) shared.delete(key); });
  return promise;
}

/**
 * What every product SHOULD sell at on a target, read from the PIM right
 * now: the target's regular price field, and the market's active monthly
 * promo price for members when the target follows promotions. Reading it
 * live means a price edited in the PIM shows in the report at once, without
 * pulling the channel again (the pull only refreshes the LIVE prices).
 */
export async function loadExpectedPrices(cfg) {
  const prods = await sharedLoad(`products:${cfg.priceField}`, async () => {
    const { data, error } = await supabase
      .from('products')
      .select(`sku, base:${cfg.priceField}`)
      .range(0, 4999);
    if (error) throw error;
    return data ?? [];
  });
  const baseBySku = new Map(prods.map((p) => [p.sku, p.base]));

  const promoBySku = new Map();
  if (cfg.promoAware === false) return { baseBySku, promoBySku };
  const promoField = cfg.market === 'us' ? 'promo_price_usd' : 'promo_price_cad';
  const activePromos = await sharedLoad(`promos:${promoField}`, async () => {
    const { data, error } = await supabase
      .from('promotions')
      .select(`period, starts_on, ends_on, ca_starts_on, ca_ends_on, us_starts_on, us_ends_on, promotion_prices(sku, ${promoField})`)
      .eq('status', 'active')
      .eq('kind', 'monthly') // flash deals and special events are not the store's expected price
      .order('period', { ascending: true });
    if (error) throw error;
    return data ?? [];
  });
  // Market calendar: USA runs the 1st → month end; Canada runs first
  // Thursday → the day before the next first Thursday. Only the promo whose
  // window is open today sets the expected price.
  const todayET = etToday();
  for (const promo of activePromos ?? []) {
    const w = promoWindow(promo, cfg.market);
    if (!windowContains(w, todayET)) continue;
    for (const row of promo.promotion_prices ?? []) {
      // The period + window ride along so a promo fix can be pushed as a
      // SCHEDULED discount covering exactly the market window (Best Buy).
      if (row[promoField] != null) promoBySku.set(row.sku, { price: row[promoField], period: promo.period, windowStart: w.start, windowEnd: w.end, kind: 'monthly' });
    }
  }
  // A flash deal or special event running on THIS marketplace (user rule
  // 2026-10-02) is the expected price of its SKUs for as long as it runs,
  // over the monthly promo. Like the Deals overview, a deal runs by its
  // dates (flash deals stay "draft" while the portal runs them); only an
  // ended one is over early.
  if (cfg.promoChannel) {
    const deals = await sharedLoad(`deals:${cfg.promoChannel}:${promoField}`, async () => {
      const { data, error } = await supabase
        .from('promotions')
        .select(`name, kind, period, status, starts_on, ends_on, ca_starts_on, ca_ends_on, us_starts_on, us_ends_on, promotion_prices(sku, ${promoField}, in_ca, in_us)`)
        .in('kind', ['flash', 'special'])
        .neq('status', 'ended')
        .contains('marketplaces', [cfg.promoChannel]);
      if (error) throw error;
      return data ?? [];
    });
    const running = (deals ?? [])
      .map((deal) => ({ deal, w: promoWindow(deal, cfg.market) }))
      .filter(({ w }) => windowContains(w, todayET))
      .sort((a, b) => a.w.start.localeCompare(b.w.start)); // overlapping deals: the later start wins
    for (const { deal, w } of running) {
      // A marketplace that pins this kind to a level (BB&B and Overstock run
      // flash deals at Purple — promoChannels' levelByKind) shows the level's
      // MAP, whatever the promotion's rows carry.
      const level = cfg.levelByKind?.[deal.kind] ?? null;
      const levelMap = level ? await levelMapPrices(`map_${level}_${cfg.market === 'us' ? 'usd' : 'cad'}`) : null;
      for (const row of deal.promotion_prices ?? []) {
        // Only the deal's members in this market (the level price exists for
        // every product, so the market list is checked on its own).
        const onList = (cfg.market === 'us' ? row.in_us : row.in_ca) ?? (row[promoField] != null);
        if (!onList) continue;
        const price = levelMap ? levelMap.get(row.sku) ?? null : row[promoField];
        if (price != null) promoBySku.set(row.sku, { price, period: deal.period, windowStart: w.start, windowEnd: w.end, kind: deal.kind, name: deal.name });
      }
    }
  }
  return { baseBySku, promoBySku };
}

/**
 * The last day, up to today, on which each product's expected price on this
 * target changed: a monthly promotion of its market started or ended for it,
 * or a flash deal / special event on this marketplace did. A store price read
 * from a page before that day says nothing about today's expected price
 * (the Where to Buy check reads a page every 3 days) — Map(sku → 'YYYY-MM-DD').
 * Monthly promotions are read back two months, ended ones included.
 */
export async function loadPriceChangeDays(cfg) {
  const promoField = cfg.market === 'us' ? 'promo_price_usd' : 'promo_price_cad';
  const today = etToday();
  const since = prevPeriod(prevPeriod(periodOfDay(today)));
  const monthly = await sharedLoad(`promos-recent:${promoField}:${since}`, async () => {
    const { data, error } = await supabase
      .from('promotions')
      .select(`period, status, ${PROMO_DATE_COLUMNS}, promotion_prices(sku, ${promoField})`)
      .eq('kind', 'monthly')
      .in('status', ['active', 'ended'])
      .gte('period', since);
    if (error) throw error;
    return data ?? [];
  });
  const deals = cfg.promoChannel ? await sharedLoad(`deals-recent:${cfg.promoChannel}:${promoField}:${since}`, async () => {
    const { data, error } = await supabase
      .from('promotions')
      .select(`period, status, ${PROMO_DATE_COLUMNS}, promotion_prices(sku, ${promoField}, in_ca, in_us)`)
      .in('kind', ['flash', 'special'])
      .contains('marketplaces', [cfg.promoChannel])
      .gte('period', since);
    if (error) throw error;
    return data ?? [];
  }) : [];
  const changes = new Map();
  const mark = (sku, day) => { if (day <= today && (!changes.has(sku) || day > changes.get(sku))) changes.set(sku, day); };
  for (const promo of [...monthly, ...deals]) {
    const w = promoWindow(promo, cfg.market);
    for (const row of promo.promotion_prices ?? []) {
      const member = 'in_us' in row ? ((cfg.market === 'us' ? row.in_us : row.in_ca) ?? row[promoField] != null) : row[promoField] != null;
      if (!member) continue;
      mark(row.sku, w.start);
      mark(row.sku, shiftDay(w.end, 1));
    }
  }
  return changes;
}

// One MAP level column of every product (map_purple_usd…), shared.
async function levelMapPrices(column) {
  const prods = await sharedLoad(`products:${column}`, async () => {
    const { data, error } = await supabase.from('products').select(`sku, level:${column}`).range(0, 4999);
    if (error) throw error;
    return data ?? [];
  });
  return new Map(prods.map((p) => [p.sku, p.level]));
}

/**
 * The same expected prices for a marketplace that has no alignment target
 * (Amazon's update listing, 2026-10-14): `{ priceField, market, promoChannel }`
 * → { baseBySku, promoBySku } (promo = { price, windowStart, windowEnd, kind }).
 */
export function expectedPricesFor({ priceField, market, promoChannel }) {
  return loadExpectedPrices({ priceField, market, promoChannel, promoAware: true });
}
