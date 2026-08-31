// Promotion calendar (rule 2026-08-28) — Deno mirror of
// src/features/pricing/lib/promoCalendar.js. Keep both in sync.
//   USA    — flips on the 1st of the month at 00:00 Eastern.
//   Canada — flips on the FIRST THURSDAY of the month at 00:00 Eastern and
//            runs until the day before the next month's first Thursday.

const ET = "America/Toronto";
const pad = (n: number) => String(n).padStart(2, "0");

export type Market = "us" | "ca";
export interface Window { start: string; end: string }

export function etToday(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("en-CA", { timeZone: ET });
}

export const periodOfDay = (day: string): string => `${day.slice(0, 7)}-01`;

export function nextPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}

export function prevPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
}

export function monthEnd(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0));
  return `${last.getUTCFullYear()}-${pad(last.getUTCMonth() + 1)}-${pad(last.getUTCDate())}`;
}

export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function firstThursday(period: string): string {
  const [y, m] = period.split("-").map(Number);
  for (let d = 1; d <= 7; d++) {
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 4) return `${y}-${pad(m)}-${pad(d)}`;
  }
  return period; // unreachable
}

export function marketWindow(period: string, market: Market): Window {
  if (market === "us") return { start: period, end: monthEnd(period) };
  return { start: firstThursday(period), end: shiftDay(firstThursday(nextPeriod(period)), -1) };
}

export const windowContains = (w: Window, day: string): boolean => day >= w.start && day <= w.end;

export function activePeriodFor(market: Market, day = etToday()): string | null {
  for (const p of [periodOfDay(day), prevPeriod(periodOfDay(day))]) {
    if (windowContains(marketWindow(p, market), day)) return p;
  }
  return null;
}
