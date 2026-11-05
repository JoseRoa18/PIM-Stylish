import { supabase } from '@/lib/supabase';
import { listPromotions, getPromotionPrices, onMarketList } from '@/features/pricing/api/promotions';
import { PROMO_CHANNELS } from '@/features/pricing/lib/promoChannels';
import { promoWindow, windowContains } from '@/features/pricing/lib/promoCalendar';
import { BOARD_BY_KEY } from './boards';
import { addDays } from './weeks';

// The measurables the PIM fills itself ("mixed" scorecard, user 2026-11-03).
// A row's auto_key names one of these; its value for the CURRENT week is
// worked out when an editor opens the board and saved with origin 'auto'
// (past weeks keep what was saved then). The row is the PIM's: nobody types
// its numbers (user, 2026-11-04), and a number typed or imported this week
// is replaced.
// A column holds the numbers of the week BEFORE it (user, 2026-11-04: W44 =
// Oct 25–31, the week reviewed in that week's meeting).
//
// `server: true` keys are worked out by the scorecard-fill edge function
// (Odoo's orders, stock, the Activity Log — daily cron and "Refresh PIM
// numbers") and only for boards with `serverFill` (boards.js).
export const AUTO_KEYS = {
  map_pct: { label: 'MAP % — share of priced products at the expected price (Price Alignment)', unit: 'percent' },
  promo_skus: { label: '# SKUs in the monthly promotion of the week', unit: 'number' },
  flash_skus: { label: '# SKUs in flash deals of the week', unit: 'number' },
  event_skus: { label: '# SKUs in special events of the week', unit: 'number' },
  flash_count: { label: '# flash deals of the week', unit: 'number' },
  event_count: { label: '# special events of the week', unit: 'number' },
  deal_count: { label: '# flash deals and special events of the week', unit: 'number' },
  // Odoo (user, 2026-11-05): a $0 order (a spare part, a warranty
  // replacement, an open box sent free) is no sale; Sales keep the shipping
  // charged, as Odoo's own sales report. Odoo records almost no cancellation
  // (1 Sinks Direct order in 2026), so the cancelation rate is typed.
  sales: { label: 'Sales before tax, shipping charged included — paid Odoo orders of the week', unit: 'money', server: true },
  orders: { label: '# paid orders — Odoo, not cancelled, over $0', unit: 'number', server: true },
  units: { label: 'Units sold — products sold with a price in paid Odoo orders (not shipping)', unit: 'number', server: true },
  // From the store itself (Wix) and Odoo's deliveries / returns (user, 2026-11-05).
  cancel_rate: { label: 'Order cancelation rate — the store\'s paid orders of the week cancelled (Wix)', unit: 'percent', server: true, store: true },
  on_time_ship: { label: 'On-time shipping — paid orders whose ShipStation labels were all made by the 2nd business day', unit: 'percent', server: true },
  late_ship_rate: { label: 'Late shipping rate — paid orders labelled after the 2nd business day, or still waiting past it (ShipStation)', unit: 'percent', server: true },
  odr: { label: 'Order defect rate — paid orders of the week cancelled, refunded or returned (Wix + Odoo)', unit: 'percent', server: true, store: true },
  returns_not_received: { label: '$ refunded in the week on orders whose goods never came back (Wix refunds, Odoo returns)', unit: 'money', server: true, store: true },
  reviews_5plus: { label: '# products with more than 5 approved reviews on the store (Wix Reviews)', unit: 'number', server: true, store: true },
  no_profit_skus: { label: '# SKUs priced on the store this week below Odoo\'s average cost + their real shipping cost per unit (ShipStation labels, 180 days)', unit: 'number', server: true, store: true },
  skus_not_sold_90d: { label: '# SKUs without a sale in 90 days — PIM products vs Odoo orders', unit: 'number', server: true },
  oos_loss: { label: 'Loss due to out of stock — products at 0 units × their weekly sales of the 8 weeks before', unit: 'money', server: true },
  obsolete_skus: { label: '# SKUs marked obsolete in the PIM', unit: 'number', server: true },
  // The marketplace tabs (user, 2026-11-05): returns read over 4 weeks (bodega validates them in batches).
  return_rate: { label: 'Return rate — orders with a return Odoo received in the last 4 weeks ÷ the paid orders placed in them', unit: 'percent', server: true },
  returns_value: { label: '$ returned — weekly average value of the goods Odoo received back over the last 4 weeks', unit: 'money', server: true },
  sales_usd_k: { label: 'Sales in thousands of USD — Odoo orders, USD ones as they are, others at today\'s rate', unit: 'number', server: true },
  azuni_skus_sold: { label: '# Azuni SKUs sold in the week (Odoo orders)', unit: 'number', server: true },
  listings_updated: { label: '# listings updated — products the PIM pushed to the store that week', unit: 'number', server: true },
  // Written by AI (Gemini) from the week's data only: the channel's top losers vs
  // their 8-week average, the cause the PIM can see (no stock, store page sold
  // out or broken) and the actions the PIM recorded (user, 2026-11-05).
  losers_note: { label: 'Actions taken for top losers — note written by AI from the PIM\'s data (losers, causes, recorded actions)', unit: 'text', server: true },
};
export const isServerKey = (key) => Boolean(AUTO_KEYS[key]?.server);
/** Keys read from a Wix store itself (its orders, reviews, prices): the Sinks Direct tab only. */
export const isStoreKey = (key) => Boolean(AUTO_KEYS[key]?.store);

