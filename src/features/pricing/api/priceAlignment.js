import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { pushProductToWix } from '@/features/syndication/api/wixSync';

/**
 * Price Alignment Analyzer — Wix (SinksDirect) phase.
 *
 * Expected price rule: a SKU in an ACTIVE promotion is expected at its CAD
 * promo price; everything else at its regular MAP (the store's selling
 * price). Only PIM products count — Wix-only orphans are out of scope by
 * the source-of-truth rule.
 *
 * Classifications:
 *   promo_ok      — live price = active promo price ✓
 *   map_ok        — live price = regular MAP ✓ (not in a promo)
 *   promo_missing — promo member still at the regular MAP ⚠
 *   misaligned    — neither promo nor MAP 🔴
 *   no_map        — nothing to compare against (no MAP in the PIM) ⚪
 *   missing       — linked but the Wix product no longer exists 🔴
 */
export async function runPriceAlignment() {
  const { data: pullData, error: fnError } = await supabase.functions.invoke('wix-pull-catalog', { body: {} });
  if (fnError) throw new Error(fnError.message ?? 'wix-pull-catalog failed');
  if (pullData?.error) throw new Error(pullData.error);
  const wixById = new Map((pullData.products ?? []).map((w) => [w.id, w]));

  const { data: prods, error } = await supabase
    .from('products')
    .select('sku, map_cad, wix_product_id')
    .not('wix_product_id', 'is', null);
  if (error) throw error;

  // Active promos' CAD prices; if several are active, the newest month wins.
  const { data: promos, error: promoErr } = await supabase
    .from('promotions')
    .select('id, name, period, promotion_prices(sku, promo_price_cad)')
    .eq('status', 'active')
    .order('period', { ascending: true });
  if (promoErr) throw promoErr;
  const promoBySku = new Map();
  for (const promo of promos ?? []) {
    for (const row of promo.promotion_prices ?? []) {
      if (row.promo_price_cad != null) {
        promoBySku.set(row.sku, { price: row.promo_price_cad, promoName: promo.name });
      }
    }
  }

  const eq = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.01;
  const counts = { promo_ok: 0, map_ok: 0, promo_missing: 0, misaligned: 0, no_map: 0, missing: 0 };
  const problems = [];

  for (const p of prods ?? []) {
    const w = wixById.get(p.wix_product_id);
    if (!w) {
      counts.missing += 1;
      problems.push({ sku: p.sku, status: 'missing', live: null, expected: null, source: null });
      continue;
    }
    const live = w.discountedPrice ?? w.price;
    const promo = promoBySku.get(p.sku);
    const expected = promo?.price ?? p.map_cad ?? null;
    const source = promo ? 'promo' : 'map';

    if (expected == null) {
      counts.no_map += 1;
      problems.push({ sku: p.sku, status: 'no_map', live, expected: null, source: null });
    } else if (eq(live, expected)) {
      counts[promo ? 'promo_ok' : 'map_ok'] += 1;
    } else if (promo && eq(live, p.map_cad)) {
      counts.promo_missing += 1;
      problems.push({ sku: p.sku, status: 'promo_missing', live, expected, source, promoName: promo.promoName });
    } else {
      counts.misaligned += 1;
      problems.push({ sku: p.sku, status: 'misaligned', live, expected, source, promoName: promo?.promoName });
    }
  }

  problems.sort((a, b) => a.sku.localeCompare(b.sku));
  return { ranAt: new Date().toISOString(), total: (prods ?? []).length, counts, problems };
}

/**
 * Push ONE product's expected price to Wix — priceData only, so a fix can
 * never touch visibility or content. `expected` comes from the analysis
 * (promo price or regular MAP).
 */
export async function pushExpectedPrice(sku, expected) {
  await pushProductToWix(sku, { map_cad: expected }, ['priceData']);
}

/**
 * Fix a batch of analysis problems (the fixable ones), one by one.
 */
export async function fixAlignment(problems, onProgress) {
  const fixable = problems.filter((p) => p.expected != null);
  let done = 0;
  const failures = [];
  for (const p of fixable) {
    try {
      await pushExpectedPrice(p.sku, p.expected);
    } catch (err) {
      failures.push(`${p.sku}: ${err.message}`);
    }
    done += 1;
    onProgress?.({ done, total: fixable.length });
  }
  logActivity({
    action: 'push',
    entityType: 'product',
    target: 'wix',
    summary: `Price alignment: pushed ${fixable.length - failures.length} corrected price${fixable.length - failures.length === 1 ? '' : 's'} to Wix`,
    metadata: { fixed: fixable.length - failures.length, failures: failures.length },
  });
  return { fixed: fixable.length - failures.length, failures };
}
