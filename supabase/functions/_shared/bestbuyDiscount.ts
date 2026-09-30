// Best Buy (Mirakl OF24, JSON) scheduled discount — found 2026-09-30.
//
// The JSON import takes the discount as a NESTED object:
//   discount: { price, start_date, end_date, ranges: [{ quantity_threshold, price }] }
// Best Buy runs volume pricing, so the value goes in ranges — and this
// instance ALSO requires discount.price ("The discount price is incorrect:
// must not be null", checked on S-830WL), whatever the docs say about using
// one or the other. The flat names discount_price / discount_ranges /
// discount_start_date / discount_end_date are the CSV file's columns: in JSON
// Mirakl ignores them without an error, and since OF24 runs in NORMAL mode
// the line then CLEARS the offer's discount. Every promotion scheduled from
// the PIM until 2026-09-30 was dropped that way (September never went live
// on Best Buy; each push also wiped the old one).
//
// Dates are WHOLE DAYS in Mirakl's own time zone (Pacific — Best Buy Canada):
// an instant is cut to its Pacific date, so "Oct 1 00:00 ET" (= Sep 30 21:00
// PT) became Sep 30 and put S-830WL on sale a day early. The window's days go
// as plain dates: 2026-10-01 → 2026-10-21 is stored as Oct 1 00:00 PT → Oct 21
// 23:59:59 PT (03:00 ET the first day to 02:59 ET the day after the last).
// A start already past is accepted and goes live as soon as Mirakl imports it.

const ET = "America/Toronto";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The Eastern calendar day of an instant (or a day passed through). */
export function etDayOf(v: string): string {
  return DAY.test(v) ? v : new Date(v).toLocaleDateString("en-CA", { timeZone: ET });
}

/** The OF24 `discount` object for a promo price over the days [start, end] (YYYY-MM-DD). */
export function bbDiscount(price: number, start: string, end: string): Record<string, unknown> {
  return {
    price,
    start_date: String(start).slice(0, 10),
    end_date: String(end).slice(0, 10),
    ranges: [{ quantity_threshold: 1, price }],
  };
}

/** A live offer discount (OF21 `discount`) carried into an OF24 line unchanged — null once it has ended. */
export function carryDiscount(d: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!d) return null;
  const end = typeof d.end_date === "string" ? d.end_date : null;
  if (end && Date.parse(end) <= Date.now()) return null; // expired: nothing to keep
  const ranges = Array.isArray(d.ranges) && d.ranges.length
    ? d.ranges as { price?: number }[]
    : typeof d.discount_price === "number" ? [{ quantity_threshold: 1, price: d.discount_price }] : null;
  if (!ranges) return null;
  const price = typeof d.discount_price === "number" ? d.discount_price : Number(ranges[0]?.price);
  return {
    price,
    ...(typeof d.start_date === "string" ? { start_date: d.start_date } : {}),
    ...(end ? { end_date: end } : {}),
    ranges,
  };
}

/** True while a live discount is running (started, not ended). */
export function discountRunning(d: Record<string, unknown> | null | undefined): boolean {
  if (!d) return false;
  const now = Date.now();
  const s = typeof d.start_date === "string" ? Date.parse(d.start_date) : -Infinity;
  const e = typeof d.end_date === "string" ? Date.parse(d.end_date) : Infinity;
  return s <= now && now < e;
}
