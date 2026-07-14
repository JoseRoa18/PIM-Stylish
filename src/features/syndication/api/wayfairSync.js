import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

/**
 * Invoke a Wayfair edge function and surface the function's real error message.
 * supabase.functions.invoke reports any non-2xx as a generic "Edge Function
 * returned a non-2xx status code"; the actual reason (e.g. "S-01N is class 875")
 * is in the response body, so read it from error.context.
 */
async function invokeWayfair(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let detail = error.message;
    try {
      if (error.context && typeof error.context.text === 'function') {
        const text = await error.context.text();
        try {
          const parsed = JSON.parse(text);
          detail = parsed.error || parsed.message || text;
        } catch {
          detail = text || detail;
        }
      }
    } catch {
      // fall back to error.message
    }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * Push a product to Wayfair: marketing copy + feature bullets (content) and/or
 * product images (media). `validateOnly` (default true) validates the payload
 * against Wayfair without changing anything — safe to run against production.
 *
 * Content needs the product's Wayfair itemGroupId (stored on the product, or
 * passed here). Media pushes by SKU and needs no itemGroupId.
 *
 * @param {string} sku
 * @param {Object} [opts]
 * @param {boolean} [opts.validateOnly=true]
 * @param {boolean} [opts.pushContent=true]
 * @param {boolean} [opts.pushMedia=true]
 * @param {string}  [opts.itemGroupId]  override the stored item-group id
 */
export async function pushToWayfair(sku, opts = {}) {
  const { validateOnly = true, pushContent = true, pushMedia = true, itemGroupId, market, supplier = 'CAN' } = opts;
  const data = await invokeWayfair('wayfair-push-content', { sku, validateOnly, pushContent, pushMedia, itemGroupId, market, supplier });

  if (!validateOnly) {
    logActivity({
      action: 'push',
      entityType: 'product',
      entityId: sku,
      target: 'wayfair',
      summary: `Pushed ${sku} to Wayfair`,
      metadata: { content: data?.content, media: data?.media },
    });
  }
  return data;
}

/**
 * Push a kitchen sink's spec attributes (dimensions, gauge, basins, material,
 * finish, warranty…) to Wayfair. Returns a diff of current vs new values plus
 * the mutation requestId. Only supports Wayfair class 628 (Kitchen Sinks).
 *
 * @param {string} sku
 * @param {Object} [opts]
 * @param {boolean} [opts.validateOnly=true] validate at Wayfair without changing
 * @param {boolean} [opts.dryRun=false]      only compute the diff, no mutation
 */
export async function pushWayfairAttributes(sku, opts = {}) {
  const { validateOnly = true, dryRun = false, market, supplier = 'CAN' } = opts;
  const data = await invokeWayfair('wayfair-push-attributes', { sku, validateOnly, dryRun, market, supplier });
  if (!validateOnly && !dryRun) {
    logActivity({
      action: 'push',
      entityType: 'product',
      entityId: sku,
      target: 'wayfair',
      summary: `Pushed ${sku} spec attributes to Wayfair`,
      metadata: { updates: data?.updates, changed: data?.changedCount },
    });
  }
  return data;
}

/**
 * Ask Wayfair what it did with a prior push: status (PENDING/COMPLETED/…),
 * problems, and the per-property list of successful updates. In sandbox every
 * push is processed as validation-only, so this is how you see it "working".
 * @param {string} requestId  requestId returned by pushToWayfair
 */
export async function checkWayfairRequestStatus(requestId) {
  return invokeWayfair('wayfair-push-content', { statusRequestId: requestId });
}

/**
 * Pull Wayfair listing/item-group IDs for every PIM SKU and (optionally) store
 * them on products.wayfair_item_group_id. Runs in batches of 30 SKUs — the
 * Wayfair catalog query is capped at 30 items per page and a full-catalog crawl
 * exceeds the edge-function time limit.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.apply=false]     false = dry-run count; true = write IDs
 * @param {boolean} [opts.overwrite=false] also replace IDs that are already set
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {{ matched: number, applied: number, batches: number, errors: string[] }}
 */
export async function pullWayfairItemGroups(opts = {}) {
  const { apply = false, overwrite = false, onProgress } = opts;

  const { data: rows, error: readErr } = await supabase
    .from('products')
    .select('sku')
    .order('sku');
  if (readErr) throw readErr;
  const skus = rows.map((r) => r.sku);

  let matched = 0;
  let applied = 0;
  const errors = [];
  const batches = Math.ceil(skus.length / 30);
  for (let i = 0; i < skus.length; i += 30) {
    try {
      const data = await invokeWayfair('wayfair-pull-groups', { apply, overwrite, skus: skus.slice(i, i + 30) });
      matched += data.matched ?? 0;
      applied += data.applied ?? 0;
    } catch (err) {
      errors.push(err.message);
    }
    onProgress?.(Math.min(i / 30 + 1, batches), batches);
  }

  if (apply && applied > 0) {
    logActivity({
      action: 'sync',
      entityType: 'catalog',
      entityId: 'wayfair',
      target: 'wayfair',
      summary: `Imported ${applied} Wayfair item-group IDs`,
      metadata: { matched, applied, errors: errors.length },
    });
  }
  return { matched, applied, batches, errors };
}

/** Save the Wayfair item-group id for a product (needed to push content). */
export async function setWayfairItemGroupId(sku, itemGroupId) {
  const { error } = await supabase
    .from('products')
    .update({ wayfair_item_group_id: itemGroupId?.trim() || null })
    .eq('sku', sku);
  if (error) throw error;
}
