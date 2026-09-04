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
 * The push plan for a listed product: every step in order (images, videos,
 * documents) with its items, plus whether the product is in the supplier's
 * catalog. Reads only — nothing is sent. Title, description, bullets and
 * prices are never part of a Wayfair push.
 */
export async function planWayfairPush(sku, opts = {}) {
  const { supplier = 'CAN', market } = opts;
  return invokeWayfair('wayfair-push-content', { sku, mode: 'plan', supplier, market });
}

/**
 * Push media to a listed Wayfair product, step by step in the plan's order.
 * Each step comes back with Wayfair's requestId (or its refusal).
 *
 * @param {string} sku
 * @param {Object} [opts]
 * @param {{images?: boolean, videos?: boolean, documents?: boolean}} [opts.steps]
 * @param {boolean} [opts.validateOnly=false]
 */
export async function pushWayfairMedia(sku, opts = {}) {
  const { supplier = 'CAN', market, steps, validateOnly = false } = opts;
  const data = await invokeWayfair('wayfair-push-content', { sku, mode: 'push', supplier, market, steps, validateOnly });
  if (!validateOnly) {
    for (const r of data?.results ?? []) {
      logActivity({
        action: 'push',
        entityType: 'product',
        entityId: sku,
        target: 'wayfair',
        summary: `Pushed ${r.count} ${r.step} to Wayfair ${supplier}${data?.env === 'sandbox' ? ' (sandbox)' : ''}${r.error ? ' — refused' : ''}`,
        metadata: { step: r.step, count: r.count, requestId: r.requestId, error: r.error ?? null, env: data?.env ?? null, supplier },
      });
    }
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
  // A rejected mutation comes back nested inside a 200 response — surface it
  // as a real failure so the UI never reports a denied push as "ok".
  if (!dryRun && data?.mutation?.error) {
    throw new Error(`Wayfair rejected the update: ${data.mutation.error}`);
  }
  if (!validateOnly && !dryRun) {
    logActivity({
      action: 'push',
      entityType: 'product',
      entityId: sku,
      target: 'wayfair',
      summary: `Pushed ${sku} spec attributes to Wayfair${data?.env === 'sandbox' ? ' (sandbox)' : ''}`,
      metadata: { updates: data?.updates, changed: data?.changedCount, requestId: data?.mutation?.requestId, env: data?.env ?? null, supplier },
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
/** Second pass after the images landed: force the white main as Wayfair's lead image. */
export async function setWayfairLeadImage(sku, opts = {}) {
  const { supplier = 'CAN', market } = opts;
  const data = await invokeWayfair('wayfair-push-content', { sku, mode: 'lead', supplier, market });
  logActivity({
    action: 'push',
    entityType: 'product',
    entityId: sku,
    target: 'wayfair',
    summary: `Set the lead image on Wayfair ${supplier} for ${sku}${data?.env === 'sandbox' ? ' (sandbox)' : ''}`,
    metadata: { step: 'lead', requestId: data?.requestId ?? null, env: data?.env ?? null, supplier },
  });
  return data;
}

export async function checkWayfairRequestStatus(requestId, opts = {}) {
  const { supplier = 'CAN' } = opts;
  return invokeWayfair('wayfair-push-content', { statusRequestId: requestId, supplier });
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

/**
 * Create NEW Wayfair listings (Product Addition V2) for products that are not
 * in the supplier's catalog yet. The edge function maps the PIM (identity,
 * copy, bullets, images, cost, shipping, specs) to the class's questions and
 * reports what it couldn't map. `validateOnly` (default true) only validates;
 * false submits the listing request — track it with checkWayfairAdditionStatus.
 *
 * @param {string[]} skus
 * @param {Object} [opts]
 * @param {'USA'|'CAN'} [opts.supplier='USA']
 * @param {boolean} [opts.validateOnly=true]
 * @param {boolean} [opts.sandbox=false]   run against Wayfair's sandbox (never creates)
 * @param {boolean} [opts.force=false]     also submit SKUs already in the catalog
 */
export async function submitWayfairAdditions(skus, opts = {}) {
  const { supplier = 'USA', validateOnly = true, sandbox = false, force = false, classId } = opts;
  const data = await invokeWayfair('wayfair-add-products', { skus, supplier, validateOnly, sandbox, force, classId });
  if (!validateOnly && !sandbox) {
    for (const p of data?.products ?? []) {
      logActivity({
        action: 'push',
        entityType: 'product',
        entityId: p.sku,
        target: 'wayfair',
        summary: `Submitted ${p.sku} as a new Wayfair ${supplier} listing`,
        metadata: { requestId: p.requestId ?? data.requestId, classId: p.classId, status: p.status, errors: p.errors?.length ?? 0 },
      });
    }
  }
  return data;
}

/** Status of a Product Addition request (per SKU validation + submission state). */
export async function checkWayfairAdditionStatus(requestId, opts = {}) {
  const { supplier = 'USA', sandbox = false } = opts;
  return invokeWayfair('wayfair-add-products', { status: requestId, supplier, sandbox });
}
