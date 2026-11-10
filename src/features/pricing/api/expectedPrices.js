// Expected prices per marketplace, read live from the PIM: the regular price
// field and the market's running promotion (monthly, or a flash deal / special
// event on that marketplace). Shared by Price Alignment and the Amazon update
// listing (moved out of priceAlignment.js, 2026-10-14, so an exporter does not
// load the Wix / Best Buy / Walmart sync modules).
import { supabase } from '@/lib/supabase';
import { createPriceAlignment } from '../../../../supabase/functions/_shared/priceAlignmentReport.js';

// Reads shared by the targets of one Price Alignment view (performance pass
// 2026-09-29): the page loads all eight targets at once and each one used to
// read the products table and the active promotions again (~30 queries). A
// read is shared for a few seconds; a manual pull drops its channel's
// snapshot first, so a refreshed report is always read fresh.
const SHARED_TTL_MS = 10000;
const shared = new Map(); // key → { at, promise }
// A manual pull drops its channel's snapshot so the next read is fresh.
export const dropShared = (key) => shared.delete(key);
export function sharedLoad(key, loader) {
  const hit = shared.get(key);
  if (hit && Date.now() - hit.at < SHARED_TTL_MS) return hit.promise;
  const promise = loader();
  shared.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (shared.get(key)?.promise === promise) shared.delete(key); });
  return promise;
}

// The report code itself is shared with the server (_shared/priceAlignmentReport.js).
export const { loadExpectedPrices, loadPriceChangeDays, latestReport, dropPageReadings } = createPriceAlignment({ db: supabase, sharedLoad });

/**
 * The same expected prices for a marketplace that has no alignment target
 * (Amazon's update listing, 2026-10-14): `{ priceField, market, promoChannel }`
 * → { baseBySku, promoBySku } (promo = { price, windowStart, windowEnd, kind }).
 */
export function expectedPricesFor({ priceField, market, promoChannel }) {
  return loadExpectedPrices({ priceField, market, promoChannel, promoAware: true });
}
