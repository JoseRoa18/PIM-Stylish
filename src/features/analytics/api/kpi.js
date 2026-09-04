import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { scoreCompleteness, snapshotMetrics } from '@/features/products/lib/completeness';
import { computeListingHealth } from '@/features/dashboard/api/listingHealthData';
import { loadLatestAlignment } from '@/features/pricing/api/priceAlignment';
import { WIX_SITES } from '@/features/syndication/lib/wixSites';
import { toDateKey, addDays } from '../lib/weekly';

/** Every snapshot row since `fromDate` (default: 16 weeks back). */
export async function loadSnapshots(fromDate = addDays(new Date(), -16 * 7)) {
  const { data, error } = await supabase
    .from('kpi_snapshots')
    .select('snapshot_date, scope, key, metrics, taken_at')
    .gte('snapshot_date', toDateKey(fromDate))
    .order('snapshot_date', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * Take today's snapshot from the browser: PIM completeness per category and
 * channel coverage — the same rows the daily cron writes. Upsert, so running
 * it twice a day just refreshes today's row.
 */
export async function takeSnapshot() {
  const today = toDateKey(new Date());
  const { data: products, error } = await supabase
    .from('products')
    .select('sku, category, workflow_status, *, product_media (id, media_type, is_primary, image_role, language, document_type)')
    .neq('workflow_status', 'archived');
  if (error) throw error;
  const scored = (products ?? []).map((p) => {
    const { product_media: media, ...product } = p;
    return { sku: p.sku, category: p.category, workflow_status: p.workflow_status, result: scoreCompleteness(product, media ?? []) };
  });
  const rows = snapshotMetrics(scored, today);

  // Price alignment per Wix site (latest saved report) and Wayfair spec sync.
  for (const site of Object.keys(WIX_SITES)) {
    try {
      const rep = await loadLatestAlignment(site);
      if (!rep) continue;
      const aligned = rep.counts.promo_ok + rep.counts.map_ok;
      const total = rep.total - rep.counts.no_map - rep.counts.missing;
      rows.push({ snapshot_date: today, scope: 'price', key: site, metrics: { total, aligned, pct: total ? Math.round((aligned / total) * 100) : 0 } });
    } catch { /* keep going */ }
  }
  try {
    const { data: wf } = await supabase.from('channel_health').select('total, in_sync, with_diffs, errors, run_at').eq('channel', 'wayfair').order('run_at', { ascending: false }).limit(1).maybeSingle();
    if (wf) {
      const checked = (wf.in_sync ?? 0) + (wf.with_diffs ?? 0);
      rows.push({ snapshot_date: today, scope: 'sync', key: 'wayfair', metrics: { total: wf.total, in_sync: wf.in_sync, with_diffs: wf.with_diffs, errors: wf.errors, pct: checked ? Math.round(((wf.in_sync ?? 0) / checked) * 100) : 0, audited_at: wf.run_at } });
    }
  } catch { /* no audit yet */ }

  // Channel coverage from the same pipeline the Listing Health tabs use.
  try {
    const { perMarketplaceData } = await computeListingHealth();
    for (const [mkt, d] of Object.entries(perMarketplaceData)) {
      rows.push({
        snapshot_date: today,
        scope: 'channel',
        key: mkt,
        metrics: { total: d.products.length, linked: d.linkedCount, avg: d.stats.avgScore, distribution: d.stats.distribution },
      });
    }
  } catch {
    // PIM rows still count; channel rows arrive with the next cron run.
  }

  const takenAt = new Date().toISOString();
  const { error: upErr } = await supabase
    .from('kpi_snapshots')
    .upsert(rows.map((r) => ({ ...r, taken_at: takenAt })), { onConflict: 'snapshot_date,scope,key' });
  if (upErr) throw upErr;
  logActivity({
    action: 'sync',
    entityType: 'catalog',
    entityId: 'kpi',
    target: 'pim',
    summary: `Took the KPI snapshot for ${today}`,
    metadata: { rows: rows.length },
  });
  return { date: today, rows: rows.length };
}

/**
 * Raw audit rows for a period (the team-activity source). Paged: the API
 * returns at most 1,000 rows per request, and twelve weeks of activity is
 * several thousand — a single request would silently drop the NEWEST weeks.
 */
export async function loadActivityRows(start, end) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('audit_log')
      .select('occurred_at, actor_email, actor_name, action, target, entity_type, entity_id, summary, metadata')
      .gte('occurred_at', new Date(start).toISOString())
      .lte('occurred_at', new Date(end).toISOString())
      .order('occurred_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/**
 * Team activity for a period, straight from the audit log: product edits,
 * media uploads, pushes and new products, by person.
 */
export async function loadActivity(start, end) {
  return aggregateActivity(await loadActivityRows(start, end));
}

// What counts as what, shared by the totals and the drill-down so a number
// and its detail can never disagree.
export const ACTIVITY_KINDS = {
  edits: (r) => r.action === 'update' && r.entity_type === 'product' && (r.target === 'pim' || r.target === 'channels'),
  creates: (r) => r.action === 'create' && r.entity_type === 'product' && r.target === 'pim',
  uploads: (r) => (r.action === 'media' && ['pim', 'supabase', 'media'].includes(r.target ?? '') && /Uploaded/i.test(r.summary ?? '')) || (r.action === 'media' && !!r.metadata?.count),
  pushes: (r) => r.action === 'push' && r.entity_type === 'product' && r.metadata?.env !== 'sandbox' && !/\(sandbox\)/i.test(r.summary ?? ''),
  // Sandbox pushes validate at the channel and change nothing live.
  tests: (r) => r.action === 'push' && r.entity_type === 'product' && (r.metadata?.env === 'sandbox' || /\(sandbox\)/i.test(r.summary ?? '')),
};

export function aggregateActivity(rows) {
  const kinds = ACTIVITY_KINDS;
  const empty = () => ({ edits: 0, creates: 0, uploads: 0, pushes: 0, tests: 0, products: new Set() });
  const byPerson = new Map();
  const totals = empty();
  const pushesByTarget = {};
  for (const r of rows) {
    const who = r.actor_email ?? 'system';
    if (!byPerson.has(who)) byPerson.set(who, { email: who, name: r.actor_name ?? null, ...empty() });
    const p = byPerson.get(who);
    for (const [k, test] of Object.entries(kinds)) {
      if (test(r)) {
        const n = k === 'uploads' ? Number(r.metadata?.count ?? 1) || 1 : 1;
        p[k] += n;
        totals[k] += n;
        if (r.entity_type === 'product' && r.entity_id) { p.products.add(r.entity_id); totals.products.add(r.entity_id); }
        if (k === 'pushes') pushesByTarget[r.target] = (pushesByTarget[r.target] ?? 0) + 1;
      }
    }
  }
  const people = [...byPerson.values()]
    .map((p) => ({ ...p, touched: p.products.size, total: p.edits + p.creates + p.uploads + p.pushes + p.tests }))
    .filter((p) => p.total > 0)
    .sort((a, b) => b.total - a.total);
  return { people, totals: { ...totals, touched: totals.products.size }, pushesByTarget, events: rows.length };
}

/** Active minutes on screen per person per day, with the person's email/name. */
export async function loadScreenTime(start, end) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('screen_time')
      .select('user_id, day, minutes')
      .gte('day', toDateKey(start))
      .lte('day', toDateKey(end))
      .order('day', { ascending: true })
      .order('user_id', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const ids = [...new Set(rows.map((r) => r.user_id))];
  const people = new Map();
  if (ids.length) {
    const { data: profiles } = await supabase.from('profiles').select('id, email, full_name').in('id', ids);
    for (const p of profiles ?? []) people.set(p.id, { email: p.email, name: p.full_name });
  }
  return rows.map((r) => ({ ...r, email: people.get(r.user_id)?.email ?? r.user_id, name: people.get(r.user_id)?.name ?? null }));
}

/** Launch funnel: workflow status now, plus creations and Ready-to-sell dates. */
export async function loadLaunches() {
  const { data, error } = await supabase
    .from('products')
    .select('sku, model_name, category, workflow_status, created_at, ready_to_sell_date')
    .neq('workflow_status', 'archived');
  if (error) throw error;
  return data ?? [];
}

/** Promotions: the current and next period with their execution stamps and SKU counts. */
export async function loadPromotions() {
  const { data: promos, error } = await supabase
    .from('promotions')
    .select('id, name, period, status, created_at, activated_at, ended_at, bb_scheduled_at, us_applied_at, ca_applied_at')
    .order('period', { ascending: false })
    .limit(6);
  if (error) throw error;
  const ids = (promos ?? []).map((p) => p.id);
  const counts = {};
  if (ids.length) {
    const { data: prices } = await supabase.from('promotion_prices').select('promotion_id').in('promotion_id', ids);
    for (const r of prices ?? []) counts[r.promotion_id] = (counts[r.promotion_id] ?? 0) + 1;
  }
  const { data: runs } = await supabase
    .from('audit_log')
    .select('occurred_at, summary, metadata, target')
    .eq('entity_type', 'promotion')
    .eq('action', 'push')
    .order('occurred_at', { ascending: false })
    .limit(12);
  return { promos: (promos ?? []).map((p) => ({ ...p, skus: counts[p.id] ?? 0 })), runs: runs ?? [] };
}

/** Targets per category: { global: {pct, date}, categories: { [cat]: {pct, date} } } */
export async function loadTargets() {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'kpi_targets').maybeSingle();
  if (error) throw error;
  return data?.value ?? { global: null, categories: {} };
}

export async function saveTargets(value) {
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key: 'kpi_targets', value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  logActivity({ action: 'update', entityType: 'settings', entityId: 'kpi_targets', target: 'pim', summary: 'Updated completeness targets', metadata: value });
}
