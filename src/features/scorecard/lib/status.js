import { meetsTarget } from './format';

// How a measurable stands in one week, and the filters made of it (user,
// 2026-11-12: "filtrar si quiere ver los on track, los off track o off
// target"). The week's strip counts the rows by it, and each counter is the
// filter of the grid below.

/** The filters, in the strip's order. `none` = "every measurable here has one". */
export const STATUS_FILTERS = [
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

/** The week the strip reads: the latest shown one, never a coming week (the grid shows them, empty). */
export const judgedWeek = (weeks, thisWeek) => (weeks.at(-1) > thisWeek ? thisWeek : weeks.at(-1));

/** The rows of `week` at a glance: how many numbers are in, on and off target, without one, and `userId`'s own still to fill. */
export function summarizeWeek(rows, values, week, userId = null) {
  const out = { week, total: 0, filled: 0, on: 0, off: 0, none: 0, mineEmpty: 0 };
  for (const m of rows) {
    if (m.unit === 'text') continue;
    const row = values.get(`${m.id}|${week}`);
    const has = Boolean(row && (row.value != null || row.note));
    const status = statusOf(m, row);
    out.total += 1;
    if (has) out.filled += 1;
    if (status) out[status] += 1;
    if (!has && !m.auto_key && userId && m.owner_id === userId) out.mineEmpty += 1;
  }
  return out;
}

/** The rows a filter keeps (null = all of them). */
export const rowsWithStatus = (rows, values, week, filter) => (filter ? rows.filter((m) => statusOf(m, values.get(`${m.id}|${week}`)) === filter) : rows);
