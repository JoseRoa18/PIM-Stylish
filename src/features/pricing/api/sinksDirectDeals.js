import { supabase } from '@/lib/supabase';

/**
 * Flash deals, MK events and peak season events on the Sinks Direct stores
 * (user, 2026-11-11: "que apenas se genere el deal … se suba dependiendo de la
 * fecha; si se pone la fecha de hoy, se envía de una vez").
 *
 * The edge function sinksdirect-deals puts a deal's price on the store the day
 * it starts and takes it back the day after it ends (cron every 5 minutes).
 * The Pricing page calls it right after a deal is created or changed, so a
 * deal that runs today is on the store at once.
 */

/** The portal keys of the Sinks Direct stores → the store's key in sinksdirect_deal_prices. */
export const SINKS_DIRECT_SITE_OF = { wix_sinksdirect_ca: 'sinksdirect_ca', wix_sinksdirect_us: 'sinksdirect_us' };
export const SINKS_DIRECT_CHANNELS = Object.keys(SINKS_DIRECT_SITE_OF);

/** A flash deal, MK event or peak season event with a Sinks Direct store among its portals. */
export const goesToSinksDirect = (promo) =>
  (promo?.kind ?? 'monthly') !== 'monthly' && (promo?.marketplaces ?? []).some((key) => SINKS_DIRECT_CHANNELS.includes(key));

// Cards showing what is on the stores read it again after a send.
const listeners = new Set();
export function onSinksDirectSent(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const MAX_ROUNDS = 12; // a run pushes for ~100 s at Wix's pace; the cron goes on after that
const BUSY_WAIT_MS = 15_000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(body = {}) {
  const { data, error } = await supabase.functions.invoke('sinksdirect-deals', { body });
  if (error) {
    let detail = error.message;
    try {
      const text = await error.context?.text?.();
      if (text) detail = JSON.parse(text).error ?? text;
    } catch {
      // keep error.message
    }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data ?? {};
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Put on the Sinks Direct stores what the deals say TODAY, now: the prices of
 * the deals that run today go up, those of a deal that is over (ended, deleted,
 * moved to other dates, a product taken off its list) go back to the monthly
 * promotion's price or the regular one. Calls the function until nothing is
 * owed — Wix lets about 30 changes through a minute — and says what happened in
 * `text`. `task` (optional taskProgress reporter) counts the prices.
 */
export async function sendSinksDirectDeals({ task = null } = {}) {
  let total = null;
  const sum = { set: 0, back: 0, failed: 0, owed: 0, errors: [], skipped: [] };
  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const r = await call();
      if (r.skipped) return { ...sum, off: true, text: `Sinks Direct: not sent — ${r.skipped}` };
      const planned = (r.to_set ?? 0) + (r.to_back ?? 0);
      if (total == null) total = planned;
      sum.set += r.set ?? 0;
      sum.back += r.back ?? 0;
      sum.failed += r.failed ?? 0;
      sum.errors.push(...(r.errors ?? []));
      sum.owed = r.owed ?? 0;
      sum.skipped = Object.values(r.sites ?? {}).flatMap((s) => s.skipped ?? []);
      if (!sum.owed) break;
      task?.count(Math.max(0, total - sum.owed), Math.max(total, 1), `Sinks Direct: ${Math.max(0, total - sum.owed)} of ${total} prices…`);
      // Another run (the cron) is sending them: look again in a moment.
      if (r.busy) await wait(BUSY_WAIT_MS);
    }
  } finally {
    for (const l of listeners) l();
  }
  task?.progress(1);

  const parts = [];
  if (sum.set) parts.push(`${plural(sum.set, 'price')} on the store`);
  if (sum.back) parts.push(`${plural(sum.back, 'product')} back at ${sum.back === 1 ? 'its' : 'their'} regular price`);
  // Another run (the cron) took them while this one waited.
  if (!sum.set && !sum.back && !sum.owed && total > sum.failed) parts.push(`${plural(total - sum.failed, 'price')} sent to the store`);
  if (sum.owed) parts.push(`${sum.owed} more go in the next minutes`);
  if (sum.failed) parts.push(`${sum.failed} refused by Wix (${sum.errors.slice(0, 3).map((e) => e.replace(/^Sinks Direct (Canada|USA) /, '')).join('; ')})`);
  const notOnStore = sum.skipped.filter((s) => s.reason === 'not on this store').map((s) => s.sku);
  if (notOnStore.length && (sum.set || sum.back)) parts.push(`not on the store: ${notOnStore.slice(0, 8).join(', ')}${notOnStore.length > 8 ? '…' : ''}`);
  return { ...sum, text: `Sinks Direct: ${parts.length ? parts.join(' · ') : 'nothing to change on the stores today'}` };
}

/**
 * What a deal has on each Sinks Direct store now:
 * { wix_sinksdirect_ca: { live, failed, pending }, … } — live = its price is
 * on the store; failed = Wix refused the product (tried again later);
 * pending = on its way.
 */
export async function sinksDirectLive(promotionId) {
  const { data, error } = await supabase
    .from('sinksdirect_deal_prices')
    .select('site, confirmed, attempts')
    .eq('promotion_id', promotionId);
  if (error) throw error;
  const out = {};
  for (const r of data ?? []) {
    const key = `wix_${r.site}`;
    out[key] = out[key] ?? { live: 0, failed: 0, pending: 0 };
    out[key][r.confirmed ? 'live' : r.attempts > 0 ? 'failed' : 'pending'] += 1;
  }
  return out;
}
