// A promotion's days are never chosen before today (user, 2026-11-20: "que PIM
// no deje escoger fechas anteriores a la actual, es decir, si hoy es 20, no
// podemos escoger 19, ni 10 ni nada, solo del 20 en adelante"). One rule for
// every place in Pricing where a day is picked or read from a file: the new
// promotion form (flash deals, MK events, peak season events, a monthly
// promotion's custom dates), the dates on a promotion's card, and coupons —
// the form and the template. Today is the Eastern day, like every promotion
// window (`etToday`).
//
// Only a day that is being CHOSEN is checked: a day a promotion already had
// stays as it is (`was`), so a deal that began last week can still get a new
// last day, and going back to the market calendar chooses no day at all.
import { etToday, marketWindow, periodOfDay, prevPeriod } from './promoCalendar';

const dayText = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
const monthText = (period) => new Date(`${String(period).slice(0, 7)}-15T12:00:00`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });

/** The first day a date picker offers: today. */
export const firstDay = () => etToday();

/**
 * What is wrong with one chosen day, in words, or null.
 * `what`: how the field is called ("first day", "Canada last day");
 * `was`: the day it held before, which is never refused.
 */
export function pastDayProblem(day, { what = 'date', was = null, today = etToday() } = {}) {
  if (!day || day >= today) return null;
  if (was && day === was) return null;
  return `The ${what} (${dayText(day)}) is before today, ${dayText(today)}: pick today or a later day.`;
}

/** The first problem among a promotion's two days, or null. `was` = { start, end } of what it had. */
export function pastDaysProblem(start, end, { was = null, label = '', today = etToday() } = {}) {
  const name = (word) => (label ? `${label} ${word}` : word);
  return pastDayProblem(start, { what: name('first day'), was: was?.start ?? null, today })
    ?? pastDayProblem(end, { what: name('last day'), was: was?.end ?? null, today });
}

/** Is a month's calendar over in both countries? (Its Canada days run a few days into the next month.) */
const monthOver = (period, today) => ['us', 'ca'].every((m) => marketWindow(period, m).end < today);

/**
 * A monthly promotion on its market calendar picks a month, not days: a
 * month that is over in both countries is refused, the one running today is
 * not — its days began before today, and nobody chose them.
 */
export function pastMonthProblem(period, { today = etToday() } = {}) {
  if (!/^\d{4}-\d{2}/.test(String(period ?? ''))) return null;
  const p = `${String(period).slice(0, 7)}-01`;
  return monthOver(p, today) ? `${monthText(p)} is already over in both countries: pick the month that runs today or a later one.` : null;
}

/** The first month a monthly promotion can be made for, as 'YYYY-MM': last month while its Canada days still run, else this one. */
export function firstMonth(today = etToday()) {
  const now = periodOfDay(today);
  const before = prevPeriod(now);
  return (monthOver(before, today) ? now : before).slice(0, 7);
}
