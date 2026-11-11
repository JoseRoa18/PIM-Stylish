import { supabase } from '@/lib/supabase';
import { syncVariantFamilies } from '@/features/products/api/variantFamilies';
import { logActivity } from '@/features/activity/api/activityLog';
import { upcKey } from '@/features/import/lib/upcCheck';
import { sendToOdoo, changedOdooFields } from '@/features/odoo/api/odooPush';

/**
 * Check which of the given SKUs already exist. Returns a Map of
 * sku → { attributes, description, is_obsolete, shipping_weight_lb,
 * model_name } for merge purposes (the mark tells the Activity Log which
 * products an import marks or unmarks; the shipping weight and the model
 * name, whether the import changes what Odoo takes).
 * `task` (optional taskProgress reporter): one step per chunk of 100 SKUs.
 */
export async function fetchExistingProducts(skus, { task = null } = {}) {
  if (!skus.length) return new Map();
  const out = new Map();
  const chunks = Math.ceil(skus.length / 100);
  for (let i = 0; i < skus.length; i += 100) {
    const n = i / 100;
    task?.count(n, chunks, chunks > 1 ? `Looking up existing products (${n + 1} of ${chunks})…` : 'Looking up existing products…');
    const chunk = skus.slice(i, i + 100);
    const { data, error } = await supabase
      .from('products')
      .select('sku, attributes, description, is_obsolete, shipping_weight_lb, model_name')
      .in('sku', chunk);
    if (error) throw error;
    for (const row of data ?? []) out.set(row.sku, row);
  }
  task?.progress(1);
  return out;
}

/**
 * Which products carry each UPC, for the whole catalog: a Map of
 * upcKey → [sku]. The import preview checks a file's UPCs against it
 * (flagRepeatedUpcs): a UPC can be on one product only.
 */
export async function fetchUpcOwners() {
  const owners = new Map();
  // paged: the API returns at most 1,000 rows per request
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('products')
      .select('sku, upc:attributes->>upc')
      .order('sku')
      .range(from, from + 999);
    if (error) throw error;
    for (const p of data ?? []) {
      const key = upcKey(p.upc);
      if (!key) continue;
      if (!owners.has(key)) owners.set(key, []);
      owners.get(key).push(p.sku);
    }
    if ((data ?? []).length < 1000) break;
  }
  return owners;
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
 * onProgress(done, total) fires as rows complete. `task` (optional
 * taskProgress reporter): the rows written 90%, the variant family re-sync
 * after them the rest.
 */
export async function importProducts(rows, existingMap, onProgress, { task = null, createInOdoo = false } = {}) {
  const newRows = rows.filter((r) => !existingMap.has(r.sku));
  const updateRows = rows.filter((r) => existingMap.has(r.sku));
  const total = rows.length;
  let done = 0;
  const writing = task?.part(0, 0.9);
  const report = () => {
    onProgress?.(done, total);
    writing?.count(done, total, `Product ${done} of ${total} saved`);
  };
  writing?.count(0, total, newRows.length ? `Creating ${newRows.length} new products…` : `Updating ${updateRows.length} products…`);
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
        report();
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
      report();
    }
  } finally {
    logImport(written, existingMap);
    // What this import changed of the fields Odoo takes (UPC, shipping box
    // and weight) goes there, and its new products are created there when
    // asked (user, 2026-11-11) — with their own cards, and also for the rows
    // saved before a batch failed.
    sendImportToOdoo(written, existingMap, createInOdoo);
  }

  // Re-derive variant families for every base model touched by this import.
  // Spreadsheet "Family #" values are ignored — the SKU is the source of truth.
  let familiesSynced = 0;
  task?.step('Re-syncing variant families…');
  try {
    const sync = await syncVariantFamilies(rows.map((r) => r.sku));
    familiesSynced = sync.updated;
  } catch (err) {
    console.error('Variant family sync failed (non-fatal):', err);
  }
  task?.progress(1);

  return { created: newRows.length, updated: updateRows.length, familiesSynced };
}

// The rows an import wrote, as Odoo sees them: a product the PIM already had
// sends the fields the file changed; a new one sends what the file gave it
// and, with `create`, is created in Odoo when it is not there yet.
function sendImportToOdoo(written, existingMap, create) {
  const changed = { skus: [], fields: new Set() };
  const fresh = { skus: [], fields: new Set() };
  for (const { r, isNew } of written) {
    const prev = isNew ? null : existingMap.get(r.sku);
    const now = {
      attributes: { ...(prev?.attributes ?? {}), ...r.attributes },
      shipping_weight_lb: r.columns.shipping_weight_lb ?? prev?.shipping_weight_lb ?? null,
      model_name: r.columns.model_name ?? prev?.model_name ?? null,
    };
    const fields = changedOdooFields(prev ?? {}, now);
    const group = isNew ? fresh : changed;
    if (!fields.length && !(isNew && create)) continue;
    group.skus.push(r.sku);
    fields.forEach((f) => group.fields.add(f));
  }
  if (changed.skus.length) sendToOdoo(changed.skus, { fields: [...changed.fields] });
  if (fresh.skus.length) sendToOdoo(fresh.skus, { fields: [...fresh.fields], create });
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
