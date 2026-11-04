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
  sales: { label: 'Sales before tax — Odoo orders of the week', unit: 'money', server: true },
  orders: { label: '# orders — Odoo, not cancelled', unit: 'number', server: true },
  units: { label: 'Units sold — PIM products in Odoo orders', unit: 'number', server: true },
  cancel_rate: { label: 'Order cancelation rate — cancelled ÷ all Odoo orders', unit: 'percent', server: true },
  skus_not_sold_90d: { label: '# SKUs without a sale in 90 days — PIM products vs Odoo orders', unit: 'number', server: true },
  oos_loss: { label: 'Loss due to out of stock — products at 0 units × their weekly sales of the 8 weeks before', unit: 'money', server: true },
  obsolete_skus: { label: '# SKUs marked obsolete in the PIM', unit: 'number', server: true },
  listings_updated: { label: '# listings updated — products the PIM pushed to the store that week', unit: 'number', server: true },
};
export const isServerKey = (key) => Boolean(AUTO_KEYS[key]?.server);

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
