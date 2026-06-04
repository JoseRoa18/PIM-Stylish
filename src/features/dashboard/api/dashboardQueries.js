import { supabase } from '@/lib/supabase';

/**
 * Returns aggregate counts for the dashboard StatCards.
 * - total: total products in the catalog
 * - pending: products with workflow_status = 'new' (awaiting review/enrichment)
 */
export async function fetchProductStats() {
  const [totalResult, pendingResult] = await Promise.all([
    supabase.from('products').select('sku', { count: 'exact', head: true }),
    supabase
      .from('products')
      .select('sku', { count: 'exact', head: true })
      .eq('workflow_status', 'new'),
  ]);

  if (totalResult.error) throw totalResult.error;
  if (pendingResult.error) throw pendingResult.error;

  return {
    total: totalResult.count ?? 0,
    pending: pendingResult.count ?? 0,
  };
}

/**
 * Returns the most recent activity entries with the actor (user) joined.
 */
export async function fetchRecentActivity({ limit = 5 } = {}) {
  const { data, error } = await supabase
    .from('activity_log')
    .select(`
      id,
      verb,
      target_sku,
      target_label,
      context,
      created_at,
      actor:users!actor_id (
        id,
        full_name,
        initials
      )
    `)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return data ?? [];
}