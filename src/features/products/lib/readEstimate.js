// How long reading one store page takes, for the "about 25 s left" a person
// sees after pressing "Read again" on the product's Where to Buy tab (user,
// 2026-11-25: "que diga un estimado de cuánto falta").
//
// The estimate is the store's own time: the audit keeps how long its last
// reads took (`learned`, { [retailer]: { ms, n } }), so it corrects itself.
// A store never read this way starts from SEED_S — a store the PIM opens by
// itself answers in seconds, one that has to be opened for it takes half a
// minute, and Lowe's and Menards answer through a job of a couple of minutes.

const SEED_S = {
  sinksdirect_ca: 8, sinksdirect_us: 8, build_with_rise: 8, kbauthority: 8, warehouse_usa: 8,
  walmart_ca: 20, walmart_us: 20,
  wayfair_ca: 30, wayfair_us: 30, bestbuy_ca: 30, amazon_ca: 30, amazon_us: 30, homedepot_us: 30, overstock_us: 30, ebay: 30,
  rona: 40, homedepot_ca: 45, bbb_us: 45,
  lowes_us: 150, menards: 150,
};
const DEFAULT_S = 30;
// A count that reaches zero before the page is read is worse than one that
// ends early: the store's usual time plus a fifth, in steps of 5 s.
const MARGIN = 1.2;
const STEP_MS = 5000;

/** The time to count down from, in ms. */
export function estimateMs(retailer, learned = null) {
  const usual = Number(learned?.[retailer]?.ms);
  if (!(usual > 0)) return (SEED_S[retailer] ?? DEFAULT_S) * 1000;
  return Math.max(STEP_MS, Math.ceil((usual * MARGIN) / STEP_MS) * STEP_MS);
}

/** What is left, in words short enough for a table cell. */
export function leftText(estimate, elapsed) {
  const left = estimate - elapsed;
  if (left > 90_000) return `about ${Math.ceil(left / 60_000)} min left`;
  if (left > 7_500) return `about ${Math.ceil(left / STEP_MS) * 5} s left`;
  if (left > 0) return 'almost done…';
  return 'a little longer…';
}

/** The share of the bar that has passed (it never reaches the end by the clock alone). */
export const readShare = (estimate, elapsed) => Math.min(0.95, Math.max(0, elapsed / Math.max(1, estimate)));
