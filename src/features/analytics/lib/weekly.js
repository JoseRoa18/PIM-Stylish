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

/** ISO-8601 week number (weeks start Monday; week 1 holds the year's first Thursday). */
export function isoWeek(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return { year: x.getUTCFullYear(), week: Math.ceil(((x - yearStart) / DAY + 1) / 7) };
}

/** "Week 36" — how the team names a week. */
export function weekName(d) {
  return `Week ${isoWeek(d).week}`;
}

/** "W36" — the short form for axis ticks and file names. */
export function weekTag(d) {
  return `W${isoWeek(d).week}`;
}

/** The weeks available for the picker: this week + the previous `count - 1`. */
export function recentWeeks(count = 8, today = new Date()) {
  const out = [];
  const start = weekStart(today);
  for (let i = 0; i < count; i++) {
    const s = addDays(start, -7 * i);
    const e = addDays(s, 6);
    const { year, week } = isoWeek(s);
    out.push({
      key: toDateKey(s),
      start: s,
      end: i === 0 ? today : e,
      endOfWeek: e,
      number: week,
      year,
      name: `Week ${week}`,
      tag: `W${week}`,
      hint: i === 0 ? 'this week' : i === 1 ? 'last week' : null,
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
    points.push({ week: s, label: weekTag(s), range: `${formatShort(s)} – ${formatShort(addDays(s, 6))}`, value: inWeek ? snap.metrics?.[metric] ?? null : null, date: inWeek ? snap.snapshot_date : null });
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

/** Bucket audit rows into the last `weeks` ISO weeks: [{ week, label, rows }]. */
export function weekBuckets(rows, weeks = 12, today = new Date()) {
  const start = weekStart(today);
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const s = addDays(start, -7 * i);
    out.push({ week: s, label: weekTag(s), range: `${formatShort(s)} – ${formatShort(addDays(s, 6))}`, rows: [] });
  }
  for (const r of rows) {
    const t = new Date(r.occurred_at);
    const idx = Math.floor((t - out[0].week) / (7 * DAY));
    if (idx >= 0 && idx < out.length) out[idx].rows.push(r);
  }
  return out;
}

/**
 * Gap aging from the daily catalog snapshots: for every check, how long each
 * SKU has been missing it (consecutive days up to the latest snapshot).
 * Returns [{ key, count, over7, over30, oldestDays, oldestSku }].
 */
export function gapAging(idx, today = new Date()) {
  const list = idx.get('pim|all') ?? [];
  const withSkus = list.filter((r) => r.metrics?.missing_skus);
  if (!withSkus.length) return [];
  const latest = withSkus[withSkus.length - 1];
  const out = [];
  for (const [key, skus] of Object.entries(latest.metrics.missing_skus)) {
    let over7 = 0;
    let over30 = 0;
    let oldestDays = 0;
    let oldestSku = null;
    for (const sku of skus) {
      // Walk back through consecutive snapshots that still list the SKU.
      let since = latest.snapshot_date;
      for (let i = withSkus.length - 2; i >= 0; i--) {
        if ((withSkus[i].metrics.missing_skus?.[key] ?? []).includes(sku)) since = withSkus[i].snapshot_date;
        else break;
      }
      const days = Math.max(0, Math.round((today - parseDateKey(since)) / DAY));
      if (days >= 7) over7 += 1;
      if (days >= 30) over30 += 1;
      if (days > oldestDays) { oldestDays = days; oldestSku = sku; }
    }
    out.push({ key, count: skus.length, over7, over30, oldestDays, oldestSku });
  }
  return out.sort((a, b) => b.over30 - a.over30 || b.over7 - a.over7 || b.count - a.count);
}
