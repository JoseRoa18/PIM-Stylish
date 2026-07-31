import { supabase } from '@/lib/supabase';

// Best Buy Canada (Mirakl) — READ-ONLY integration. The edge function only
// GETs the seller's offers; nothing is written to Best Buy, and PRICES in
// particular are never pushed (explicit user rule, 2026-07-31).

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
