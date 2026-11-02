// How far a store's live price may sit from the price the PIM expects and
// still count as aligned (user, 2026-11-02, every channel of Price
// Alignment): ±10 when the expected price is 200 or more, ±5 under 200 — in
// the channel's own currency (USD in the USA, CAD in Canada). One rule for
// the app's report (src/features/pricing/api/priceAlignment.js, through
// src/features/pricing/lib/priceTolerance.js), the daily health-refresh
// snapshot (Listing Health's "Price at Expected", the KPI) and
// walmart-pull-items' re-read order. Change it here, never in a copy.
export const TOLERANCE_FROM = 200;
export const TOLERANCE_HIGH = 10;
export const TOLERANCE_LOW = 5;

/** The margin a price expected at `expected` gets (10 from 200 up, else 5). */
export function priceTolerance(expected) {
  return Number(expected) >= TOLERANCE_FROM ? TOLERANCE_HIGH : TOLERANCE_LOW;
}

/**
 * True when the live price is further from the expected one than its margin
 * (exactly the margin away still counts as aligned). No price on either side
 * is no difference.
 */
export function priceOff(live, expected) {
  if (live == null || expected == null) return false;
  return Math.abs(Number(live) - Number(expected)) > priceTolerance(expected) + 0.005;
}
