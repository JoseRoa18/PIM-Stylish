import { meetsTarget } from './format';

// How a measurable stands in one week, and the filters made of it (user,
// 2026-11-12: "filtrar si quiere ver los on track, los off track o off
// target"). The week's strip counts the rows by it, and each counter is the
// filter of the grid below. "Left to fill" is one more (user, 2026-11-16:
// "filtrar por los KPI que están en blank para que ellos puedan ir llenándolos
// más fácil"): the measurables a person types that have nothing in the week.

/** The filters, in the strip's order. `none` = "every measurable here has one". */
export const STATUS_FILTERS = [
  { key: 'empty', label: 'left to fill', none: 'is left to fill' },
  { key: 'on', label: 'on target', none: 'is on target' },
  { key: 'off', label: 'off target', none: 'is off target' },
  { key: 'none', label: 'without a target', none: 'is without a target' },
];
export const isStatusFilter = (key) => STATUS_FILTERS.some((f) => f.key === key);

/**
 * 'on' / 'off' (the week's number against the target), 'none' (the row has no
 * target), or null: a target and no number to hold against it, or a text row.
 */
export function statusOf(metric, row) {
  if (metric.unit === 'text') return null;
  const ok = meetsTarget(metric, row?.value);
  if (ok != null) return ok ? 'on' : 'off';
  return metric.goal == null ? 'none' : null;
}

/** A measurable a person types — not one of the PIM's — with nothing in the week yet (a text row too). */
export const isToFill = (metric, row) => !metric.auto_key && !(row && (row.value != null || row.note));

/** The week the strip reads: the latest shown one, never a coming week (the grid shows them, empty). */
export const judgedWeek = (weeks, thisWeek) => (weeks.at(-1) > thisWeek ? thisWeek : weeks.at(-1));

/** The rows of `week` at a glance: how many numbers are in, left to fill, on and off target, without one, and `userId`'s own still to fill. */
export function summarizeWeek(rows, values, week, userId = null) {
  const out = { week, total: 0, filled: 0, empty: 0, on: 0, off: 0, none: 0, mineEmpty: 0 };
  for (const m of rows) {
    const row = values.get(`${m.id}|${week}`);
    if (isToFill(m, row)) out.empty += 1;
    if (m.unit === 'text') continue;
    const has = Boolean(row && (row.value != null || row.note));
    const status = statusOf(m, row);
    out.total += 1;
    if (has) out.filled += 1;
    if (status) out[status] += 1;
    if (!has && !m.auto_key && userId && m.owner_id === userId) out.mineEmpty += 1;
  }
  return out;
}

/**
 * The rows a filter keeps (null = all of them). `keep`: ids that stay under
 * "left to fill" although they are filled — the ones typed just now, so the
 * number can be read back and corrected before the row leaves the list.
 */
export function rowsWithStatus(rows, values, week, filter, keep = null) {
  if (!filter) return rows;
  return rows.filter((m) => {
    const row = values.get(`${m.id}|${week}`);
    return filter === 'empty' ? isToFill(m, row) || Boolean(keep?.has(m.id)) : statusOf(m, row) === filter;
  });
}
