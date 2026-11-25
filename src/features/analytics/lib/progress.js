// Analytics → Progress to 100% (user, 2026-11-25: "medir issues semana por
// semana … qué listados faltan para llegar al 100%, cuántos están malos, de
// PIM y de los marketplaces"). Everything here is read from the daily KPI
// snapshots (kpi_snapshots), never computed again:
//   - the PIM: its catalog row ('pim' / 'all') — the products scored, how many
//     are complete, every product's score and which products miss each field;
//   - a marketplace: its 'channel' row (the totals) and, for the days being
//     compared, its 'channel_detail' row (each listing's score and the
//     listings failing each check).
// One vocabulary for both:
//   listing   a product as the PIM scores it, or as a marketplace's Listing
//             Health scores it;
//   issue     one check one listing fails (a field missing or wrong in the
//             PIM, a failed check on the marketplace);
//   at 100%   a listing with no issue;   left = the others;
//   bad       a listing scoring under 70 (Listing Health's Needs Work and
//             Critical bands).
// Pure: the reads are in api/kpi.js.

import { CHECKS, GROUPS } from '@/features/products/lib/completeness';
import { MARKETPLACES, marketplaceChecks } from '@/features/dashboard/lib/listingHealth';
import { addDays, formatShort, parseDateKey, toDateKey, weekStart, weekTag } from './weekly';

/** A listing under this score is "bad". */
export const BAD_UNDER = 70;

// The marketplaces in the order of Listing Health's tabs.
const ORDER = ['wix', 'wix_sinksdirect_us', 'wix_stylish_ca', 'wix_stylish_us', 'wix_azuni_ca', 'wayfair', 'wayfair_usa', 'bestbuy', 'walmart_ca', 'walmart_us'];
const rank = (key) => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);

const PIM_CHECKS = Object.fromEntries(CHECKS.map((c) => [c.key, { key: c.key, label: c.label, where: `${c.group} › ${c.section}`, tab: GROUPS[c.group]?.tab ?? null }]));
const channelChecks = new Map();
function checksOf(scope) {
  if (scope.kind === 'pim') return PIM_CHECKS;
  if (!channelChecks.has(scope.key)) channelChecks.set(scope.key, marketplaceChecks(scope.key));
  return channelChecks.get(scope.key);
}

/** A check's label and where it is fixed: { label, where, severity?, tab? }. */
export function checkInfo(scope, key) {
  const c = checksOf(scope)[key];
  if (!c) return { key, label: key, where: null };
  return scope.kind === 'pim' ? c : { key, label: c.label, where: c.category, severity: c.severity };
}

/**
 * What the section measures, in order: the PIM first, then every marketplace
 * the snapshots know. { id, kind: 'pim' | 'channel', label, noun, scope, key }
 * — `scope` / `key` address its rows in the snapshot index.
 */
export function progressScopes(index) {
  const out = [];
  if (index.has('pim|all')) out.push({ id: 'pim', kind: 'pim', label: 'PIM', noun: 'product', scope: 'pim', key: 'all' });
  const keys = [...index.keys()].filter((k) => k.startsWith('channel|')).map((k) => k.split('|')[1]);
  for (const key of keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    out.push({ id: key, kind: 'channel', label: MARKETPLACES[key]?.label ?? key, noun: 'listing', scope: 'channel', key });
  }
  return out;
}

const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// The share at 100%, rounded like the snapshots' own — and never 100% while a listing is left.
const share = (complete, total) => (total && complete != null ? Math.min(Math.round((complete / total) * 100), complete < total ? 99 : 100) : null);
// A marketplace's row carries the counts (at 100%, issues) since 2026-11-25.
const hasCounts = (row) => count(row?.metrics?.issues) != null && count(row?.metrics?.complete) != null;

/**
 * A scope's snapshot row as things stood at the end of `date`: the newest one
 * on or before it. A marketplace's row written without the counts — a day of
 * the cron before it learned them — gives way to the newest row of the six
 * days before it that has them, never one older than `from`.
 */
export function rowAt(index, scope, date, { from = null } = {}) {
  const list = index.get(`${scope.scope}|${scope.key}`) ?? [];
  const limit = toDateKey(date);
  let at = -1;
  for (let i = 0; i < list.length && list[i].snapshot_date <= limit; i++) at = i;
  if (at < 0) return null;
  const hit = list[at];
  if (scope.kind === 'pim' || hasCounts(hit)) return hit;
  const sixBefore = toDateKey(addDays(parseDateKey(hit.snapshot_date), -6));
  const floor = from && toDateKey(from) > sixBefore ? toDateKey(from) : sixBefore;
  for (let i = at - 1; i >= 0 && list[i].snapshot_date >= floor; i--) if (hasCounts(list[i])) return list[i];
  return hit;
}

