import { supabase } from '@/lib/supabase';
import { syncVariantFamilies } from '@/features/products/api/variantFamilies';

/**
 * Check which of the given SKUs already exist. Returns a Map of
 * sku → { attributes } for merge purposes.
 */
export async function fetchExistingProducts(skus) {
  if (!skus.length) return new Map();
  const out = new Map();
  for (let i = 0; i < skus.length; i += 100) {
    const chunk = skus.slice(i, i + 100);
    const { data, error } = await supabase
      .from('products')
      .select('sku, attributes')
      .in('sku', chunk);
    if (error) throw error;
    for (const row of data ?? []) out.set(row.sku, row);
  }
  return out;
}

/**
 * Import rows: new products are bulk-inserted; existing products are updated
 * individually so only the imported fields are touched (a bulk upsert would
 * null out columns missing from some rows, because PostgREST requires every
 * row in a batch to share the same keys).
 *
 * onProgress(done, total) fires as rows complete.
 */
export async function importProducts(rows, existingMap, onProgress) {
  const newRows = rows.filter((r) => !existingMap.has(r.sku));
  const updateRows = rows.filter((r) => existingMap.has(r.sku));
  const total = rows.length;
  let done = 0;

  // ---- Inserts: normalize to a shared key set so the batch is uniform ----
  if (newRows.length > 0) {
    const allCols = new Set();
    for (const r of newRows) Object.keys(r.columns).forEach((k) => allCols.add(k));

    const payload = newRows.map((r) => {
      const row = { workflow_status: 'new', attributes: r.attributes };
      for (const col of allCols) row[col] = r.columns[col] ?? null;
      return row;
    });

    for (let i = 0; i < payload.length; i += 50) {
      const chunk = payload.slice(i, i + 50);
      const { error } = await supabase.from('products').insert(chunk);
      if (error) {
        throw new Error(`Insert failed (new products, batch starting at ${i + 1}): ${error.message}`);
      }
      done += chunk.length;
      onProgress?.(done, total);
    }
  }

  // ---- Updates: per-row patches touch only the fields the file provided ----
  for (let i = 0; i < updateRows.length; i += 5) {
    const batch = updateRows.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((r) => {
        const prev = existingMap.get(r.sku);
        const patch = {
          ...r.columns,
          attributes: { ...(prev?.attributes ?? {}), ...r.attributes },
        };
        delete patch.sku; // key, not a patch field
        return supabase.from('products').update(patch).eq('sku', r.sku);
      }),
    );
    const failed = results.find((res) => res.error);
    if (failed?.error) {
      throw new Error(`Update failed: ${failed.error.message}`);
    }
    done += batch.length;
    onProgress?.(done, total);
  }

  // Re-derive variant families for every base model touched by this import.
  // Spreadsheet "Family #" values are ignored — the SKU is the source of truth.
  let familiesSynced = 0;
  try {
    const sync = await syncVariantFamilies(rows.map((r) => r.sku));
    familiesSynced = sync.updated;
  } catch (err) {
    console.error('Variant family sync failed (non-fatal):', err);
  }

  return { created: newRows.length, updated: updateRows.length, familiesSynced };
}
