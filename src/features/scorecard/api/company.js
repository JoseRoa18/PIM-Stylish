import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { COMPANY_AUTO_KEYS } from '../lib/company';
import { formatNumber } from '../lib/format';
import { weekTag } from '../lib/weeks';
import { listValues } from './scorecard';

// EOS ScoreCard · Company tab (20261111_scorecard_company.sql). It reads the
// marketplace tabs' own rows and keeps only its typed targets and the
// inventory snapshot, in scorecard_company_values — which the database lets
// only the tab's viewers read or write.

/** The emails that see the Company tab (app_settings 'scorecard_company_viewers'), lower case. */
export async function getCompanyViewers() {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'scorecard_company_viewers').maybeSingle();
  if (error) throw error;
  return (data?.value?.emails ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
}

/**
 * What the tab needs for the shown weeks: the marketplace rows it adds up,
 * their values, and its own numbers (every week up to the last shown, so a
 * target typed weeks ago is still in force).
 */
export async function loadCompany(weeks) {
  const { data: metrics, error } = await supabase
    .from('scorecard_metrics')
    .select('id, board, market, auto_key')
    .in('auto_key', COMPANY_AUTO_KEYS)
    .eq('archived', false);
  if (error) throw error;
  const [values, own] = await Promise.all([
    listValues((metrics ?? []).map((m) => m.id), weeks[0], weeks.at(-1)),
    listCompanyValues(weeks.at(-1)),
  ]);
  return { metrics: metrics ?? [], values, own };
}

async function listCompanyValues(lastWeek) {
  const out = [];
  // paged: the API returns at most 1,000 rows per request
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('scorecard_company_values')
      .select('key, week_start, value, origin, updated_at')
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

/** Store (or, with null, clear) one of the tab's typed numbers for a week. Returns the row, or null. */
export async function saveCompanyValue(key, label, week, value) {
  if (value == null) {
    const { error } = await supabase.from('scorecard_company_values').delete().eq('key', key).eq('week_start', week);
    if (error) throw error;
    logActivity({ action: 'delete', entityType: 'scorecard', entityId: key, summary: `EOS ScoreCard · Company · ${label} ${weekTag(week)}: cleared`, metadata: { week } });
    return null;
  }
  const { data, error } = await supabase
    .from('scorecard_company_values')
    .upsert({ key, week_start: week, value, origin: 'manual', updated_at: new Date().toISOString() }, { onConflict: 'key,week_start' })
    .select('key, week_start, value, origin, updated_at')
    .single();
  if (error) throw error;
  logActivity({ action: 'update', entityType: 'scorecard', entityId: key, summary: `EOS ScoreCard · Company · ${label} ${weekTag(week)}: ${formatNumber('money', data.value)}`, metadata: { week, value: data.value } });
  return data;
}
