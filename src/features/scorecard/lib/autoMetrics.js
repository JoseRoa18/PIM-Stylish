import { supabase } from '@/lib/supabase';
import { createScorecardLive, LIVE_KEYS } from '../../../../supabase/functions/_shared/scorecardLive.js';
import { BOARD_BY_KEY } from './boards';

// The measurables the PIM fills itself ("mixed" scorecard, user 2026-11-03).
// A row's auto_key names one of these; its value for the CURRENT week is
// saved with origin 'auto' (past weeks keep what was saved then). The row is
// the PIM's: nobody types its numbers (user, 2026-11-04), and a number typed
// or imported this week is replaced. MAP %, promotions, deals and coupons
// (LIVE_KEYS) are worked out by the scorecard-fill crons AND again when an
// editor opens the tab (user, 2026-11-10), with the same shared code.
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
  event_skus: { label: '# SKUs in peak season events of the week', unit: 'number' },
  flash_count: { label: '# flash deals of the week', unit: 'number' },
  event_count: { label: '# peak season events of the week', unit: 'number' },
  deal_count: { label: '# flash deals, MK events and peak season events of the week', unit: 'number' },
  // Pricing → Coupons (user, 2026-11-09): Amazon and Wayfair, both countries; a Sinks Direct
  // coupon (2026-11-13) counts on that tab once it has these rows.
  coupon_count: { label: '# coupons of the week (Pricing, Coupons tab)', unit: 'number' },
  coupon_skus: { label: '# SKUs in the coupons of the week, each product once (Pricing, Coupons tab)', unit: 'number' },
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
  no_profit_skus: { label: '# SKUs priced on the store this week below Odoo\'s average cost + their real shipping cost per unit (ShipStation labels, 180 days)', unit: 'number', server: true, store: true, alsoOn: ['bbb_overstock'] },
  skus_not_sold_90d: { label: '# SKUs without a sale in 90 days — PIM products vs Odoo orders', unit: 'number', server: true },
  oos_loss: { label: 'Loss due to out of stock — products at 0 units × their weekly sales of the 8 weeks before', unit: 'money', server: true },
  obsolete_skus: { label: '# SKUs marked obsolete in the PIM', unit: 'number', server: true },
  // The marketplace tabs (user, 2026-11-05): returns read over 4 weeks (bodega validates them in batches).
  return_rate: { label: 'Return rate — orders with a return Odoo received in the last 4 weeks ÷ the paid orders placed in them', unit: 'percent', server: true },
  returns_value: { label: '$ returned — weekly average value of the goods Odoo received back over the last 4 weeks', unit: 'money', server: true },
  sales_usd_k: { label: 'Sales in thousands of USD — Odoo orders, USD ones as they are, others at today\'s rate', unit: 'number', server: true },
  azuni_skus_sold: { label: '# Azuni SKUs sold in the week (Odoo orders)', unit: 'number', server: true },
  returns_note: { label: 'Return actions — what came back in the week, by SKU (Odoo returns)', unit: 'text', server: true },
  reviews_new: { label: 'New reviews — what the store listings gained since the last week (their pages)', unit: 'number', server: true },
  top_losers_sales: { label: 'Sales of the tab\'s list of top losers — products only, Odoo orders of the week (BB&B / Overstock)', unit: 'money', server: true },
  listings_updated: { label: '# listings updated — products the PIM pushed to the store that week', unit: 'number', server: true },
  // Written by AI (Gemini) from the week's data only: the channel's top losers vs
  // their 8-week average, the cause the PIM can see (no stock, store page sold
  // out or broken) and the actions the PIM recorded (user, 2026-11-05).
  losers_note: { label: 'Actions taken for top losers — note written by AI from the PIM\'s data (losers, causes, recorded actions)', unit: 'text', server: true },
};
export const isServerKey = (key) => Boolean(AUTO_KEYS[key]?.server);
/** Keys read from a Wix store itself (its orders, reviews, prices): the Sinks Direct tab only. */
export const isStoreKey = (key) => Boolean(AUTO_KEYS[key]?.store);

/**
 * The live rows of the board for the column of `column` (its Sunday), worked
 * out in the browser with the server's own code (_shared/scorecardLive.js) and
 * Price Alignment's reports: Map(metricId → number). A measurable the PIM has
 * nothing for (no Price Alignment report yet) is left out.
 */
export async function computeAutoValues(boardKey, metrics, column, today) {
  const board = BOARD_BY_KEY[boardKey];
  const wanted = metrics.filter((m) => LIVE_KEYS.includes(m.auto_key) && board?.markets[m.market]);
  if (!wanted.length) return new Map();
  // Loaded on demand: the Price Alignment code is only needed here.
  const [{ ALIGN_TARGETS }, { latestReport }] = await Promise.all([
    import('@/features/pricing/api/priceAlignment'),
    import('@/features/pricing/api/expectedPrices'),
  ]);
  const live = createScorecardLive({ db: supabase, targets: ALIGN_TARGETS, latestReport });
  const out = new Map();
  for (const market of new Set(wanted.map((m) => m.market))) {
    const rows = wanted.filter((m) => m.market === market);
    const { channels, align } = board.markets[market];
    const values = await live.values({ keys: [...new Set(rows.map((m) => m.auto_key))], market, channels, align, column, today });
    for (const m of rows) if (m.auto_key in values) out.set(m.id, values[m.auto_key]);
  }
  return out;
}
