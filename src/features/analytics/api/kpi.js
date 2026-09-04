import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { scoreCompleteness, snapshotMetrics } from '@/features/products/lib/completeness';
import { computeListingHealth } from '@/features/dashboard/api/listingHealthData';
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
    return { sku: p.sku, category: p.category, result: scoreCompleteness(product, media ?? []) };
  });
  const rows = snapshotMetrics(scored, today);

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
 * Team activity for a period, straight from the audit log: product edits,
 * media uploads, pushes and new products, by person.
 */
export async function loadActivity(start, end) {
  const { data, error } = await supabase
    .from('audit_log')
    .select('occurred_at, actor_email, actor_name, action, target, entity_type, entity_id, metadata')
    .gte('occurred_at', new Date(start).toISOString())
    .lte('occurred_at', new Date(end).toISOString())
    .limit(5000);
  if (error) throw error;
  const rows = data ?? [];
  const kinds = {
    edits: (r) => r.action === 'update' && r.entity_type === 'product' && (r.target === 'pim' || r.target === 'channels'),
    creates: (r) => r.action === 'create' && r.entity_type === 'product' && r.target === 'pim',
    uploads: (r) => r.action === 'media' && ['pim', 'supabase', 'media'].includes(r.target ?? '') && /Uploaded/i.test(r.summary ?? '') || (r.action === 'media' && r.metadata?.count),
    pushes: (r) => r.action === 'push' && r.entity_type === 'product',
  };
  const empty = () => ({ edits: 0, creates: 0, uploads: 0, pushes: 0, products: new Set() });
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
    .map((p) => ({ ...p, touched: p.products.size, total: p.edits + p.creates + p.uploads + p.pushes }))
    .filter((p) => p.total > 0)
    .sort((a, b) => b.total - a.total);
  return { people, totals: { ...totals, touched: totals.products.size }, pushesByTarget, events: rows.length };
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
