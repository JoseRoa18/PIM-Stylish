import { supabase } from '@/lib/supabase';
import { getActivityActor } from '@/features/activity/api/activityLog';

// File tasks of a promotion (promotions.file_tasks, see
// supabase/migrations/20260928_promotion_file_tasks.sql): what the owner of a
// file-based channel still has to hand to its portal. Kept apart from
// api/promotions so the app-wide reminder (PromoTaskNudge) stays out of the
// Pricing chunk.

export const TASK_EVENT = 'pim:promo-task';

/**
 * Mark one task done — "<channel>:<task>", e.g. "wayfair_us:price_change" —
 * when the PIM fills its file, or by hand ({ manual: true }). The reminder
 * re-checks right away.
 */
export async function markPromotionTask(promotionId, task, extra = {}) {
  const actor = getActivityActor();
  const info = { at: new Date().toISOString(), by: actor?.id ?? null, name: actor?.name || actor?.email || null, ...extra };
  const { data, error } = await supabase.rpc('promotion_mark_task', { pid: promotionId, task, info });
  if (error) throw error;
  window.dispatchEvent(new CustomEvent(TASK_EVENT, { detail: { promotionId, task } }));
  return data;
}

/** Promotions that can still owe a task: not ended, or ended in the last weeks. */
export async function listTaskPromotions() {
  const since = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('promotions')
    .select('id, name, kind, period, status, marketplaces, starts_on, ends_on, file_tasks')
    .or(`status.neq.ended,ends_on.gte.${since}`)
    .gte('period', since.slice(0, 8) + '01');
  if (error) throw error;
  return data ?? [];
}

/** People who can own a channel's tasks (admins and editors), by name. */
export async function listTaskOwners() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, email, role')
    .in('role', ['admin', 'editor'])
    .order('full_name');
  if (error) throw error;
  return (data ?? []).filter((p) => p.full_name || p.email);
}
