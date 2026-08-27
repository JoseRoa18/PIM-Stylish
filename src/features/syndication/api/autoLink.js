import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { WIX_SITES } from '../lib/wixSites';

/**
 * Auto-link freshly created/imported products to every API-connected channel
 * (requirement 2026-08-20: "cada vez que un producto se suba, se vincula solo").
 *
 *  - Wix (4 sites): SKU-match link via the wix-import-products edge function
 *    in link-only mode — writes wix_links / the legacy CA column, NEVER
 *    writes anything to the Wix stores themselves.
 *  - Wayfair Canada: fetches the item-group id for these SKUs and stores it
 *    on products.wayfair_item_group_id (wayfair-pull-groups, apply mode).
 *  - Best Buy / Walmart US: those channels have no per-product link — the
 *    PIM matches them by SKU against the latest snapshot, so presence is
 *    reported here as information only.
 *
 * Every step is idempotent and a no-op for products that don't exist on the
 * channel yet — a brand-new product simply links later (re-run any time from
 * the product's Marketplaces tab).
 */
export async function autoLinkChannels(skus) {
  const list = [skus].flat().filter(Boolean);
  if (!list.length) return null;

  const summary = { wix: {}, wayfair: 0, bestbuy: 0, walmart_us: 0, errors: [] };

  // --- Wix: one link-only run per site (matches by SKU, idempotent) --------
  await Promise.allSettled(
    Object.keys(WIX_SITES).map(async (site) => {
      try {
        const { data, error } = await supabase.functions.invoke('wix-import-products', {
          body: { dryRun: false, site },
        });
        if (error) throw new Error(error.message);
        if (data?.error) throw new Error(data.error);
      } catch (err) {
        summary.errors.push(`${WIX_SITES[site].label}: ${err.message}`);
      }
    }),
  );
  // Which of OUR skus ended up linked, per site.
  const { data: links } = await supabase
    .from('wix_links')
    .select('site, sku')
    .in('sku', list);
  for (const l of links ?? []) summary.wix[l.site] = (summary.wix[l.site] ?? 0) + 1;

  // --- Wayfair Canada: store the listing's item-group id when it exists ----
  try {
    const { data, error } = await supabase.functions.invoke('wayfair-pull-groups', {
      body: { skus: list, apply: true, supplier: 'CAN' },
    });
    if (error) throw new Error(error.message);
    summary.wayfair = data?.updates?.length ?? data?.applied ?? 0;
  } catch (err) {
    summary.errors.push(`Wayfair: ${err.message}`);
  }

  // --- Snapshot-only channels: report presence, write nothing --------------
  for (const channel of ['bestbuy', 'walmart_us']) {
    try {
      const { data } = await supabase
        .from('channel_health')
        .select('results')
        .eq('channel', channel)
        .order('run_at', { ascending: false })
        .limit(1);
      const listed = new Set((data?.[0]?.results ?? []).map((r) => r.sku));
      summary[channel] = list.filter((s) => listed.has(s)).length;
    } catch {
      // informational only — never block the link run on a snapshot read
    }
  }

  const wixTotal = Object.values(summary.wix).reduce((a, b) => a + b, 0);
  logActivity({
    action: 'update',
    entityType: 'product',
    entityId: list.length === 1 ? list[0] : `${list.length} products`,
    target: 'channels',
    summary:
      `Auto-linked ${list.length === 1 ? list[0] : `${list.length} products`} across channels — ` +
      `Wix links: ${wixTotal}, Wayfair: ${summary.wayfair}` +
      (summary.errors.length ? ` · ${summary.errors.length} channel error(s)` : ''),
    metadata: { skus: list.slice(0, 50), ...summary },
  });
  return summary;
}
