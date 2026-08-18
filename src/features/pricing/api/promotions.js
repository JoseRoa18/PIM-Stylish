import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { pushProductToWix } from '@/features/syndication/api/wixSync';
import { pushBestBuyPrices } from '@/features/syndication/api/bestbuySync';
import { getAppSetting } from '@/features/settings/api/appSettings';

/**
 * Monthly promotions. Promo prices come from the user's official lists (one
 * price per SKU — never computed), one promotion per month, applying to all
 * marketplaces. "Apply" copies the CAD promo price into the products'
 * on_sale/sale_price_cad (what the Wix push reads).
 *
 * Application is AUTOMATED where an API can write prices (rule of 2026-08-18,
 * switches in /settings): the promo-apply cron applies the month's promo at
 * 00:00 on the 1st (VET) and pushes the SinksDirect Wix sites; Best Buy gets
 * its discounts SCHEDULED in Mirakl when the list is loaded (see
 * autoScheduleBestBuyPromo) and Mirakl flips them at the start date itself.
 * Everything else (content pushes, channels without a price API) stays manual.
 */

export async function listPromotions() {
  const { data, error } = await supabase
    .from('promotions')
    .select('id, name, period, status, created_at, activated_at, ended_at, bb_scheduled_at, bb_schedule, promotion_prices(count)')
    .order('period', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((p) => ({
    ...p,
    sku_count: p.promotion_prices?.[0]?.count ?? 0,
  }));
}

export async function getPromotionPrices(promotionId) {
  const { data, error } = await supabase
    .from('promotion_prices')
    .select('id, sku, promo_price_cad, promo_price_usd, promo_costs')
    .eq('promotion_id', promotionId)
    .order('sku');
  if (error) throw error;
  return data ?? [];
}

/**
 * Parse a pasted price list ("SKU<tab or spaces>price" per line; $ and
 * thousands commas tolerated). Returns { rows, skipped } — rows are NOT
 * validated against the PIM here; createPromotion does that.
 */
export function parsePriceList(text) {
  const rows = [];
  const skipped = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\S+)[\s\t]+\$?([\d,]+(?:\.\d+)?)\s*$/);
    if (!m) { skipped.push(line); continue; }
    const price = Number(m[2].replace(/,/g, ''));
    if (!Number.isFinite(price) || price <= 0) { skipped.push(line); continue; }
    rows.push({ sku: m[1], price });
  }
  return { rows, skipped };
}

/**
 * Create a promotion with its price rows. `currency` decides which column
 * the pasted prices fill ('cad' | 'usd'). SKUs missing from the PIM are
 * returned, never inserted (FK would reject them anyway).
 */
export async function createPromotion({ name, period, currency, rows }) {
  const { data: prods, error: prodErr } = await supabase.from('products').select('sku');
  if (prodErr) throw prodErr;
  const pimSkus = new Set((prods ?? []).map((p) => p.sku));

  const valid = rows.filter((r) => pimSkus.has(r.sku));
  const notInPim = rows.filter((r) => !pimSkus.has(r.sku)).map((r) => r.sku);
  if (!valid.length) throw new Error('None of the SKUs in the list exist in the PIM.');

  const { data: promo, error } = await supabase
    .from('promotions')
    .insert({ name, period, status: 'draft' })
    .select()
    .single();
  if (error) throw error;

  const col = currency === 'usd' ? 'promo_price_usd' : 'promo_price_cad';
  const priceRows = valid.map((r) => ({ promotion_id: promo.id, sku: r.sku, [col]: r.price }));
  for (let i = 0; i < priceRows.length; i += 200) {
    const { error: insErr } = await supabase.from('promotion_prices').insert(priceRows.slice(i, i + 200));
    if (insErr) throw insErr;
  }

  logActivity({
    action: 'create',
    entityType: 'promotion',
    entityId: String(promo.id),
    summary: `Created promotion "${name}" (${valid.length} SKUs)`,
    metadata: { period, currency, skus: valid.length, not_in_pim: notInPim.length },
  });
  return { promotion: promo, added: valid.length, notInPim };
}

