import { supabase } from '@/lib/supabase';
import { onMarketList } from './promotions';

// Where one product is (user, 2026-11-19: "un filtro para buscar en qué
// promociones un SKU fue ingresado"): the promotions and the coupons whose
// list holds it. Read by Pricing's calendar; nothing is written.

const PAGE = 1000; // the API returns at most 1,000 rows a request

async function everyRow(read) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await read().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

/**
 * @returns {{ promotions: Map<string, { ca: boolean, us: boolean }>, coupons: Set<string>, off: Set<string> }}
 *   promotions  promotion id → the countries whose list the product is on
 *   coupons     the ids of the coupons that have it
 *   off         the marketplaces it is switched off for (the keys of its Excluded marketplaces switches)
 */
export async function loadSkuPromotions(sku) {
  const [product, prices, coupons] = await Promise.all([
    supabase.from('products').select('sku, channel_exclusions').eq('sku', sku).maybeSingle(),
    everyRow(() => supabase.from('promotion_prices').select('promotion_id, in_ca, in_us, promo_price_cad, promo_price_usd').eq('sku', sku).order('promotion_id')),
    everyRow(() => supabase.from('coupon_products').select('coupon_id').eq('sku', sku).order('coupon_id')),
  ]);
  if (product.error) throw product.error;
  const promotions = new Map();
  for (const row of prices) {
    const on = promotions.get(row.promotion_id) ?? { ca: false, us: false };
    promotions.set(row.promotion_id, { ca: on.ca || Boolean(onMarketList(row, 'ca')), us: on.us || Boolean(onMarketList(row, 'us')) });
  }
  return {
    promotions,
    coupons: new Set(coupons.map((r) => r.coupon_id)),
    off: new Set(product.data?.channel_exclusions ?? []),
  };
}
