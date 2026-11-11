// What the promotion checks read (lib/promoChecks.js does the checking).
import { supabase } from '@/lib/supabase';
import { LEVEL_FIELDS } from './promotions';

const LEVEL_COLUMNS = Object.values(LEVEL_FIELDS).flatMap((level) => [level.promo_price_cad, level.promo_price_usd, ...Object.values(level.costs)]);
const COLUMNS = ['sku', 'brand', 'is_obsolete', 'channel_exclusions', 'map_cad', 'map_usd', ...LEVEL_COLUMNS].join(', ');

/**
 * sku → the fields the checks read: brand, the marketplaces it is switched off
 * for, the Blue MAP and every level's MAP and costs. 100 SKUs per request, in
 * parallel, so no read can reach the API's 1,000 rows.
 */
export async function loadCheckProducts(skus) {
  const list = [...new Set(skus)];
  const chunks = [];
  for (let i = 0; i < list.length; i += 100) chunks.push(list.slice(i, i + 100));
  const results = await Promise.all(chunks.map((part) => supabase.from('products').select(COLUMNS).in('sku', part)));
  const found = new Map();
  for (const { data, error } of results) {
    if (error) throw error;
    for (const p of data ?? []) found.set(p.sku, p);
  }
  return found;
}

/**
 * The other flash deals / events that run on a day of [startsOn, endsOn] on
 * one of `portals` and are not ended, each with its SKUs — to say that a
 * product is already in another deal on that portal those days.
 */
export async function overlappingDeals({ startsOn, endsOn, portals, exceptId = null }) {
  if (!startsOn || !endsOn || endsOn < startsOn || !portals?.length) return [];
  let query = supabase
    .from('promotions')
    .select('id, name, marketplaces, starts_on, ends_on, promotion_prices(sku)')
    .neq('kind', 'monthly')
    .neq('status', 'ended')
    .lte('starts_on', endsOn)
    .gte('ends_on', startsOn)
    .overlaps('marketplaces', portals);
  if (exceptId != null) query = query.neq('id', exceptId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((p) => ({ id: p.id, name: p.name, marketplaces: p.marketplaces ?? [], skus: new Set((p.promotion_prices ?? []).map((r) => r.sku)) }));
}