/**
 * The numbers of one snapshot row: { date, total, complete, left, pct, avg,
 * bad, issues, byCheck, linked }. A number the row does not hold is null (a
 * marketplace's at 100% and issues before 2026-11-25).
 */
export function standingOf(scope, row) {
  if (!row) return null;
  const m = row.metrics ?? {};
  const total = count(m.total);
  let complete;
  let bad;
  let issues;
  let byCheck;
  if (scope.kind === 'pim') {
    complete = count(m.complete);
    byCheck = m.missing ?? {};
    issues = Object.values(byCheck).reduce((a, n) => a + (Number(n) || 0), 0);
    bad = m.scores ? Object.values(m.scores).filter((s) => s < BAD_UNDER).length : null;
  } else {
    complete = count(m.complete);
    byCheck = m.by_check ?? null;
    issues = count(m.issues);
    bad = m.distribution ? (m.distribution.needs_work ?? 0) + (m.distribution.critical ?? 0) : null;
  }
  return {
    date: row.snapshot_date,
    total,
    complete,
    left: total != null && complete != null ? total - complete : null,
    pct: share(complete, total),
    avg: count(m.avg),
    bad,
    issues,
    byCheck,
    linked: count(m.linked),
  };
}

/** now − before of one number; null when either is unknown. */
export function change(now, before, field) {
  const a = now?.[field];
  const b = before?.[field];
  return typeof a === 'number' && typeof b === 'number' ? a - b : null;
}

/**
 * A scope in the selected week: how it stood when the week ended (today, for
 * the week in progress) and right before it began.
 */
export function scopeInWeek(index, scope, week) {
  const nowRow = rowAt(index, scope, week.end);
  const beforeRow = rowAt(index, scope, new Date(week.start.getTime() - 1));
  return { scope, nowRow, beforeRow, now: standingOf(scope, nowRow), before: standingOf(scope, beforeRow) };
}

/**
 * One point per week, oldest first, for the last `weeks` weeks: how the scope
 * stood at the last snapshot of each week. A week without a snapshot of its
 * own has no standing (a flat line would read as "nothing moved").
 */
export function weeklyStandings(index, scope, weeks = 12, today = new Date()) {
  const start = weekStart(today);
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const s = addDays(start, -7 * i);
    const e = i === 0 ? today : addDays(s, 6);
    const row = rowAt(index, scope, e, { from: s });
    const inWeek = row && row.snapshot_date >= toDateKey(s);
    out.push({ week: s, key: toDateKey(s), label: weekTag(s), range: `${formatShort(s)} – ${formatShort(addDays(s, 6))}`, standing: inWeek ? standingOf(scope, row) : null });
  }
  return out;
}

const SUMMED = ['total', 'complete', 'left', 'bad', 'issues'];

/**
 * Several standings added up (every marketplace together). A number one of
 * them lacks is null in the sum: a total of some marketplaces would read as
 * the total of all.
 */
export function sumStandings(list) {
  if (!list.length || list.some((s) => !s)) return null;
  const out = { date: list.map((s) => s.date).sort().pop() };
  for (const f of SUMMED) out[f] = list.every((s) => typeof s[f] === 'number') ? list.reduce((a, s) => a + s[f], 0) : null;
  out.pct = share(out.complete, out.total);
  const scored = list.filter((s) => typeof s.avg === 'number' && s.total);
  out.avg = scored.length ? Math.round(scored.reduce((a, s) => a + s.avg * s.total, 0) / scored.reduce((a, s) => a + s.total, 0)) : null;
  return out;
}

/** The weekly points of several scopes added up, week by week. */
export function sumWeekly(seriesList) {
  if (!seriesList.length) return [];
  return seriesList[0].map((point, i) => ({ ...point, standing: sumStandings(seriesList.map((s) => s[i]?.standing ?? null)) }));
}

