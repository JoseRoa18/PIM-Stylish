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
