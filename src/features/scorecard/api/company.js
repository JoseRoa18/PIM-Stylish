import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { COMPANY_AUTO_KEYS } from '../lib/company';
import { targetText } from '../lib/format';
import { listValues } from './scorecard';

// EOS ScoreCard · Company tab (20261111_scorecard_company.sql). It reads the
// marketplace tabs' own rows and keeps only the inventory snapshot, in
// scorecard_company_values, and the targets of the rows it works out itself,
// in scorecard_company_targets (20261112_scorecard_company_targets.sql) —
// which the database lets only the tab's viewers read or write.

/** The emails that see the Company tab (app_settings 'scorecard_company_viewers'), lower case. */
export async function getCompanyViewers() {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'scorecard_company_viewers').maybeSingle();
  if (error) throw error;
  return (data?.value?.emails ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
}

/**
 * What the tab needs for the shown weeks: the marketplace rows it adds up
 * (with their own targets), their values, its own numbers (the inventory
 * snapshot) and the targets of the rows it works out.
 */
export async function loadCompany(weeks) {
  const { data: metrics, error } = await supabase
    .from('scorecard_metrics')
    .select('id, board, market, name, unit, auto_key, goal, goal_op')
    .in('auto_key', COMPANY_AUTO_KEYS)
    .eq('archived', false);
  if (error) throw error;
  const [values, own, targets] = await Promise.all([
    listValues((metrics ?? []).map((m) => m.id), weeks[0], weeks.at(-1)),
    listCompanyValues(weeks[0], weeks.at(-1)),
    listCompanyTargets(),
  ]);
  return { metrics: metrics ?? [], values, own, targets };
}

async function listCompanyTargets() {
  const { data, error } = await supabase.from('scorecard_company_targets').select('key, goal, goal_op, updated_at');
  if (error) throw error;
  return data ?? [];
}

/**
 * Set (or, with null, remove) the target of a row the tab works out itself.
 * `target` / `before` = { goal, goal_op } or null. Returns the row, or null.
 */
export async function saveCompanyTarget(key, label, unit, target, before = null) {
  const log = (now) => logActivity({
    action: now ? 'update' : 'delete',
    entityType: 'scorecard',
    entityId: key,
    summary: `EOS ScoreCard · Company · ${label} target: ${targetText(unit, now)} (it was ${targetText(unit, before)})`,
    metadata: { target: now, before },
  });
  if (!target) {
    const { error } = await supabase.from('scorecard_company_targets').delete().eq('key', key);
    if (error) throw error;
    log(null);
    return null;
  }
  const { data, error } = await supabase
    .from('scorecard_company_targets')
    .upsert({ key, goal: target.goal, goal_op: target.goal_op, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    .select('key, goal, goal_op, updated_at')
    .single();
  if (error) throw error;
  log({ goal: data.goal, goal_op: data.goal_op });
  return data;
}

async function listCompanyValues(firstWeek, lastWeek) {
  const out = [];
  // paged: the API returns at most 1,000 rows per request
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('scorecard_company_values')
      .select('key, week_start, value, origin, updated_at')
      .gte('week_start', firstWeek)
      .lte('week_start', lastWeek)
      .order('week_start')
      .order('key')
      .range(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}