/** The checks listings fail most at `now`, each with its change since `before`: [{ key, label, where, count, delta }]. */
export function issuesByCheck(scope, now, before) {
  const a = now?.byCheck ?? {};
  const b = before?.byCheck ?? null;
  const keys = new Set([...Object.keys(a), ...Object.keys(b ?? {})]);
  return [...keys]
    .map((key) => ({ ...checkInfo(scope, key), count: a[key] ?? 0, delta: b ? (a[key] ?? 0) - (b[key] ?? 0) : null }))
    .filter((c) => c.count > 0 || c.delta)
    .sort((x, y) => y.count - x.count || x.label.localeCompare(y.label));
}

// ---- per listing ----

/**
 * The per-listing detail of a snapshot: Map(sku → { score, issues: [check
 * keys] }), or null when the row holds none. The PIM's catalog row and a
 * marketplace's detail row share the shape ({ scores, missing_skus }).
 */
export function listingsOf(detailRow) {
  const scores = detailRow?.metrics?.scores;
  if (!scores) return null;
  const out = new Map(Object.entries(scores).map(([sku, score]) => [sku, { score, issues: [] }]));
  for (const [key, skus] of Object.entries(detailRow.metrics.missing_skus ?? {})) {
    for (const sku of skus) out.get(sku)?.issues.push(key);
  }
  return out;
}

/**
 * Listing by listing, now against the start of the week.
 * @returns {{
 *   rows: { sku, score, before, issues: string[], fixed: string[], added: string[], isNew: boolean }[],
 *   reached: string[], dropped: string[], gone: string[],
 *   fixedByCheck: object, addedByCheck: object, fixed: number, added: number, hasBefore: boolean,
 * }}
 *   rows     every listing scored now, with what it fails, what it stopped
 *            failing since (`fixed`) and what it fails that it did not (`added`);
 *   reached  the listings at 100% now that were not;  dropped  the reverse;
 *   gone     the listings no longer scored (archived, obsolete, out of the
 *            marketplace's scope): their issues are not counted as fixed.
 */
export function compareListings(now, before) {
  const rows = [];
  const reached = [];
  const dropped = [];
  const fixedByCheck = {};
  const addedByCheck = {};
  let fixed = 0;
  let added = 0;
  for (const [sku, cur] of now ?? []) {
    const old = before?.get(sku) ?? null;
    const row = { sku, score: cur.score, before: old ? old.score : null, issues: cur.issues, fixed: [], added: [], isNew: !!before && !old };
    if (before) {
      const had = new Set(old?.issues ?? []);
      const has = new Set(cur.issues);
      row.fixed = [...had].filter((k) => !has.has(k));
      row.added = cur.issues.filter((k) => !had.has(k));
      for (const k of row.fixed) { fixedByCheck[k] = (fixedByCheck[k] ?? 0) + 1; fixed += 1; }
      for (const k of row.added) { addedByCheck[k] = (addedByCheck[k] ?? 0) + 1; added += 1; }
      if (old) {
        if (cur.issues.length === 0 && old.issues.length > 0) reached.push(sku);
        if (cur.issues.length > 0 && old.issues.length === 0) dropped.push(sku);
      }
    }
    rows.push(row);
  }
  const gone = before ? [...before.keys()].filter((sku) => !now?.has(sku)) : [];
  return { rows, reached, dropped, gone, fixedByCheck, addedByCheck, fixed, added, hasBefore: !!before };
}

/** The filters of the listings list, each with its test over a compared row. */
export const LISTING_FILTERS = [
  { key: 'left', label: 'Left to 100%', test: (r) => r.issues.length > 0 },
  { key: 'bad', label: `Bad (under ${BAD_UNDER})`, test: (r) => r.score < BAD_UNDER },
  { key: 'reached', label: 'Reached 100% this week', needsBefore: true, test: (r) => r.issues.length === 0 && r.before != null && r.fixed.length > 0 },
  { key: 'worse', label: 'Got worse this week', needsBefore: true, test: (r) => r.added.length > 0 && !r.isNew },
  { key: 'done', label: 'At 100%', test: (r) => r.issues.length === 0 },
];

/** "Left to 100%" lists the closest first (the quickest wins); "Bad" the worst first. */
export function sortListings(rows, order = 'closest') {
  const bySku = (a, b) => a.sku.localeCompare(b.sku);
  return [...rows].sort(order === 'worst'
    ? (a, b) => a.score - b.score || b.issues.length - a.issues.length || bySku(a, b)
    : (a, b) => b.score - a.score || a.issues.length - b.issues.length || bySku(a, b));
}
