import { supabase } from '@/lib/supabase';

/**
 * Audit trail — records WHO did WHAT, WHEN and WHERE.
 *
 * Capture is centralized in the `api/` modules (the only write paths), so each
 * call site is covered automatically. The actor is a module-level singleton set
 * once from AuthContext, so individual api functions don't need to thread the
 * user through every call.
 */

// Resolved from the signed-in session by AuthContext. `null` when logged out.
let currentActor = null;

/**
 * Tell the logger who is currently acting. Called by AuthContext whenever the
 * session/profile resolves or changes. Pass `null` on sign-out.
 */
export function setActivityActor(actor) {
  currentActor = actor; // { id, email, name } | null
}

/**
 * Record one activity event. Fire-and-forget: logging must NEVER break or slow
 * the primary action, so failures are swallowed (warned to the console only).
 *
 * @param {Object}  e
 * @param {string}  e.action      create|update|delete|push|export|import|media
 * @param {string}  e.entityType  product|media|user|template
 * @param {string} [e.entityId]   SKU, media id, user id, ...
 * @param {string} [e.target]     pim|wix|bbb  (the "where"); defaults to 'pim'
 * @param {string} [e.summary]    human-readable one-liner
 * @param {Object} [e.metadata]   changed keys, counts, dryRun, ...
 */
export async function logActivity({
  action,
  entityType,
  entityId = null,
  target = 'pim',
  summary = null,
  metadata = {},
}) {
  try {
    await supabase.from('audit_log').insert({
      actor_id: currentActor?.id ?? null,
      actor_email: currentActor?.email ?? null,
      actor_name: currentActor?.name ?? null,
      action,
      entity_type: entityType,
      entity_id: entityId,
      target,
      summary,
      metadata,
    });
  } catch (err) {
    // Audit logging is best-effort — never let it surface to the user.
    console.warn('activity_log insert failed:', err?.message ?? err);
  }
}

/**
 * Read one page of the audit log, newest-first. Uses PostgREST `range()` +
 * an exact count so the UI can paginate without ever fetching the whole table.
 *
 * @param {Object}  [opts]
 * @param {string}  [opts.actorId]     filter by user
 * @param {string}  [opts.action]      filter by action
 * @param {string}  [opts.target]      filter by site (pim|wix|bbb)
 * @param {string}  [opts.entityType]  filter by entity type
 * @param {string}  [opts.search]      substring match on entity_id / summary
 * @param {string}  [opts.since]       ISO timestamp lower bound (occurred_at >=)
 * @param {number}  [opts.page]        1-based page number (default 1)
 * @param {number}  [opts.pageSize]    rows per page (default 25)
 * @returns {Promise<{ events: Object[], count: number }>}
 */
export async function listActivity(opts = {}) {
  const { actorId, action, target, entityType, search, since, page = 1, pageSize = 25 } = opts;

  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;

  let query = supabase
    .from('audit_log')
    .select('*', { count: 'exact' })
    .order('occurred_at', { ascending: false })
    .range(from, to);

  if (actorId) query = query.eq('actor_id', actorId);
  if (action) query = query.eq('action', action);
  if (target) query = query.eq('target', target);
  if (entityType) query = query.eq('entity_type', entityType);
  if (since) query = query.gte('occurred_at', since);
  if (search?.trim()) {
    const safe = search.trim().replace(/[\\*,]/g, (c) => `\\${c}`);
    query = query.or(`entity_id.ilike.*${safe}*,summary.ilike.*${safe}*`);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return { events: data ?? [], count: count ?? 0 };
}
