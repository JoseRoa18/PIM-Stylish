import { supabase } from '@/lib/supabase';

// Walmart US Marketplace — STRICTLY READ-ONLY integration. The edge function
// only GETs the seller's items; nothing is ever written to Walmart from
// the PIM.

async function invokeWalmart(body = {}) {
  const { data, error } = await supabase.functions.invoke('walmart-pull-items', { body });
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

/**
 * Pull the seller's Walmart US items and persist a channel_health snapshot
 * (read-only against Walmart; the snapshot lives in our own DB).
 * NOTE: Walmart US prices are USD — the PIM only has CAD MSRPs, so price
 * is stored for display but never scored against msrp_cad.
 */
export async function refreshWalmartItems() {
  const { total, items } = await invokeWalmart();

  const published = items.filter((i) => i.published === 'PUBLISHED').length;
  const unpublished = items.filter((i) => i.published !== 'PUBLISHED').length;

  await supabase.from('channel_health').insert({
    channel: 'walmart_us',
    target: 'marketplace.walmartapis.com',
    total,
    in_sync: published,
    with_diffs: unpublished,
    errors: 0,
    partial: false,
    results: items,
  });

  return { total, published, unpublished };
}
