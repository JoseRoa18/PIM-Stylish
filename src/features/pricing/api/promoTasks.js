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

// ---- Saved files (user idea 2026-09-29) -------------------------------------
// The file a promotion hands to a portal when it starts (Menards' file, the
// Wayfair pricing file of the Promo MAP day) is kept in the private bucket
// promo-files, so its Back to Blue comes out with one click and exactly the
// products that went out. Kept 60 days (user rule): an older file is deleted
// and the person uploads it again — the task keeps its product list, so Back
// to Blue still carries only the promotion's products.
const BUCKET = 'promo-files';
export const PROMO_FILE_DAYS = 60;
const DAY_MS = 86400000;

/**
 * Keep the file of `task` ("<channel>:<task>"); replaces the one saved before
 * for the same task. Returns { file, file_name, saved_at } to merge into the
 * task entry, or {} when it could not be saved (the fill itself still stands).
 */
export async function savePromoFile(promotion, task, file) {
  try {
    const safe = String(file.name ?? 'file.xlsx').replace(/[^\w.-]+/g, '_').slice(-80);
    const path = `${promotion.id}/${task.replace(':', '/')}-${Date.now()}-${safe}`;
    const body = new Blob([await file.arrayBuffer()], { type: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const { error } = await supabase.storage.from(BUCKET).upload(path, body, { upsert: false });
    if (error) throw error;
    const previous = promotion.file_tasks?.[task]?.file;
    if (previous && previous !== path) await supabase.storage.from(BUCKET).remove([previous]).catch(() => {});
    return { file: path, file_name: file.name ?? safe, saved_at: new Date().toISOString() };
  } catch {
    return {};
  }
}

/** When a saved file goes away (a Date), or null when the entry has none. */
export function savedFileExpiry(entry) {
  if (!entry?.file || !entry.saved_at) return null;
  return new Date(new Date(entry.saved_at).getTime() + PROMO_FILE_DAYS * DAY_MS);
}

/** The saved file of a task entry, shaped like an uploaded File; null when there is none. */
export async function loadPromoFile(entry) {
  if (!entry?.file) return null;
  const { data, error } = await supabase.storage.from(BUCKET).download(entry.file);
  if (error) throw new Error(`The saved file could not be read (${error.message}) — upload it instead.`);
  return { name: entry.file_name ?? entry.file.split('/').pop(), type: data.type, arrayBuffer: () => data.arrayBuffer() };
}

/**
 * Delete the saved files older than 60 days among `promotions` (run whenever
 * they load). The entry keeps everything else — its products above all.
 */
export async function expirePromoFiles(promotions) {
  const now = Date.now();
  for (const p of promotions ?? []) {
    for (const [task, entry] of Object.entries(p.file_tasks ?? {})) {
      const expiry = savedFileExpiry(entry);
      if (!expiry || expiry.getTime() > now) continue;
      const { error } = await supabase.storage.from(BUCKET).remove([entry.file]);
      if (error) continue;
      const rest = { ...entry, file_expired_at: new Date().toISOString() };
      delete rest.file;
      await supabase.rpc('promotion_mark_task', { pid: p.id, task, info: rest });
    }
  }
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
