import { supabase } from '@/lib/supabase';
import { syncVariantFamilies } from '@/features/products/api/variantFamilies';
import { logActivity } from '@/features/activity/api/activityLog';

/**
 * Check which of the given SKUs already exist. Returns a Map of
 * sku → { attributes, description, is_obsolete } for merge purposes (the
 * mark tells the Activity Log which products an import marks or unmarks).
 */
export async function fetchExistingProducts(skus) {
  if (!skus.length) return new Map();
  const out = new Map();
  for (let i = 0; i < skus.length; i += 100) {
    const chunk = skus.slice(i, i + 100);
    const { data, error } = await supabase
      .from('products')
      .select('sku, attributes, description, is_obsolete')
      .in('sku', chunk);
    if (error) throw error;
    for (const row of data ?? []) out.set(row.sku, row);
  }
  return out;
}

// A description's words, whatever its HTML: tags, entities and spacing out.
const textOf = (html) => String(html ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

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
  // What got written ({ r, isNew }), for the Activity Log entry — kept when a
  // batch fails midway, since the rows before it are saved.
  const written = [];

  try {
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
        written.push(...newRows.slice(i, i + 50).map((r) => ({ r, isNew: true })));
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
          // The sheet holds the description as plain text; one whose words did
          // not change keeps the PIM's formatting (lists, bold) instead of
          // coming back as bare paragraphs.
          if (patch.description != null && textOf(patch.description) === textOf(prev?.description)) delete patch.description;
          return supabase.from('products').update(patch).eq('sku', r.sku);
        }),
      );
      results.forEach((res, j) => { if (!res.error) written.push({ r: batch[j], isNew: false }); });
      const failed = results.find((res) => res.error);
      if (failed?.error) {
        throw new Error(`Update failed: ${failed.error.message}`);
      }
      done += batch.length;
      onProgress?.(done, total);
    }
  } finally {
    logImport(written, existingMap);
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

// One Activity Log entry per import (2026-10-16): how many products it created
// and updated, and the obsolete marks it set or removed (user: who marked it
// and when). Each product's History holds every field the import changed.
function logImport(written, existingMap) {
  if (!written.length) return;
  const created = written.filter((w) => w.isNew).length;
  const updated = written.length - created;
  const wasObsolete = (sku) => Boolean(existingMap.get(sku)?.is_obsolete);
  const marked = written.filter(({ r, isNew }) => r.columns.is_obsolete === true && (isNew || !wasObsolete(r.sku))).map(({ r }) => r.sku);
  const unmarked = written.filter(({ r, isNew }) => !isNew && r.columns.is_obsolete === false && wasObsolete(r.sku)).map(({ r }) => r.sku);
  const parts = [`${created} created`, `${updated} updated`];
  if (marked.length) parts.push(`${marked.length} marked obsolete`);
  if (unmarked.length) parts.push(`obsolete mark removed from ${unmarked.length}`);
  logActivity({
    action: 'import',
    entityType: 'product',
    entityId: written.length === 1 ? written[0].r.sku : `${written.length} products`,
    summary: `Imported ${written.length} ${written.length === 1 ? 'product' : 'products'} from a spreadsheet (${parts.join(', ')})`,
    metadata: { created, updated, skus: written.map(({ r }) => r.sku), marked_obsolete: marked, unmarked_obsolete: unmarked },
  });
}