/**
 * Create a promotion from full row objects (the file-import path):
 *   [{ sku, promo_price_cad, promo_price_usd, promo_costs }]
 */
export async function createPromotionFromFile({ name, period, rows }) {
  const { data: prods, error: prodErr } = await supabase.from('products').select('sku');
  if (prodErr) throw prodErr;
  const pimSkus = new Set((prods ?? []).map((p) => p.sku));

  const valid = rows.filter((r) => pimSkus.has(r.sku));
  const notInPim = rows.filter((r) => !pimSkus.has(r.sku)).map((r) => r.sku);
  if (!valid.length) throw new Error('None of the SKUs in the file exist in the PIM.');

  const { data: promo, error } = await supabase
    .from('promotions')
    .insert({ name, period, status: 'draft' })
    .select()
    .single();
  if (error) throw error;

  const priceRows = valid.map((r) => ({
    promotion_id: promo.id,
    sku: r.sku,
    promo_price_cad: r.promo_price_cad ?? null,
    promo_price_usd: r.promo_price_usd ?? null,
    promo_costs: r.promo_costs ?? {},
  }));
  for (let i = 0; i < priceRows.length; i += 200) {
    const { error: insErr } = await supabase.from('promotion_prices').insert(priceRows.slice(i, i + 200));
    if (insErr) throw insErr;
  }

  logActivity({
    action: 'create',
    entityType: 'promotion',
    entityId: String(promo.id),
    summary: `Created promotion "${name}" from file (${valid.length} SKUs)`,
    metadata: { period, skus: valid.length, not_in_pim: notInPim.length },
  });
  return { promotion: promo, added: valid.length, notInPim };
}

/**
 * Merge full row objects (a market file) into an existing promotion. Values
 * present in the file win; everything else on the row is preserved — so the
 * Canada file and the USA file can arrive at different times.
 */
export async function addFileToPromotion(promotion, rows) {
  const { data: prods, error: prodErr } = await supabase.from('products').select('sku');
  if (prodErr) throw prodErr;
  const pimSkus = new Set((prods ?? []).map((p) => p.sku));
  const valid = rows.filter((r) => pimSkus.has(r.sku));
  const notInPim = rows.filter((r) => !pimSkus.has(r.sku)).map((r) => r.sku);

  const existing = await getPromotionPrices(promotion.id);
  const bySku = new Map(existing.map((r) => [r.sku, r]));

  const upserts = valid.map((r) => {
    const prev = bySku.get(r.sku);
    return {
      promotion_id: promotion.id,
      sku: r.sku,
      promo_price_cad: r.promo_price_cad ?? prev?.promo_price_cad ?? null,
      promo_price_usd: r.promo_price_usd ?? prev?.promo_price_usd ?? null,
      promo_costs: { ...(prev?.promo_costs ?? {}), ...(r.promo_costs ?? {}) },
    };
  });
  for (let i = 0; i < upserts.length; i += 200) {
    const { error } = await supabase
      .from('promotion_prices')
      .upsert(upserts.slice(i, i + 200), { onConflict: 'promotion_id,sku' });
    if (error) throw error;
  }

  logActivity({
    action: 'update',
    entityType: 'promotion',
    entityId: String(promotion.id),
    summary: `Imported file into promotion "${promotion.name}" (${valid.length} SKUs)`,
    metadata: { skus: valid.length, not_in_pim: notInPim.length },
  });
  return { added: valid.length, notInPim };
}

/**
 * Mark a draft promotion as active WITHOUT touching store pricing — for
 * promotions that were already uploaded to the marketplaces outside the PIM.
 */
export async function markPromotionActive(promotion) {
  const { error } = await supabase
    .from('promotions')
    .update({ status: 'active', activated_at: new Date().toISOString() })
    .eq('id', promotion.id);
  if (error) throw error;
  logActivity({
    action: 'update',
    entityType: 'promotion',
    entityId: String(promotion.id),
    summary: `Marked promotion "${promotion.name}" as active (already live on marketplaces)`,
  });
}

