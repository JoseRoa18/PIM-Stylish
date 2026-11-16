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
  skus_not_sold_90d: { label: '# SKUs without a sale in 90 days — the products the marketplace lists (its ids or its Where to Buy link in the PIM) vs Odoo orders', unit: 'number', server: true },
  // Amazon sells from two stocks (2026-11-16): what it holds itself (FBA — Odoo's AMZ-CAN / AMZ-USA warehouses) and our
  // warehouse. Every product Amazon holds none of counts, whatever we have (user: "tiene que ser todo").
  oos_loss: { label: 'Loss due to out of stock — products at 0 units × their weekly sales of the 8 weeks before (Amazon: every product Amazon holds none of — what it sold from Amazon’s stock, and from ours too when our warehouse has none)', unit: 'money', server: true },
  obsolete_skus: { label: '# SKUs marked obsolete in the PIM', unit: 'number', server: true },
  // The marketplace tabs (user, 2026-11-05): returns read over 4 weeks (bodega validates them in batches).
  return_rate: { label: 'Return rate — orders with a return Odoo received in the last 4 weeks ÷ the paid orders placed in them', unit: 'percent', server: true },
  returns_value: { label: '$ returned — weekly average value of the goods Odoo received back over the last 4 weeks', unit: 'money', server: true },
  sales_usd_k: { label: 'Sales in thousands of USD — Odoo orders, USD ones as they are, others at today\'s rate', unit: 'number', server: true },
  azuni_skus_sold: { label: '# Azuni SKUs sold in the week (Odoo orders)', unit: 'number', server: true },
  returns_note: { label: 'Return actions — what came back in the week, by SKU (Odoo returns)', unit: 'text', server: true },
  reviews_new: { label: 'New reviews — what the store listings gained since the last week (their pages)', unit: 'number', server: true },
  // What the Where to Buy check reads on each store page (2026-11-16); Amazon counts ratings.
  reviews_15plus: { label: '# products whose page on the store shows more than 15 reviews (read from the store pages)', unit: 'number', server: true },
  top_losers_sales: { label: 'Sales of the tab\'s list of top losers — products only, Odoo orders of the week (BB&B / Overstock)', unit: 'money', server: true },
  // 2026-11-16, every marketplace: what the PIM sends or exports (the listing files are noted from that day on).
  listings_updated: { label: '# listings optimized — products the PIM pushed to the store or marketplace that week, or whose listing file for it was downloaded from the PIM', unit: 'number', server: true },
  // Written by AI (Gemini) from the week's data only: the channel's top losers vs
  // their 8-week average, the cause the PIM can see (no stock, store page sold
  // out or broken) and the actions the PIM recorded (user, 2026-11-05).
  losers_note: { label: 'Actions taken for top losers — note written by AI from the PIM\'s data (losers, causes, recorded actions)', unit: 'text', server: true },
  // The Operations tab (user, 2026-11-16: "necesito que la mayoría de todo eso se
  // pueda traer automático"): `ops` keys are offered on a department's tab only,
  // and worked out by scorecard-fill for the board "operations"
  // (supabase/functions/_shared/scorecardOperations.ts says where each comes
  // from). The country is the row's own; a week runs Sunday to Saturday, Eastern.
  // Customer care, asked from WeCare (our customer-care app) through its own API: totals only.
  ops_care_tickets_closed: { label: 'Tickets closed — WeCare: the customers\' tickets closed in the week, automated notifications left out', unit: 'number', server: true, ops: true },
  ops_care_resolution_hours: { label: 'Resolution time — WeCare: hours from a ticket\'s creation to its closing, for the tickets closed in the week (the clock runs nights and weekends, as on WeCare\'s dashboard)', unit: 'hours', server: true, ops: true },
  ops_care_csat: { label: 'Customer satisfaction — WeCare\'s survey: share of the week\'s answers rating 4 or 5 of 5', unit: 'percent', server: true, ops: true },
  ops_label_cost: { label: 'Shipping cost per label — ShipStation: Canada, the week\'s cost ÷ every label (the marketplaces\' prepaid ones count as $0, as on its dashboard); USA, the average of the labels we paid for', unit: 'money', server: true, ops: true },
  ops_orders_processed: { label: 'Orders processed — the labels made in the week (ShipStation)', unit: 'number', server: true, ops: true },
  ops_return_label_cost: { label: 'Cost per return label — the average of the week\'s return labels (ShipStation)', unit: 'money', server: true, ops: true },
  ops_ontime_homedepot: { label: 'On-time shipping, Home Depot — the number of its own tab: paid orders labelled by the 2nd business day', unit: 'percent', server: true, ops: true },
  ops_ontime_rona: { label: 'On-time shipping, Rona — the number of its own tab: paid orders labelled by the 2nd business day', unit: 'percent', server: true, ops: true },
  ops_ontime_amazon: { label: 'On-time shipping, Amazon (the orders we ship, not FBA) — the number of its own tab: paid orders labelled by the 2nd business day', unit: 'percent', server: true, ops: true },
  ops_ontime_walmart: { label: 'On-time shipping, Walmart — the number of its own tab: paid orders labelled by the 2nd business day', unit: 'percent', server: true, ops: true },
  ops_ontime_bestbuy: { label: 'On-time shipping, Best Buy — the number of its own tab: paid orders labelled by the 2nd business day', unit: 'percent', server: true, ops: true },
  ops_ontime_lowes: { label: 'On-time shipping, Lowe\'s — the number of its own tab: paid orders labelled by the 2nd business day', unit: 'percent', server: true, ops: true },
  ops_sameday_wayfair: { label: 'Same-day shipping, Wayfair — paid orders whose labels were all made the day of the order', unit: 'percent', server: true, ops: true },
  ops_on_time: { label: 'Orders processed on time — every paid order we ship (not Amazon FBA) labelled by the 2nd business day', unit: 'percent', server: true, ops: true },
  ops_late_24h: { label: 'Orders not processed in 24 h — paid orders we ship not labelled by the end of the next business day', unit: 'number', server: true, ops: true },
  ops_returns_processed: { label: 'Returns processed — the returns Odoo received at the country\'s warehouse in the week', unit: 'number', server: true, ops: true },
  ops_returns_to_stock: { label: 'Returns back to stock — share of the units Odoo received back that went to stock', unit: 'percent', server: true, ops: true },
  ops_returns_to_openbox: { label: 'Returns to Open Box — share of the units Odoo received back that went to Open Box', unit: 'percent', server: true, ops: true },
  ops_returns_over_sales: { label: 'Returns over sales — value of the goods Odoo received back ÷ what was sold, over the last 4 weeks (both countries: in USD)', unit: 'percent', server: true, ops: true },
  ops_open_box_sales: { label: 'Open Box sales — what the -OB products sold for in the week, before tax (Odoo)', unit: 'money', server: true, ops: true },
  ops_assembly_sinks: { label: 'Assembly, sinks — units of sinks assembled in the week (Odoo\'s manufacturing orders)', unit: 'number', server: true, ops: true },
  ops_assembly_versa: { label: 'Assembly, Versa sinks — units of S-6 sinks assembled in the week (Odoo\'s manufacturing orders)', unit: 'number', server: true, ops: true },
  ops_shipment_errors: { label: 'Shipment errors — the orders Odoo holds as Wrong Items or Missing Items in the week', unit: 'number', server: true, ops: true },
  ops_oos_assembly_loss: { label: 'Assembly sales lost to out of stock — assembled products at 0 units now × their weekly sales of the 8 weeks before', unit: 'money', server: true, ops: true },
  ops_cycle_count: { label: 'Cycle count — products counted in the week at the country\'s warehouse (Odoo)', unit: 'number', server: true, ops: true },
  ops_inventory_accuracy: { label: 'Inventory accuracy — products counted in the week whose count moved the stock by 5 units or less (Odoo)', unit: 'percent', server: true, ops: true },
  ops_in_stock: { label: 'Stock available for sale — share of the products Odoo tracks in the country that have stock', unit: 'percent', server: true, ops: true },
  ops_doi_sinks: { label: 'Sinks below 70 days of inventory — selling sinks whose stock, available plus on order, lasts under 70 days at the 90-day pace', unit: 'number', server: true, ops: true },
  ops_doi_faucets: { label: 'Faucets below 70 days of inventory — selling faucets whose stock, available plus on order, lasts under 70 days at the 90-day pace', unit: 'number', server: true, ops: true },
  ops_doi_versa: { label: 'Versa sinks (S-6) below 70 days of inventory — stock available plus on order ÷ the 90-day pace', unit: 'number', server: true, ops: true },
  ops_doi_pietra: { label: 'Pietra sinks (S-8) below 70 days of inventory — stock available plus on order ÷ the 90-day pace', unit: 'number', server: true, ops: true },
  ops_doi_porcelain: { label: 'Porcelain sinks (P-) below 70 days of inventory — stock available plus on order ÷ the 90-day pace', unit: 'number', server: true, ops: true },
  ops_doi_accessories: { label: 'Accessories below 70 days of inventory — stock available plus on order ÷ the 90-day pace', unit: 'number', server: true, ops: true },
  ops_doi_st05: { label: 'ST-05 days of inventory — Odoo\'s replenishment report at the country\'s warehouse, on hand + transit', unit: 'days', server: true, ops: true },
  ops_doi_a918kit: { label: 'A-918KIT days of inventory — Odoo\'s replenishment report at the country\'s warehouse, on hand + transit', unit: 'days', server: true, ops: true },
  ops_doi_a919kit: { label: 'A-919KIT days of inventory — Odoo\'s replenishment report at the country\'s warehouse, on hand + transit', unit: 'days', server: true, ops: true },
  ops_inventory_excess: { label: 'Inventory excess over 180 days — sinks and faucets on hand beyond 180 days of sales, at Odoo\'s average cost', unit: 'money', server: true, ops: true },
  ops_obsolete_value: { label: 'Obsolete inventory — units on hand of the products marked obsolete in the PIM, at Odoo\'s average cost', unit: 'money', server: true, ops: true },
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
