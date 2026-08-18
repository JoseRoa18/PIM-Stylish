import { supabase } from '@/lib/supabase';

/**
 * App-wide settings (app_settings table): one jsonb value per key.
 * Reads are open to any authenticated user; writes are admin-only (RLS).
 * First consumer: 'promo_automation' — the monthly promo auto-apply switches.
 */

export async function getAppSetting(key, fallback = null) {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  return data?.value ?? fallback;
}

export async function saveAppSetting(key, value) {
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

/**
 * Trigger a promo-apply run right now (the same thing the month-start cron
 * does). Admin-only — the edge function checks the caller's role.
 */
export async function runPromoApplyNow({ dryRun = false } = {}) {
  const { data, error } = await supabase.functions.invoke('promo-apply', {
    body: { sync: true, dryRun },
  });
  if (error) throw new Error(error.message ?? 'promo-apply failed');
  return data;
}