/**
 * Merge more pasted rows into an existing promotion (upsert by SKU).
 */
export async function addPricesToPromotion(promotionId, { currency, rows }) {
  const { data: prods, error: prodErr } = await supabase.from('products').select('sku');
  if (prodErr) throw prodErr;
  const pimSkus = new Set((prods ?? []).map((p) => p.sku));
  const valid = rows.filter((r) => pimSkus.has(r.sku));
  const notInPim = rows.filter((r) => !pimSkus.has(r.sku)).map((r) => r.sku);

  const col = currency === 'usd' ? 'promo_price_usd' : 'promo_price_cad';
  const priceRows = valid.map((r) => ({ promotion_id: promotionId, sku: r.sku, [col]: r.price }));
  for (let i = 0; i < priceRows.length; i += 200) {
    const { error } = await supabase
      .from('promotion_prices')
      .upsert(priceRows.slice(i, i + 200), { onConflict: 'promotion_id,sku' });
    if (error) throw error;
  }
  return { added: valid.length, notInPim };
}

export async function removePromotionPrice(rowId) {
  const { error } = await supabase.from('promotion_prices').delete().eq('id', rowId);
  if (error) throw error;
}

export async function deletePromotion(promotionId) {
  const { error } = await supabase.from('promotions').delete().eq('id', promotionId);
  if (error) throw error;
  logActivity({
    action: 'delete',
    entityType: 'promotion',
    entityId: String(promotionId),
    summary: `Deleted promotion #${promotionId}`,
  });
}

/**
 * Apply the promotion to the store pricing: for every member SKU with a CAD
 * promo price, set on_sale + sale_price_cad in the PIM. Does NOT push —
 * pushes are always a separate, manual step.
 */
export async function applyPromotion(promotion) {
  const prices = await getPromotionPrices(promotion.id);
  const withCad = prices.filter((r) => r.promo_price_cad != null);
  for (const row of withCad) {
    const { error } = await supabase
      .from('products')
      .update({ on_sale: true, sale_price_cad: row.promo_price_cad })
      .eq('sku', row.sku);
    if (error) throw error;
  }
  const { error } = await supabase
    .from('promotions')
    .update({ status: 'active', activated_at: new Date().toISOString() })
    .eq('id', promotion.id);
  if (error) throw error;

  logActivity({
    action: 'update',
    entityType: 'promotion',
    entityId: String(promotion.id),
    summary: `Applied promotion "${promotion.name}" to PIM pricing (${withCad.length} SKUs on sale)`,
    metadata: { skus: withCad.length },
  });
  return { applied: withCad.length };
}

/**
 * End the promotion: clear on_sale/sale_price_cad on every member SKU.
 * Does NOT push — same manual rule.
 */
export async function endPromotion(promotion) {
  const prices = await getPromotionPrices(promotion.id);
  for (const row of prices) {
    const { error } = await supabase
      .from('products')
      .update({ on_sale: false, sale_price_cad: null })
      .eq('sku', row.sku);
    if (error) throw error;
  }
  const { error } = await supabase
    .from('promotions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', promotion.id);
  if (error) throw error;

  logActivity({
    action: 'update',
    entityType: 'promotion',
    entityId: String(promotion.id),
    summary: `Ended promotion "${promotion.name}" (${prices.length} SKUs back to regular price)`,
    metadata: { skus: prices.length },
  });
  return { cleared: prices.length };
}

