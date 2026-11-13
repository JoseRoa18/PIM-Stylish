// What to change on Walmart so a product carries a deal's price on the deal's
// days, from the promotions Walmart holds for it right now (channel-deals,
// 2026-11-13). Pure: no request is made here.
//
// Walmart refuses two promotions of one SKU on the same days ("The entered
// promotion dates range is overlapping"; on Walmart Canada "it will result in
// an error"), and the days of a promotion that has started cannot be changed.
// So a deal is CARVED out of what is there: every promotion that touches the
// deal's days is deleted, the deal's is created for those days, and what a
// deleted promotion still had after the deal's last day is created again at
// its own price (the monthly promotion's rest), so Walmart goes back to it by
// itself when the deal ends. A product that already sells at the deal's price
// today is left as it is.

const same = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** A promotion asked to start "now" starts in a few minutes (walmart-push-promo's own rule). */
export const LEAD_MS = 5 * 60_000;
// What is left of a promotion after a deal is created again only if it lasts longer than this.
const WORTH_MS = 60 * 60_000;
const DAY_MS = 24 * 3600_000;

/** Walmart's answer to GET /v3/promo/sku/{sku} as plain promotions: [{ id, price, regular, type, start, end }] (ms). */
export function readWalmartPromos(data) {
  const list = data?.payload?.pricingList?.pricing ?? data?.pricingList?.pricing ?? [];
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => ({
      id: p.promoId ?? null,
      price: num(p.currentPrice?.value?.amount ?? p.currentPrice?.amount),
      regular: num(p.comparisonPrice?.value?.amount ?? p.comparisonPrice?.amount),
      type: p.currentPriceType ?? null,
      start: Number(p.effectiveDate),
      end: Number(p.expirationDate),
    }))
    .filter((p) => p.price != null && Number.isFinite(p.start) && Number.isFinite(p.end))
    .sort((a, b) => a.start - b.start);
}

const covering = (promos, at) => promos.find((p) => p.start <= at && p.end > at) ?? null;

/**
 * A deal's price on a product, from now to the deal's last minute.
 * @param promos  what Walmart holds (readWalmartPromos)
 * @param price   the deal's price
 * @param end     the deal's last minute (ms)
 * @param now     ms
 * @returns { state: 'over' | 'ok' | 'change', deletes: [promo], creates: [{ what: 'deal' | 'rest', price, start, end }],
 *            carrier: { start, end } | null } — carrier = the promotion that gives (or will give) the deal's price
 */
export function planDeal({ promos, price, end, now, lead = LEAD_MS }) {
  const start = now + lead;
  if (end <= start) return { state: 'over', deletes: [], creates: [], carrier: null };
  const cur = covering(promos, start);
  // Already at the deal's price today (the monthly promotion at the same price,
  // or the deal's own promotion): nothing to change. If that promotion ends
  // before the deal does, the caller comes back when it has.
  if (cur && same(cur.price, price)) return { state: 'ok', deletes: [], creates: [], carrier: { start: cur.start, end: cur.end } };
  const overlapping = promos.filter((p) => p.end > start && p.start < end);
  const creates = [{ what: 'deal', price, start, end }];
  for (const p of overlapping) {
    if (p.end > end + WORTH_MS) creates.push({ what: 'rest', price: p.price, start: end + 1000, end: p.end });
  }
  return { state: 'change', deletes: overlapping, creates, carrier: { start, end } };
}

/**
 * A product whose deal is over (ended, deleted, moved, or the product left its
 * list): what the PIM put there comes off, and the monthly promotion's price
 * comes back when the product is in the one running and nothing gives it.
 * @param row      { mode: 'created' | 'found', price, live_end (ms) } — what was noted when the deal went on
 * @param monthly  { price, end (ms) } | null — the running monthly promotion's price for the product
 */
export function planBack({ promos, row, monthly, now, lead = LEAD_MS }) {
  const start = now + lead;
  const cur = covering(promos, start);
  const deletes = [];
  const creates = [];
  // Only a promotion this automation created is taken off: one it found already
  // at the deal's price (the monthly promotion's) is somebody else's.
  const ours = Boolean(cur && row.mode === 'created' && same(cur.price, row.price) && row.live_end != null && Math.abs(cur.end - row.live_end) < DAY_MS);
  if (ours) {
    deletes.push(cur);
    // …and the rest created to follow it, which would now start too late.
    for (const p of promos) if (p !== cur && p.start > start && Math.abs(p.start - (cur.end + 1000)) < 10 * 60_000) deletes.push(p);
  }
  if ((!cur || ours) && monthly && monthly.end > start + WORTH_MS) {
    const kept = promos.filter((p) => !deletes.includes(p) && p.end > start && p.start < monthly.end);
    if (!kept.length) creates.push({ what: 'monthly', price: monthly.price, start, end: monthly.end });
    else {
      const next = Math.min(...kept.map((p) => p.start));
      if (next > start + WORTH_MS) creates.push({ what: 'monthly', price: monthly.price, start, end: next - 1000 });
    }
  }
  return { deletes, creates };
}
