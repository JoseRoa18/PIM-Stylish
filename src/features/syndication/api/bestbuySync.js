import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

// Best Buy Canada (Mirakl).
// - Pulls (offers/stock/prices) are unrestricted reads.
// - The ONE write path is price sync (2026-07-31): pushing PIM MSRPs to
//   offers that already exist, per explicit SKU list, admin/editor only.
//   Nothing else is ever written (no offer create/delete, no stock).

async function invokeFn(name, body = {}) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let detail = error.message;
    try {
      if (error.context && typeof error.context.text === 'function') {
        const text = await error.context.text();
        try {
          detail = JSON.parse(text).error ?? text;
        } catch {
          detail = text || detail;
        }
      }
    } catch {
      // fall back to error.message
    }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

async function invokeBestBuy(body = {}) {
  return invokeFn('bestbuy-pull-offers', body);
}

/**
 * Pull the seller's Best Buy offers and persist a channel_health snapshot
 * (read-only against Best Buy; the snapshot lives in our own DB) so
 * Listing Health can score against it instantly.
 */
export async function refreshBestBuyOffers() {
  const { total, offers } = await invokeBestBuy();

  // Enrich the snapshot with PIM MSRPs so price mismatches are self-contained.
  const { data: prods, error } = await supabase.from('products').select('sku, msrp_cad');
  if (error) throw error;
  const msrpBySku = new Map((prods ?? []).map((p) => [p.sku, p.msrp_cad]));

  const results = offers.map((o) => ({
    ...o,
    msrp: msrpBySku.get(o.sku) ?? null,
  }));
  const priceMismatches = results.filter(
    (o) => o.msrp != null && o.price != null && Math.abs(o.price - o.msrp) > 0.01,
  ).length;

  await supabase.from('channel_health').insert({
    channel: 'bestbuy',
    target: 'marketplace.bestbuy.ca',
    total,
    in_sync: results.filter((o) => o.active).length,
    with_diffs: priceMismatches,
    errors: results.filter((o) => (o.quantity ?? 0) === 0).length,
    partial: false,
    results,
  });

  return { total, priceMismatches };
}

/**
 * Re-read the LIVE offers and return the price updates a push would send
 * ({ sku, from, to }). No write happens. Empty skus = every mismatch.
 */
export async function previewBestBuyPriceSync(skus) {
  return invokeFn('bestbuy-push-prices', { action: 'preview', skus });
}

/**
 * Push PIM MSRPs to the listed SKUs' live Best Buy offers (price only,
 * async Mirakl import). The function re-validates against the live offers,
 * so already-matching SKUs are skipped. Admin/editor only.
 */
export async function pushBestBuyPrices(skus) {
  const data = await invokeFn('bestbuy-push-prices', { action: 'push', skus });
  logActivity({
    action: 'push',
    entityType: 'product',
    target: 'bestbuy',
    summary: `Pushed ${data.updates?.length ?? 0} MSRP price${(data.updates?.length ?? 0) === 1 ? '' : 's'} to Best Buy`,
    metadata: { importId: data.importId, updates: data.updates },
  });
  return data;
}

/** Track the async Mirakl price import until it finishes applying. */
export async function getBestBuyImportStatus(importId) {
  return invokeFn('bestbuy-push-prices', { action: 'status', importId });
}