/** Last day of the promo month ('YYYY-MM-01' → 'YYYY-MM-DD'). */
function promoMonthEnd(period) {
  const [y, m] = String(period).split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/**
 * Schedule the promotion's CAD prices on Best Buy as Mirakl SCHEDULED
 * discounts for exactly the promo month — Mirakl turns them on at 00:00 of
 * the start date and off after the end date on its own, so nothing needs to
 * run at midnight. Called automatically after a promo list is loaded or
 * updated (honors the 'promo_automation' switches; re-running overwrites the
 * previous schedule, so updates are safe). Only SKUs with a live Best Buy
 * offer in the latest snapshot are sent; the regular price rides along as the
 * PIM MAP so stale MAPs get corrected in the same import.
 */
export async function autoScheduleBestBuyPromo(promotion) {
  const settings = await getAppSetting('promo_automation', {});
  if (settings.enabled === false || settings.bestbuy === false) return { skipped: 'automation off' };

  const now = new Date();
  const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  if (String(promotion.period) < currentPeriod) return { skipped: 'past promotion' };

  const prices = await getPromotionPrices(promotion.id);
  const members = prices.filter((r) => r.promo_price_cad != null);
  if (!members.length) return { skipped: 'no CAD prices yet' };

  const { data: snap, error: snapErr } = await supabase
    .from('channel_health')
    .select('results')
    .eq('channel', 'bestbuy')
    .order('run_at', { ascending: false })
    .limit(1);
  if (snapErr) throw snapErr;
  const listed = new Set((snap?.[0]?.results ?? []).map((o) => o.sku));

  const mapBySku = new Map();
  const skus = members.map((r) => r.sku);
  for (let i = 0; i < skus.length; i += 100) {
    const { data, error } = await supabase
      .from('products')
      .select('sku, map_cad')
      .in('sku', skus.slice(i, i + 100));
    if (error) throw error;
    for (const p of data ?? []) mapBySku.set(p.sku, p.map_cad);
  }

  const start = promotion.period;
  const end = promoMonthEnd(start);
  const updates = [];
  const skippedAtOrAboveMap = [];
  for (const m of members) {
    if (!listed.has(m.sku)) continue;
    const map = mapBySku.get(m.sku);
    if (map != null && m.promo_price_cad >= map) { skippedAtOrAboveMap.push(m.sku); continue; }
    updates.push({
      sku: m.sku,
      ...(map != null ? { price: map } : {}),
      discount_price: m.promo_price_cad,
      discount_start_date: start,
      discount_end_date: end,
    });
  }
  const notListed = members.length - updates.length - skippedAtOrAboveMap.length;

  let res = null;
  if (updates.length) res = await pushBestBuyPrices(updates);

  const report = {
    at: new Date().toISOString(),
    period: start,
    end,
    scheduled: Math.max(0, updates.length - (res?.lines_in_error ?? 0)),
    attempted: updates.length,
    not_listed: notListed,
    skipped_at_or_above_map: skippedAtOrAboveMap,
    import_id: res?.import_id ?? null,
    lines_in_error: res?.lines_in_error ?? 0,
  };
  const { error: upErr } = await supabase
    .from('promotions')
    .update({ bb_scheduled_at: report.at, bb_schedule: report })
    .eq('id', promotion.id);
  if (upErr) throw upErr;

  logActivity({
    action: 'push',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: 'bestbuy',
    summary: `Scheduled "${promotion.name}" on Best Buy — ${report.scheduled} discounts for ${start} → ${end}` +
      (notListed ? ` · ${notListed} not listed there` : ''),
    metadata: report,
  });
  return report;
}

/**
 * Push the promotion's member products to Wix (only those linked), one by
 * one with progress. Used after apply AND after end — it just syncs the
 * products' current pricing state to the store.
 */
export async function pushPromotionToWix(promotion, onProgress) {
  const prices = await getPromotionPrices(promotion.id);
  const skus = prices.map((r) => r.sku);
  const { data: prods, error } = await supabase
    .from('products')
    .select('sku, wix_product_id')
    .in('sku', skus);
  if (error) throw error;
  const linked = (prods ?? []).filter((p) => p.wix_product_id).map((p) => p.sku);

  let done = 0;
  const failures = [];
  for (const sku of linked) {
    try {
      await pushProductToWix(sku);
    } catch (err) {
      failures.push(`${sku}: ${err.message}`);
    }
    done += 1;
    onProgress?.({ done, total: linked.length });
  }
  return { pushed: done - failures.length, total: linked.length, notLinked: skus.length - linked.length, failures };
}
