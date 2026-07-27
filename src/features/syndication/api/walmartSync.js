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
 * Pull the seller's Walmart items and persist a channel_health snapshot
 * (read-only against Walmart; the snapshot lives in our own DB).
 *
 * market 'us': full item list (published/lifecycle/price USD — price is
 * stored for display but never scored against msrp_cad).
 * market 'ca': Walmart's item APIs don't serve the CA catalog; presence
 * comes from the latest MP_INVENTORY feed detail (SKU + ingestion status).
 */
export async function refreshWalmartItems(market = 'us') {
  const { total, items } = await invokeWalmart(market === 'ca' ? { market: 'ca' } : {});

  const isCa = market === 'ca';
  const okCount = isCa
    ? items.filter((i) => i.feedStatus === 'SUCCESS').length
    : items.filter((i) => i.published === 'PUBLISHED').length;

  await supabase.from('channel_health').insert({
    channel: isCa ? 'walmart_ca' : 'walmart_us',
    target: 'marketplace.walmartapis.com',
    total,
    in_sync: okCount,
    with_diffs: total - okCount,
    errors: 0,
    partial: false,
    results: items,
  });

  return { total, okCount };
}
