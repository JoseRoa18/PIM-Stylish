import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { BOARD_BY_KEY, MARKET_LABEL } from '../lib/boards';
import { formatValue } from '../lib/format';
import { weekTag } from '../lib/weeks';

// EOS ScoreCard data (tables scorecard_metrics / scorecard_values,
// 20261103_eos_scorecard.sql). RLS decides who writes: admins everything,
// a measurable's owner its values, any editor the PIM-filled ('auto') ones.

const METRIC_COLUMNS = 'id, board, market, section, name, source, owner_id, owner_name, unit, goal, goal_op, auto_key, position, archived, owner:profiles(full_name, email)';

export async function listMetrics(board) {
  const { data, error } = await supabase
    .from('scorecard_metrics')
    .select(METRIC_COLUMNS)
    .eq('board', board)
    .eq('archived', false)
    .order('position')
    .order('created_at');
  if (error) throw error;
  return (data ?? []).map(withOwnerLabel);
}

function withOwnerLabel(m) {
  return { ...m, owner_label: m.owner?.full_name || m.owner?.email || m.owner_name || null };
}

/**
 * Values of `metricIds` from `fromWeek` to `toWeek` (Sundays), keyed
 * `${metric_id}|${week_start}`. Batched by measurable so no read reaches the
 * API's 1,000-row cap (Amazon alone has ~80 measurables × 13 weeks).
 */
export async function listValues(metricIds, fromWeek, toWeek) {
  const out = new Map();
  for (let i = 0; i < metricIds.length; i += 40) {
    const { data, error } = await supabase
      .from('scorecard_values')
      .select('metric_id, week_start, value, note, origin, updated_at')
      .in('metric_id', metricIds.slice(i, i + 40))
      .gte('week_start', fromWeek)
      .lte('week_start', toWeek);
    if (error) throw error;
    for (const v of data ?? []) out.set(`${v.metric_id}|${v.week_start}`, v);
  }
  return out;
}

const metricWhere = (m) => `${BOARD_BY_KEY[m.board]?.label ?? m.board} · ${m.name}${m.market ? ` (${MARKET_LABEL[m.market]})` : ''}`;

/** Store one week's value (typed by a person). `parsed` = parseInput() result, null clears the week. */
export async function saveValue(metric, week, parsed) {
  if (!parsed) {
    const { error } = await supabase.from('scorecard_values').delete().eq('metric_id', metric.id).eq('week_start', week);
    if (error) throw error;
    logActivity({ action: 'delete', entityType: 'scorecard', entityId: metric.id, summary: `EOS ScoreCard · ${metricWhere(metric)} ${weekTag(week)}: cleared`, metadata: { week } });
    return null;
  }
  const row = { metric_id: metric.id, week_start: week, value: parsed.value, note: parsed.note, origin: 'manual' };
  const { data, error } = await supabase
    .from('scorecard_values')
    .upsert(row, { onConflict: 'metric_id,week_start' })
    .select('metric_id, week_start, value, note, origin, updated_at')
    .single();
  if (error) throw error;
  logActivity({ action: 'update', entityType: 'scorecard', entityId: metric.id, summary: `EOS ScoreCard · ${metricWhere(metric)} ${weekTag(week)}: ${formatValue(metric.unit, data)}`, metadata: { week, value: data.value, note: data.note } });
  return data;
}

/**
 * The server-side numbers of a board (Odoo orders, stock, Activity Log) worked
 * out again now by the scorecard-fill edge function; the daily cron does the same.
 */
export async function refreshServerNumbers(board) {
  const { data, error } = await supabase.functions.invoke('scorecard-fill', { body: { mode: 'fill', boards: [board] } });
  if (error) {
    let message = error.message;
    try { message = (await error.context?.json())?.error ?? message; } catch { /* keep the generic message */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/** PIM-measured values for one week of the PIM's rows (RLS: only on rows with an auto_key, origin 'auto'). */
export async function saveAutoValues(week, entries) {
  if (!entries.length) return [];
  const rows = entries.map(({ metricId, value }) => ({ metric_id: metricId, week_start: week, value, note: null, origin: 'auto' }));
  const { data, error } = await supabase
    .from('scorecard_values')
    .upsert(rows, { onConflict: 'metric_id,week_start' })
    .select('metric_id, week_start, value, note, origin, updated_at');
  if (error) throw error;
  return data ?? [];
}

const EDITABLE = ['name', 'market', 'section', 'source', 'owner_id', 'owner_name', 'unit', 'goal', 'goal_op', 'auto_key'];
const pick = (o) => Object.fromEntries(EDITABLE.filter((k) => k in o).map((k) => [k, o[k] === '' ? null : o[k]]));

export async function createMetric(board, fields) {
  const { data: last } = await supabase.from('scorecard_metrics').select('position').eq('board', board).order('position', { ascending: false }).limit(1);
  const { data, error } = await supabase
    .from('scorecard_metrics')
    .insert({ board, position: (last?.[0]?.position ?? 0) + 1, ...pick(fields) })
    .select(METRIC_COLUMNS)
    .single();
  if (error) throw error;
  logActivity({ action: 'create', entityType: 'scorecard', entityId: data.id, summary: `EOS ScoreCard · added ${metricWhere(data)}` });
  return withOwnerLabel(data);
}

export async function updateMetric(metric, fields) {
  const patch = pick(fields);
  const { data, error } = await supabase.from('scorecard_metrics').update(patch).eq('id', metric.id).select(METRIC_COLUMNS).single();
  if (error) throw error;
  const changed = Object.keys(patch).filter((k) => String(patch[k] ?? '') !== String(metric[k] ?? ''));
  logActivity({ action: 'update', entityType: 'scorecard', entityId: metric.id, summary: `EOS ScoreCard · edited ${metricWhere(data)}`, metadata: { changed } });
  return withOwnerLabel(data);
}

/** Archived measurables leave the board; their history stays in the table. */
export async function archiveMetric(metric) {
  const { error } = await supabase.from('scorecard_metrics').update({ archived: true }).eq('id', metric.id);
  if (error) throw error;
  logActivity({ action: 'delete', entityType: 'scorecard', entityId: metric.id, summary: `EOS ScoreCard · removed ${metricWhere(metric)}` });
}

/** The people a measurable can belong to. */
export async function listPeople() {
  const { data, error } = await supabase.from('profiles').select('id, full_name, email, role').order('full_name');
  if (error) throw error;
  return (data ?? []).filter((p) => p.full_name || p.email);
}
