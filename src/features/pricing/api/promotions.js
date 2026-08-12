import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { pushProductToWix } from '@/features/syndication/api/wixSync';

/**
 * Monthly promotions. Promo prices come from the user's official lists (one
 * price per SKU — never computed), one promotion per month, applying to all
 * marketplaces. "Apply" copies the CAD promo price into the products'
 * on_sale/sale_price_cad (what the Wix push reads); pushes stay manual.
 */

export async function listPromotions() {
  const { data, error } = await supabase
    .from('promotions')
    .select('id, name, period, status, created_at, activated_at, ended_at, promotion_prices(count)')
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
