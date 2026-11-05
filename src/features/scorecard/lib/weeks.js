import { etToday } from '@/features/pricing/lib/promoCalendar';

// EOS ScoreCard weeks run Sunday to Saturday (user, 2026-11-03) and are kept
// by their Sunday as 'YYYY-MM-DD'. W1 is the year's first Sunday-to-Saturday
// week that starts in it (2026: Jan 4 – 10), the numbering of the company's
// "2026 Company ScoreCard.xlsx" — its W44 is the week of Sunday Nov 1.
// All arithmetic is on UTC dates, so no time zone moves a day.

const DAY = 86400000;
const toDate = (day) => new Date(`${day}T00:00:00Z`);
const toDay = (d) => d.toISOString().slice(0, 10);

export function addDays(day, n) {
  return toDay(new Date(toDate(day).getTime() + n * DAY));
}

/** The Sunday that starts the week holding `day` (default: today in Eastern time). */
export function weekStartOf(day = etToday()) {
  return addDays(day, -toDate(day).getUTCDay());
}

export const addWeeks = (sunday, n) => addDays(sunday, 7 * n);

function firstSunday(year) {
  const jan1 = toDate(`${year}-01-01`);
  return addDays(`${year}-01-01`, (7 - jan1.getUTCDay()) % 7);
}

/** { year, n } of a week's Sunday: W1 = the first Sunday of its year. */
export function weekNumber(sunday) {
  const year = Number(sunday.slice(0, 4));
  return { year, n: Math.round((toDate(sunday) - toDate(firstSunday(year))) / (7 * DAY)) + 1 };
}

export const weekTag = (sunday) => `W${weekNumber(sunday).n}`;

const SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "Nov 1 – 7", "Oct 25 – Oct 31" style range of a week. */
export function weekRange(sunday) {
  const a = toDate(sunday);
  const b = toDate(addDays(sunday, 6));
  const sameMonth = a.getUTCMonth() === b.getUTCMonth();
  return sameMonth ? `${SHORT.format(a)} – ${b.getUTCDate()}` : `${SHORT.format(a)} – ${SHORT.format(b)}`;
}

/** "Nov 1" — the week's Sunday, the short label of a week column. */
export const weekStartLabel = (sunday) => SHORT.format(toDate(sunday));

/** "Aug 9 – Nov 7" — the days a run of weeks covers. */
export function spanLabel(firstSunday, lastSunday) {
  return `${SHORT.format(toDate(firstSunday))} – ${SHORT.format(toDate(addDays(lastSunday, 6)))}`;
}

/**
 * The scorecard starts at W44 (the column of Sunday Nov 1, 2026 — the numbers of
 * Oct 25–31), where the PIM starts collecting (user, 2026-11-05). Earlier weeks
 * (the workbook's history, the PIM's backfill) stay in the database, hidden.
 */
export const FIRST_WEEK = '2026-11-01';

/** The `count` weeks ending with the week of `lastSunday`, oldest first. */
export function weeksEnding(lastSunday, count = 13) {
  return Array.from({ length: count }, (_, i) => addWeeks(lastSunday, i - count + 1));
}
