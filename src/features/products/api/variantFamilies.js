import { supabase } from '@/lib/supabase';

/**
 * Variant families are derived from the SKU base model: the "LETTERS-DIGITS"
 * prefix (S-300XG → S-300). Products sharing a base model are variants.
 *
 * syncVariantFamilies(skus) re-syncs the family_number of every product whose
 * base model matches one of the given SKUs:
 *   - groups with 2+ products share a family number (reusing the group's
 *     existing number when it isn't contaminated by another base model)
 *   - singletons get family_number = NULL
 *
 * Call it after importing or creating products.
 */

export function baseModelOf(sku) {
  // Letters + optional dash + digits: S-831WNK → S-831, C126L → C126
  const m = String(sku ?? '').match(/^([A-Za-z]+-?\d+)/);
  return m ? m[1].toUpperCase() : null;
}

export async function syncVariantFamilies(skus) {
  const affectedBases = new Set(skus.map(baseModelOf).filter(Boolean));
  if (affectedBases.size === 0) return { updated: 0 };

  const { data: all, error } = await supabase
    .from('products')
    .select('sku, family_number')
    .limit(10000);
  if (error) throw error;

  // Which base models does each family number currently span?
  // A family number is only reusable for a base if it's exclusive to it.
  const famBases = new Map();
  for (const p of all) {
    if (p.family_number == null) continue;
    const b = baseModelOf(p.sku);
    if (!famBases.has(p.family_number)) famBases.set(p.family_number, new Set());
    famBases.get(p.family_number).add(b);
  }

  const groups = new Map();
  for (const p of all) {
    const b = baseModelOf(p.sku);
    if (!b || !affectedBases.has(b)) continue;
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(p);
  }

  let maxFam = Math.max(0, ...all.map((p) => p.family_number ?? 0));
  const claimed = new Set();
  const updates = [];

  for (const base of [...groups.keys()].sort()) {
    const members = groups.get(base);
    let target = null;

    if (members.length >= 2) {
      const reusable = members
        .map((m) => m.family_number)
        .filter(
          (f) =>
            f != null &&
            !claimed.has(f) &&
            famBases.get(f)?.size === 1 &&
            famBases.get(f).has(base),
        );
      target = reusable.length > 0 ? Math.min(...reusable) : ++maxFam;
      claimed.add(target);
    }

    for (const m of members) {
      if (m.family_number !== target) {
        updates.push({ sku: m.sku, family_number: target });
      }
    }
  }

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
