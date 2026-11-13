import { supabase } from '@/lib/supabase';

/**
 * Flash deals, MK events and peak season events on the marketplaces the PIM is
 * connected to — Best Buy Canada, Walmart Canada, Walmart USA (user,
 * 2026-11-13: "Haz que se haga eso con todos los que tengamos conexión").
 *
 * The edge function channel-deals (cron every 10 minutes) puts a deal's price
 * on each of them the day it starts and takes it back when it ends: on Best
 * Buy as the offer's discount, on Walmart as a promotion for the deal's days.
 * Table channel_deal_prices holds what it put where; this module only reads it.
 */

/** The portal keys the automation covers (also the keys of its switches in Settings). */
export const DEAL_API_CHANNELS = ['bestbuy', 'walmart_ca', 'walmart_us'];

/** A flash deal, MK event or peak season event with Best Buy or a Walmart among its portals. */
export const goesToApiChannels = (promo) =>
  (promo?.kind ?? 'monthly') !== 'monthly' && (promo?.marketplaces ?? []).some((key) => DEAL_API_CHANNELS.includes(key));

/**
 * What a deal has on each of those marketplaces now:
 * { bestbuy: { live, failed, pending }, walmart_ca: …, walmart_us: … } —
 * live = its price is there (sent and seen, or the product already sold at
 * it); failed = the marketplace refused it (tried again later); pending = sent,
 * not seen there yet.
 */
export async function channelDealsLive(promotionId) {
  const { data, error } = await supabase
    .from('channel_deal_prices')
    .select('channel, confirmed, attempts')
    .eq('promotion_id', promotionId);
  if (error) throw error;
  const out = {};
  for (const r of data ?? []) {
    out[r.channel] = out[r.channel] ?? { live: 0, failed: 0, pending: 0 };
    out[r.channel][r.confirmed ? 'live' : r.attempts > 1 ? 'failed' : 'pending'] += 1;
  }
  return out;
}
