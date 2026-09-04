// Drill-down behind every headline number: the audit rows or snapshot
// entries that produced it, grouped by product so a reader can answer
// "which products, where, by whom, when".
import { ACTIVITY_KINDS } from '../api/kpi';
import { latestSnapshot, snapshotAt } from './weekly';

const SITE_LABEL = {
  sinksdirect_ca: 'Sinks Direct Canada',
  sinksdirect_us: 'Sinks Direct USA',
  stylish_ca: 'Stylish Canada',
  stylish_us: 'Stylish USA',
};
const TARGET_LABEL = { wix: 'Wix', wayfair: 'Wayfair', bestbuy: 'Best Buy', walmart_us: 'Walmart US', amazon: 'Amazon', pim: 'PIM', channels: 'Channels', supabase: 'PIM', media: 'PIM', automation: 'Promo automation' };

/** Where a push went, from its audit row (site in metadata beats the generic target). */
export function pushDestination(r) {
  const site = r.metadata?.site;
  if (site && SITE_LABEL[site]) return SITE_LABEL[site];
  if (r.metadata?.results && typeof r.metadata.results === 'object') {
    const sites = Object.keys(r.metadata.results).map((s) => SITE_LABEL[s] ?? s);
    if (sites.length) return sites.join(', ');
  }
  if (r.metadata?.supplier && r.target === 'wayfair') return `Wayfair ${r.metadata.supplier}`;
  return TARGET_LABEL[r.target] ?? r.target ?? '—';
}

/**
 * Activity detail for one kind ('pushes' | 'edits' | 'uploads' | 'creates' |
 * 'touched') or one person, over the given rows. Returns products with their
 * events, newest first.
 */
export function activityDetail(rows, { kind = null, actor = null, names = new Map() } = {}) {
  const test = kind && kind !== 'touched' ? ACTIVITY_KINDS[kind] : (r) => Object.values(ACTIVITY_KINDS).some((t) => t(r));
  const hits = rows.filter((r) => test(r) && (!actor || r.actor_email === actor) && (kind !== 'touched' || r.entity_type === 'product'));
  const byProduct = new Map();
  for (const r of hits) {
    const key = r.entity_type === 'product' ? r.entity_id : (r.entity_id ?? '—');
    if (!byProduct.has(key)) byProduct.set(key, { sku: key, name: names.get(key) ?? null, events: [], count: 0, destinations: new Set(), actors: new Set() });
    const g = byProduct.get(key);
    const isPush = r.action === 'push';
    const n = r.action === 'media' ? Number(r.metadata?.count ?? 1) || 1 : 1;
    g.count += n;
    if (isPush) g.destinations.add(pushDestination(r));
    if (r.actor_email) g.actors.add(r.actor_email);
    g.events.push({ at: r.occurred_at, actor: r.actor_name || r.actor_email || 'system', summary: r.summary, destination: isPush ? pushDestination(r) : null, count: n });
  }
  const products = [...byProduct.values()]
    .map((g) => ({ ...g, destinations: [...g.destinations], actors: [...g.actors], events: g.events.sort((a, b) => b.at.localeCompare(a.at)), last: g.events[0]?.at ?? null }))
    .sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''));
  const byDestination = {};
  for (const r of hits) if (r.action === 'push') { const d = pushDestination(r); byDestination[d] = (byDestination[d] ?? 0) + 1; }
  const byActor = {};
  for (const r of hits) { const a = r.actor_name || r.actor_email || 'system'; byActor[a] = (byActor[a] ?? 0) + (r.action === 'media' ? Number(r.metadata?.count ?? 1) || 1 : 1); }
  return { products, events: hits.length, byDestination, byActor };
}

/**
 * Completeness detail from the catalog snapshots: which products reached
 * 100% since the week started, which dropped below it, and every product
 * currently at 100%.
 */
export function completenessDetail(index, week, names = new Map()) {
  const now = latestSnapshot(index, 'pim', 'all');
  const before = snapshotAt(index, 'pim', 'all', new Date(week.start.getTime() - 1));
  const s = now?.metrics?.scores ?? {};
  const b = before?.metrics?.scores ?? null;
  const row = (sku) => ({ sku, name: names.get(sku) ?? null, score: s[sku], before: b ? b[sku] ?? null : null });
  const all = Object.keys(s).filter((k) => s[k] === 100).sort().map(row);
  const reached = b ? Object.keys(s).filter((k) => s[k] === 100 && (b[k] ?? 0) < 100).sort().map(row) : [];
  const dropped = b ? Object.keys(b).filter((k) => b[k] === 100 && (s[k] ?? 0) < 100).sort().map(row) : [];
  const movers = b
    ? Object.keys(s).map(row).filter((r) => r.before != null && r.score !== r.before).sort((x, y) => Math.abs(y.score - y.before) - Math.abs(x.score - x.before)).slice(0, 40)
    : [];
  return { all, reached, dropped, movers, hasBefore: !!b };
}
