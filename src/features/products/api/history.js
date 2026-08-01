import { supabase } from '@/lib/supabase';

/**
 * Field-level change history for one product, newest first. Rows are written
 * by the products_log_changes trigger (see 20260801_product_history.sql) —
 * one per changed column, with the actor from the request JWT.
 */
export async function listProductHistory(sku, { limit = 300 } = {}) {
  const { data, error } = await supabase
    .from('product_history')
    .select('*')
    .eq('sku', sku)
    .order('changed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

// Consecutive rows by the same actor within this window collapse into one
// visual change set (a single Save writes many rows in the same instant).
const GROUP_WINDOW_MS = 90 * 1000;

export function groupHistory(rows) {
  const groups = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    const t = new Date(row.changed_at).getTime();
    if (
      last &&
      last.actorKey === (row.actor_id ?? row.actor_email ?? 'system') &&
      last.time - t < GROUP_WINDOW_MS
    ) {
      last.rows.push(row);
    } else {
      groups.push({
        actorKey: row.actor_id ?? row.actor_email ?? 'system',
        actorEmail: row.actor_email,
        time: t,
        changedAt: row.changed_at,
        rows: [row],
      });
    }
  }
  return groups;
}
