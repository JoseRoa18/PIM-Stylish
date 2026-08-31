// Promotion calendar (rule 2026-08-28):
//   USA    — flips on the 1st of the month at 00:00 Eastern.
//   Canada — flips on the FIRST THURSDAY of the month at 00:00 Eastern and
//            runs until the day before the next month's first Thursday
//            (Thursday-to-Thursday, no gaps).
// Everything is scheduled/loaded one day ahead; prices change at the
// effective moment. Dates are handled as 'YYYY-MM-DD' strings in ET.

const ET = 'America/Toronto';
const pad = (n) => String(n).padStart(2, '0');

/** Today's date in Eastern time, optionally shifted by whole days. */
export function etToday(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: ET });
}

/** 'YYYY-MM-DD' → 'YYYY-MM-01' */
export const periodOfDay = (day) => `${day.slice(0, 7)}-01`;

export function nextPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}

export function prevPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
}

export function monthEnd(period) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0));
  return `${last.getUTCFullYear()}-${pad(last.getUTCMonth() + 1)}-${pad(last.getUTCDate())}`;
}

/** Shift a 'YYYY-MM-DD' by whole days (pure date math, no timezones). */
export function shiftDay(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** First Thursday of the period's month. */
export function firstThursday(period) {
  const [y, m] = period.split('-').map(Number);
  for (let d = 1; d <= 7; d++) {
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 4) return `${y}-${pad(m)}-${pad(d)}`;
  }
  return period; // unreachable
}

/** The days a promotion is live on each market's channels. */
export function marketWindow(period, market) {
  if (market === 'us') return { start: period, end: monthEnd(period) };
  return { start: firstThursday(period), end: shiftDay(firstThursday(nextPeriod(period)), -1) };
}

export const windowContains = (w, day) => day >= w.start && day <= w.end;

/**
 * The promo period whose window for `market` contains `day` — the current
 * month's, or (before Canada's first Thursday) still the previous month's.
 */
export function activePeriodFor(market, day = etToday()) {
  for (const p of [periodOfDay(day), prevPeriod(periodOfDay(day))]) {
    if (windowContains(marketWindow(p, market), day)) return p;
  }
  return null;
}
