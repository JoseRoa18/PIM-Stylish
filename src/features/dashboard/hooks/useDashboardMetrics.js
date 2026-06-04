import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * Pulls all data needed for the Dashboard in a single round-trip,
 * then derives metric cards client-side. With ~50–500 products this
 * is faster than 4 separate aggregate queries.
 */
export function useDashboardMetrics() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const { data: products, error: prodErr } = await supabase
          .from('products')
          .select(`
            sku,
            model_name,
            brand,
            category,
            series,
            workflow_status,
            msrp_cad,
            wix_product_id,
            wix_synced_at,
            sample_available_date,
            ready_to_sell_date,
            launch_lead,
            created_at
          `);
        if (prodErr) throw prodErr;

        const today = new Date();
        const sevenDaysAgo = new Date(today);
        sevenDaysAgo.setDate(today.getDate() - 7);
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(today.getDate() - 30);
        const thirtyDaysAhead = new Date(today);
        thirtyDaysAhead.setDate(today.getDate() + 30);

        const list = products ?? [];

        // ---- Catalog Snapshot ----
        const byStatus = {};
        const byCategory = {};
        const byBrand = {};
        let totalValue = 0;
        let valueCount = 0;

        for (const p of list) {
          const status = p.workflow_status || 'unknown';
          byStatus[status] = (byStatus[status] ?? 0) + 1;

          const cat = p.category || 'uncategorized';
          byCategory[cat] = (byCategory[cat] ?? 0) + 1;

          if (p.brand) byBrand[p.brand] = (byBrand[p.brand] ?? 0) + 1;

          if (typeof p.msrp_cad === 'number' && p.msrp_cad > 0) {
            totalValue += p.msrp_cad;
            valueCount++;
          }
        }

        const topBrands = Object.entries(byBrand)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name, count]) => ({ name, count }));

        // ---- Marketplace Sync ----
        const linkedCount = list.filter((p) => p.wix_product_id).length;
        const unlinkedCount = list.length - linkedCount;

        let lastPush = null;
        let pushesThisWeek = 0;
        for (const p of list) {
          if (!p.wix_synced_at) continue;
          const t = new Date(p.wix_synced_at);
          if (!lastPush || t > lastPush) lastPush = t;
          if (t >= sevenDaysAgo) pushesThisWeek++;
        }

        // ---- Recent Activity (latest created + latest pushed) ----
        const recentCreated = [...list]
          .filter((p) => p.created_at)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 5);

        const recentPushed = [...list]
          .filter((p) => p.wix_synced_at)
          .sort((a, b) => new Date(b.wix_synced_at) - new Date(a.wix_synced_at))
          .slice(0, 5);

        // ---- Launch Pipeline ----
        const upcomingLaunches = list.filter((p) => {
          if (!p.ready_to_sell_date) return false;
          const d = new Date(p.ready_to_sell_date);
          return d >= today && d <= thirtyDaysAhead && p.workflow_status !== 'ready_to_sell';
        }).sort((a, b) => new Date(a.ready_to_sell_date) - new Date(b.ready_to_sell_date));

        const overdueLaunches = list.filter((p) => {
          if (!p.ready_to_sell_date) return false;
          const d = new Date(p.ready_to_sell_date);
          return d < today && p.workflow_status !== 'ready_to_sell' && p.workflow_status !== 'archived';
        });

        const stalled = list.filter((p) => {
          if (!p.created_at) return false;
          const created = new Date(p.created_at);
          return created < thirtyDaysAgo && p.workflow_status === 'new';
        });

        if (active) {
          setData({
            total: list.length,
            byStatus,
            byCategory,
            topBrands,
            avgPrice: valueCount > 0 ? totalValue / valueCount : 0,
            totalValue,
            linkedCount,
            unlinkedCount,
            lastPush,
            pushesThisWeek,
            recentCreated,
            recentPushed,
            upcomingLaunches,
            overdueLaunches,
            stalled,
          });
          setLoading(false);
        }
      } catch (err) {
        if (active) {
          setError(err);
          setLoading(false);
        }
      }
    })();

    return () => { active = false; };
  }, []);

  return { data, loading, error };
}