const EXCLUSION_KEY = Object.fromEntries(PROMO_CHANNELS.map((c) => [c.key, c.exclusionKey ?? c.key]));
const ALWAYS_ON = new Set(['wix_sinksdirect_ca', 'wix_sinksdirect_us']); // the websites carry every product

const day10 = (v) => (v ? String(v).slice(0, 10) : null);
/** Ended before `day` (a promotion marked ended early is over from then on). */
const endedBy = (p, day) => p.status === 'ended' && day10(p.ended_at) != null && day10(p.ended_at) <= day;

async function loadExclusions() {
  const { data, error } = await supabase.from('products').select('sku, channel_exclusions').not('channel_exclusions', 'is', null);
  if (error) throw error;
  return new Map((data ?? []).map((p) => [p.sku, new Set(p.channel_exclusions ?? [])]));
}

/** SKUs of a promotion that the board sells on `market` (on that market's list, not switched off on every one of its channels). */
function membersOn(rows, market, channels, exclusions) {
  const out = new Set();
  for (const r of rows) {
    if (!onMarketList(r, market)) continue;
    const ex = exclusions.get(r.sku);
    const sold = channels.some((c) => ALWAYS_ON.has(c) || !ex?.has(EXCLUSION_KEY[c] ?? c));
    if (sold) out.add(r.sku);
  }
  return out;
}

/**
 * The browser-side PIM values of the board's auto measurables for the column
 * of `column` (its Sunday): deals of its data week (the 7 days before it),
 * the monthly promotion running on that week's last day, and today's Price
 * Alignment. Returns Map(metricId → number); a measurable the PIM has nothing
 * for (no Price Alignment report yet) is left out. Server keys are skipped.
 */
export async function computeAutoValues(boardKey, metrics, column, today) {
  const board = BOARD_BY_KEY[boardKey];
  const wanted = metrics.filter((m) => m.auto_key && AUTO_KEYS[m.auto_key] && !isServerKey(m.auto_key) && board?.markets[m.market]);
  if (!wanted.length) return new Map();
  const week = addDays(column, -7);
  const weekEnd = addDays(column, -1);
  const promoDay = today < weekEnd ? today : weekEnd;
  const out = new Map();

  const needsPromos = wanted.some((m) => m.auto_key !== 'map_pct');
  if (needsPromos) {
    const [promotions, exclusions] = await Promise.all([listPromotions(), loadExclusions()]);
    const pricesCache = new Map();
    const pricesOf = (id) => {
      if (!pricesCache.has(id)) pricesCache.set(id, getPromotionPrices(id));
      return pricesCache.get(id);
    };
    for (const m of wanted) {
      if (m.auto_key === 'map_pct') continue;
      const { channels } = board.markets[m.market];
      if (m.auto_key === 'promo_skus') {
        const running = promotions.filter((p) => p.kind === 'monthly' && windowContains(promoWindow(p, m.market), promoDay) && !endedBy(p, promoDay));
        const skus = new Set();
        for (const p of running) for (const s of membersOn(await pricesOf(p.id), m.market, channels, exclusions)) skus.add(s);
        out.set(m.id, skus.size);
        continue;
      }
      const kinds = { flash_skus: ['flash'], flash_count: ['flash'], event_skus: ['special'], event_count: ['special'], deal_count: ['flash', 'special'] }[m.auto_key];
      const deals = promotions.filter((p) => {
        if (!kinds.includes(p.kind) || endedBy(p, week)) return false;
        if (!(p.marketplaces ?? []).some((c) => channels.includes(c))) return false;
        const w = promoWindow(p, m.market);
        return w.start <= weekEnd && w.end >= week;
      });
      if (m.auto_key.endsWith('_count')) { out.set(m.id, deals.length); continue; }
      const skus = new Set();
      for (const p of deals) for (const s of membersOn(await pricesOf(p.id), m.market, channels, exclusions)) skus.add(s);
      out.set(m.id, skus.size);
    }
  }

  const mapRows = wanted.filter((m) => m.auto_key === 'map_pct');
  if (mapRows.length) {
    // Loaded on demand: the Price Alignment code is only needed here.
    const [{ loadLatestAlignment }, { alignmentSummary }] = await Promise.all([
      import('@/features/pricing/api/priceAlignment'),
      import('@/features/pricing/lib/alignmentSummary'),
    ]);
    for (const m of mapRows) {
      let aligned = 0;
      let comparable = 0;
      for (const target of board.markets[m.market].align) {
        const s = alignmentSummary(await loadLatestAlignment(target));
        aligned += s.aligned;
        comparable += s.comparable;
      }
      if (comparable > 0) out.set(m.id, Math.round((aligned / comparable) * 10000) / 10000);
    }
  }
  return out;
}
