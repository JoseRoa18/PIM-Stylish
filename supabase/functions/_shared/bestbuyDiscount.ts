// Best Buy (Mirakl OF24, JSON) scheduled discount — found 2026-09-30.
//
// The JSON import takes the discount as a NESTED object:
//   discount: { start_date, end_date, ranges: [{ quantity_threshold, price }] }
// (Best Buy runs volume pricing, so the value goes in ranges; `price` is not
// to be used together with ranges). The flat names discount_price /
// discount_ranges / discount_start_date / discount_end_date are the CSV
// file's columns: in JSON Mirakl ignores them without an error, and since
// OF24 runs in NORMAL mode the line then CLEARS the offer's discount. Every
// promotion scheduled from the PIM until 2026-09-30 was dropped that way
// (September never went live on Best Buy; each push also wiped the old one).
//
// Days are the PIM's Eastern calendar: a window runs from 00:00:00 ET of its
// first day to 23:59:59 ET of its last day, sent as UTC instants so Mirakl
// cannot read a bare date in its own time zone.

const ET = "America/Toronto";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day in Eastern time as an instant — 00:00:00, or 23:59:59 with endOfDay — ISO in UTC. */
export function etInstant(day: string, endOfDay = false): string {
  const [y, m, d] = day.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  // ET's offset at a moment (EDT −4 h / EST −5 h), read from the tz database.
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t); // a second pass settles a DST boundary
  return new Date(t).toISOString().replace(".000Z", "Z");
}

/** The Eastern calendar day of an instant (or a day passed through). */
export function etDayOf(v: string): string {
  return DAY.test(v) ? v : new Date(v).toLocaleDateString("en-CA", { timeZone: ET });
}

/**
 * The OF24 `discount` object for a promo price over [start, end]. Days
 * (YYYY-MM-DD) become the ET instants above; full instants pass through. A
 * start that is not in the future moves to a couple of minutes from now, so
 * a window that already began goes live as soon as Mirakl processes it.
 */
export function bbDiscount(price: number, start: string, end: string): Record<string, unknown> {
  const s = DAY.test(start) ? etInstant(start) : start;
  const e = DAY.test(end) ? etInstant(end, true) : end;
  const soon = new Date(Date.now() + 2 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    start_date: Date.parse(s) > Date.now() + 60_000 ? s : soon,
    end_date: e,
    ranges: [{ quantity_threshold: 1, price }],
  };
}

/** A live offer discount (OF21 `discount`) carried into an OF24 line unchanged — null once it has ended. */
export function carryDiscount(d: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!d) return null;
  const end = typeof d.end_date === "string" ? d.end_date : null;
  if (end && Date.parse(end) <= Date.now()) return null; // expired: nothing to keep
  const ranges = Array.isArray(d.ranges) && d.ranges.length
    ? d.ranges
    : typeof d.discount_price === "number" ? [{ quantity_threshold: 1, price: d.discount_price }] : null;
  if (!ranges) return null;
  return {
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
