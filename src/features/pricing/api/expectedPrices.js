// Expected prices per marketplace, read live from the PIM: the regular price
// field and the market's running promotion (monthly, or a flash deal / special
// event on that marketplace). Shared by Price Alignment and the Amazon update
// listing (moved out of priceAlignment.js, 2026-10-14, so an exporter does not
// load the Wix / Best Buy / Walmart sync modules).
import { supabase } from '@/lib/supabase';
import { etToday, promoWindow, windowContains } from '../lib/promoCalendar';

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
        .select(`name, kind, period, status, starts_on, ends_on, ca_starts_on, ca_ends_on, us_starts_on, us_ends_on, promotion_prices(sku, ${promoField})`)
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
      for (const row of deal.promotion_prices ?? []) {
        if (row[promoField] != null) promoBySku.set(row.sku, { price: row[promoField], period: deal.period, windowStart: w.start, windowEnd: w.end, kind: deal.kind, name: deal.name });
      }
    }
  }
  return { baseBySku, promoBySku };
}

/**
 * The same expected prices for a marketplace that has no alignment target
 * (Amazon's update listing, 2026-10-14): `{ priceField, market, promoChannel }`
 * → { baseBySku, promoBySku } (promo = { price, windowStart, windowEnd, kind }).
 */
export function expectedPricesFor({ priceField, market, promoChannel }) {
  return loadExpectedPrices({ priceField, market, promoChannel, promoAware: true });
}
