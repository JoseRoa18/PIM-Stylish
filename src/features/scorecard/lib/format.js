// How a measurable's numbers are shown, typed and judged. Percentages are
// stored as fractions (0.95) and typed as percent numbers (95).

export const UNITS = [
  { key: 'number', label: 'Number' },
  { key: 'percent', label: 'Percent' },
  { key: 'money', label: 'Money ($)' },
  { key: 'hours', label: 'Hours' },
  { key: 'days', label: 'Days' },
  { key: 'text', label: 'Text (notes)' },
];

// A measurable's target (user, 2026-11-12: "en vez de goal debe llamarse
// target en todo el EOS"). The page says Target everywhere; the stored
// columns keep their first names, `goal` and `goal_op`.
export const TARGET_OPS = [
  { key: '>=', label: 'at least' },
  { key: '>', label: 'more than' },
  { key: '<=', label: 'at most' },
  { key: '<', label: 'less than' },
];

const trim = (n, max) => Number(n.toFixed(max)).toLocaleString('en-US', { maximumFractionDigits: max });

/** The number as shown in a cell (no note). */
export function formatNumber(unit, value) {
  if (value == null) return '';
  const v = Number(value);
  switch (unit) {
    case 'percent': return `${trim(v * 100, Math.abs(v) < 0.1 ? 2 : 1)}%`;
    case 'money': return `${v < 0 ? '−' : ''}$${trim(Math.abs(v), Math.abs(v) >= 100 ? 0 : 2)}`;
    case 'hours': return `${trim(v, 1)} h`;
    case 'days': return `${trim(v, 1)} d`;
    default: return trim(v, 2);
  }
}

/** A stored value as shown: the number, else the typed note. */
export function formatValue(unit, row) {
  if (!row) return '';
  if (unit === 'text') return row.note ?? (row.value != null ? formatNumber('number', row.value) : '');
  return row.value != null ? formatNumber(unit, row.value) : row.note ?? '';
}

/** The text an input starts with when editing a stored value. */
export function toInput(unit, row) {
  if (!row) return '';
  if (row.note && (unit === 'text' || row.value == null)) return row.note;
  if (row.value == null) return '';
  if (unit === 'percent') return String(Number((Number(row.value) * 100).toFixed(4)));
  return String(row.value);
}

/**
 * What was typed → { value, note } to store, or null for "clear the week".
 * "95", "95%" and "95.5 %" are 95 % for a percent measurable; "$1,234.50"
 * and "1234.5" are money; anything that is not a number is kept as a note.
 */
export function parseInput(unit, text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (unit === 'text') return { value: null, note: s };
  const m = s.match(/^([<>]=?)?\s*-?\$?\s*-?[\d,]*\.?\d+\s*(%|h|hrs?|hours?|d|days?)?$/i);
  if (!m) return { value: null, note: s };
  const num = Number(s.replace(/[<>=$,%\s]|hours?|hrs?|days?|h|d/gi, ''));
  if (!Number.isFinite(num)) return { value: null, note: s };
  return { value: unit === 'percent' ? num / 100 : num, note: m[1] ? s : null };
}

/** true / false when the value can be judged against the target, else null. */
export function meetsTarget(metric, value) {
  if (metric.goal == null || !metric.goal_op || value == null) return null;
  const v = Number(value);
  const g = Number(metric.goal);
  switch (metric.goal_op) {
    case '>=': return v >= g - 1e-9;
    case '>': return v > g;
    case '<=': return v <= g + 1e-9;
    case '<': return v < g;
    default: return null;
  }
}

/** "≥ 95%" style target label, or '' without a target. */
export function targetLabel(metric) {
  if (metric.goal == null || !metric.goal_op) return '';
  const sym = { '>=': '≥', '>': '>', '<=': '≤', '<': '<' }[metric.goal_op];
  return `${sym} ${formatNumber(metric.unit === 'text' ? 'number' : metric.unit, metric.goal)}`;
}

/** A target in words, for the Activity Log: "at least 95%", or "no target". `target` = { goal, goal_op } or null. */
export function targetText(unit, target) {
  if (target?.goal == null || !target.goal_op) return 'no target';
  return `${TARGET_OPS.find((o) => o.key === target.goal_op)?.label ?? target.goal_op} ${formatNumber(unit === 'text' ? 'number' : unit, target.goal)}`;
}

/** The text a target's input starts with (a percentage as its percent number). */
export function targetInput(unit, goal) {
  if (goal == null) return '';
  return String(unit === 'percent' ? Number((Number(goal) * 100).toFixed(4)) : Number(goal));
}

/**
 * A typed target → { goal } to store (null = no target), or { error }.
 * "95", "95%", "$80,000" and "1 234.5" are read. The comparison has its own
 * list, so one typed with the number is refused rather than guessed.
 */
export function parseTarget(unit, text) {
  const s = String(text ?? '').trim();
  if (!s) return { goal: null };
  if (/^[<>≤≥=]/.test(s)) return { error: 'Choose the comparison in the list and type only the number.' };
  const num = Number(s.replace(/[$,%\s]|hours?|hrs?|days?|h|d/gi, ''));
  if (!/\d/.test(s) || !Number.isFinite(num)) return { error: 'The target must be a number.' };
  return { goal: unit === 'percent' ? num / 100 : num };
}
