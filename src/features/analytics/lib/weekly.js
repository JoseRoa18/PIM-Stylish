// Week math + snapshot lookups for the Analytics page. Weeks run Monday to
// Sunday in the viewer's local time; "this week" ends today.

const DAY = 86400000;

export function toDateKey(d) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Monday 00:00 of the week containing `d`. */
export function weekStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const dow = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - dow);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** The weeks available for the picker: this week + the previous `count - 1`. */
export function recentWeeks(count = 8, today = new Date()) {
  const out = [];
  const start = weekStart(today);
  for (let i = 0; i < count; i++) {
    const s = addDays(start, -7 * i);
    const e = addDays(s, 6);
    out.push({
      key: toDateKey(s),
      start: s,
      end: i === 0 ? today : e,
      endOfWeek: e,
      label: i === 0 ? 'This week' : i === 1 ? 'Last week' : `Week of ${formatShort(s)}`,
      range: `${formatShort(s)} – ${formatShort(e)}`,
    });
  }
  return out;
}

export function formatShort(d) {
  return new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

/**
 * Snapshots are sparse (one per day at best). Index them by scope/key and
 * find the latest one on or before a date — "how things stood at the end of
 * that day".
 */
export function indexSnapshots(rows) {
  const idx = new Map();
  for (const r of rows) {
    const k = `${r.scope}|${r.key}`;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(r);
  }
  for (const list of idx.values()) list.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  return idx;
}

export function snapshotAt(idx, scope, key, date) {
  const list = idx.get(`${scope}|${key}`) ?? [];
  const limit = toDateKey(date);
  let hit = null;
  for (const r of list) {
    if (r.snapshot_date <= limit) hit = r;
    else break;
  }
  return hit;
}

export function latestSnapshot(idx, scope, key) {
  const list = idx.get(`${scope}|${key}`) ?? [];
  return list.length ? list[list.length - 1] : null;
}

/** One point per week (the last snapshot of each week) for the past `weeks` weeks. */
export function weeklySeries(idx, scope, key, metric, weeks = 12, today = new Date()) {
  const points = [];
  const start = weekStart(today);
  for (let i = weeks - 1; i >= 0; i--) {
    const s = addDays(start, -7 * i);
    const e = i === 0 ? today : addDays(s, 6);
    const snap = snapshotAt(idx, scope, key, e);
    // Only count a snapshot that belongs to that week (or earlier for the
    // first point) — otherwise a single old row would flat-line the chart.
    const inWeek = snap && (snap.snapshot_date >= toDateKey(s) || i === weeks - 1);
    points.push({ week: s, label: formatShort(s), value: inWeek ? snap.metrics?.[metric] ?? null : null, date: inWeek ? snap.snapshot_date : null });
  }
  return points;
}

/** Signed change between two snapshot metrics; null when either side is unknown. */
export function delta(now, before, metric) {
  const a = now?.metrics?.[metric];
  const b = before?.metrics?.[metric];
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return a - b;
}

/** Which checks were closed (fewer products missing) between two snapshots. */
export function gapsClosed(now, before) {
  const a = now?.metrics?.missing ?? {};
  const b = before?.metrics?.missing ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) {
    const diff = (b[k] ?? 0) - (a[k] ?? 0);
    if (diff !== 0) out.push({ key: k, closed: diff });
  }
  return out.sort((x, y) => y.closed - x.closed);
}

/**
 * Straight-line projection toward a target from the last N weekly points:
 * returns { onTrack, eta } where eta is the projected date to reach the
 * target at the current pace (null when the pace is zero or negative).
 */
export function projectToTarget(points, target, today = new Date()) {
  const valid = points.filter((p) => typeof p.value === 'number');
  if (valid.length < 2 || typeof target?.pct !== 'number') return { onTrack: null, eta: null, pace: null };
  const first = valid[0];
  const last = valid[valid.length - 1];
  const weeksBetween = Math.max(1, Math.round((last.week - first.week) / (7 * DAY)));
  const pace = (last.value - first.value) / weeksBetween; // points per week
  if (last.value >= target.pct) return { onTrack: true, eta: today, pace };
  if (pace <= 0) return { onTrack: false, eta: null, pace };
  const weeksNeeded = (target.pct - last.value) / pace;
  const eta = addDays(today, Math.ceil(weeksNeeded * 7));
  const due = target.date ? parseDateKey(target.date) : null;
  return { onTrack: due ? eta <= due : true, eta, pace };
}

/** Compact number for tiles: 1,284 / 12.9K. */
export function compact(n) {
  if (n == null) return '—';
  if (Math.abs(n) >= 10000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString('en-CA');
}
