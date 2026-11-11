import { supabase } from '@/lib/supabase';

/**
 * Variant families start from the SKU base model: the "LETTERS-DIGITS" prefix
 * (S-300XG → S-300). Products sharing a base model are variants.
 *
 * syncVariantFamilies(skus) gives a family number to the products of those
 * base models that have NONE (a new product, a first import):
 *   - the base's products already share ONE family number: the ones without
 *     join it;
 *   - nobody in the base has one and it has 2+ products: they get a new one;
 *   - the base is split into several families by hand, or the product is
 *     alone: it stays without a family (the person sets it).
 *
 * A family number a product already has is NEVER changed or removed. Until
 * 2026-11-11 every base touched was regrouped from scratch, so any import
 * naming K-131N would have merged the family the user made by hand for
 * K-131 G / N / P / S (79) into K-131 CR / GR / NR / SR's (32), and taken
 * B-111N's (66, alone in it) away — silently, as "family links re-synced".
 *
 * Call it after importing or creating products.
 */

export function baseModelOf(sku) {
  // Letters + optional dash + digits: S-831WNK → S-831, C126L → C126
  const m = String(sku ?? '').match(/^([A-Za-z]+-?\d+)/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * The family numbers to write: [{ sku, family_number }], only for products
 * without one. `all` = every product as { sku, family_number }.
 */
export function planFamilySync(all, skus) {
  const affectedBases = new Set(skus.map(baseModelOf).filter(Boolean));
  const groups = new Map();
  for (const p of all) {
    const b = baseModelOf(p.sku);
    if (!b || !affectedBases.has(b)) continue;
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(p);
  }

  let maxFam = Math.max(0, ...all.map((p) => p.family_number ?? 0));
  const updates = [];
  for (const base of [...groups.keys()].sort()) {
    const members = groups.get(base);
    const without = members.filter((m) => m.family_number == null);
    if (!without.length) continue;
    const numbers = [...new Set(members.map((m) => m.family_number).filter((f) => f != null))];
    let target = null;
    if (numbers.length === 1) target = numbers[0];
    else if (numbers.length === 0 && members.length >= 2) target = ++maxFam;
    // alone in its base, or a base split into several families by hand
    if (target == null) continue;
    for (const m of without) updates.push({ sku: m.sku, family_number: target });
  }
  return updates;
}

export async function syncVariantFamilies(skus) {
  if (!skus.map(baseModelOf).some(Boolean)) return { updated: 0 };

  const { data: all, error } = await supabase
    .from('products')
    .select('sku, family_number')
    .limit(10000);
  if (error) throw error;

  const updates = planFamilySync(all, skus);
  for (let i = 0; i < updates.length; i += 5) {
    const batch = updates.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((u) =>
        supabase.from('products').update({ family_number: u.family_number }).eq('sku', u.sku),
      ),
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) throw new Error(`Family sync failed: ${failed.error.message}`);
  }

  return { updated: updates.length };
}
