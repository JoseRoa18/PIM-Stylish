import { supabase } from '@/lib/supabase';
import { logActivity, getActivityActor } from '@/features/activity/api/activityLog';
import { excludedSkus } from './promotions';

// Coupons on Amazon and Wayfair (user, 2026-11-09) and on the Sinks Direct
// stores (2026-11-13): a record kept in the PIM, by percentage or by money,
// each with its products. Nothing here reaches a marketplace or a store, or
// changes an expected price.

export async function listCoupons() {
  const { data, error } = await supabase
    .from('coupons')
    .select('id, name, marketplace, discount_type, discount_value, starts_on, ends_on, ended_at, created_at, coupon_products(count), creator:profiles(full_name, email)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((c) => ({
    ...c,
    sku_count: c.coupon_products?.[0]?.count ?? 0,
    created_by_name: c.creator?.full_name || c.creator?.email || null,
  }));
}

/** The coupon's products: [{ sku, discount_amount }] (money coupons carry the amount per product). */
export async function getCouponProducts(couponId) {
  const { data, error } = await supabase.from('coupon_products').select('sku, discount_amount').eq('coupon_id', couponId).order('sku');
  if (error) throw error;
  return data ?? [];
}

const sameCoupon = (c) => `${c.name.toLowerCase()}|${c.marketplace}|${c.starts_on}`;

/**
 * What can really be created from a list of coupons: each comes back with its
 * `skus` reduced to the PIM's products that are not switched off for that
 * marketplace, what was left out (`notInPim`, `excluded`) and `exists` when a
 * coupon of that name, marketplace and first day is already there. `overPrice`
 * (user, 2026-11-11 — a warning, the coupon can still be created): on a money
 * coupon, the products whose amount is as much as their regular MAP in the
 * marketplace's currency or more, [{ sku, amount, map }] — a price typed where
 * the amount goes.
 */
export async function reviewCoupons(list) {
  const all = [...new Set(list.flatMap((c) => c.skus))];
  const known = new Map(); // sku → { map_cad, map_usd }
  for (let i = 0; i < all.length; i += 200) {
    const { data, error } = await supabase.from('products').select('sku, map_cad, map_usd').in('sku', all.slice(i, i + 200));
    if (error) throw error;
    for (const p of data ?? []) known.set(p.sku, p);
  }
  const { data: existing, error } = await supabase.from('coupons').select('name, marketplace, starts_on').in('name', [...new Set(list.map((c) => c.name))]);
  if (error) throw error;
  const taken = new Set((existing ?? []).map(sameCoupon));
  return Promise.all(list.map(async (c) => {
    const inPim = c.skus.filter((s) => known.has(s));
    const off = inPim.length ? await excludedSkus(c.marketplace, inPim) : new Set();
    const skus = inPim.filter((s) => !off.has(s));
    const mapKey = c.marketplace.endsWith('_ca') ? 'map_cad' : 'map_usd';
    const overPrice = c.discount_type === 'amount'
      ? skus
        .map((sku) => ({ sku, amount: Number(c.amounts?.[sku]), map: known.get(sku)[mapKey] == null ? null : Number(known.get(sku)[mapKey]) }))
        .filter((r) => r.map != null && r.amount >= r.map)
      : [];
    return { ...c, skus, notInPim: c.skus.filter((s) => !known.has(s)), excluded: [...off].sort(), exists: taken.has(sameCoupon(c)), overPrice };
  }));
}

/** Creates the coupons of a reviewed list. `task` (optional) counts them. */
export async function createCoupons(reviewed, { task = null } = {}) {
  const list = reviewed.filter((c) => c.skus.length && !c.exists);
  if (!list.length) throw new Error('There is no coupon to create.');
  for (const [i, c] of list.entries()) {
    task?.count(i, list.length, `Coupon ${i + 1} of ${list.length} · ${c.name}`);
    const { data, error } = await supabase
      .from('coupons')
      .insert({ name: c.name, marketplace: c.marketplace, discount_type: c.discount_type, discount_value: c.discount_type === 'percent' ? c.discount_value : null, starts_on: c.starts_on, ends_on: c.ends_on, created_by: getActivityActor()?.id ?? null })
      .select('id')
      .single();
    if (error) throw error;
    for (let n = 0; n < c.skus.length; n += 200) {
      const { error: rowsError } = await supabase.from('coupon_products').insert(c.skus.slice(n, n + 200).map((sku) => ({ coupon_id: data.id, sku, discount_amount: c.amounts?.[sku] ?? null })));
      if (rowsError) throw rowsError;
    }
  }
  task?.progress(1);
  logActivity({
    action: 'create',
    entityType: 'promotion',
    entityId: 'coupons',
    summary: `Created ${list.length} coupon${list.length === 1 ? '' : 's'}: ${list.map((c) => c.name).slice(0, 5).join(', ')}${list.length > 5 ? '…' : ''}`,
    metadata: { coupons: list.map((c) => ({ name: c.name, marketplace: c.marketplace, type: c.discount_type, value: c.discount_value, starts_on: c.starts_on, ends_on: c.ends_on, skus: c.skus.length })) },
  });
  return list.length;
}

/** Over before its last day (the marketplace's coupon was stopped). */
export async function endCoupon(coupon) {
  const { error } = await supabase.from('coupons').update({ ended_at: new Date().toISOString() }).eq('id', coupon.id);
  if (error) throw error;
  logActivity({ action: 'update', entityType: 'promotion', entityId: 'coupons', summary: `Ended coupon "${coupon.name}"`, metadata: { id: coupon.id } });
}

export async function deleteCoupon(coupon) {
  const { error } = await supabase.from('coupons').delete().eq('id', coupon.id);
  if (error) throw error;
  logActivity({ action: 'delete', entityType: 'promotion', entityId: 'coupons', summary: `Deleted coupon "${coupon.name}"`, metadata: { id: coupon.id, marketplace: coupon.marketplace, starts_on: coupon.starts_on, ends_on: coupon.ends_on } });
}
