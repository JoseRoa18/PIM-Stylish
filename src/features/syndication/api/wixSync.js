import { supabase } from '@/lib/supabase';

/**
 * Calls the wix-import-products Edge Function (link-only mode).
 * Links PIM rows to Wix products by SKU match — sets wix_product_id + wix_synced_at.
 *
 * @param {Object} opts
 * @param {boolean} opts.dryRun - true → preview only, false → apply
 */
export async function runWixImport({ dryRun = true } = {}) {
  const { data, error } = await supabase.functions.invoke('wix-import-products', {
    body: { dryRun },
  });

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
 * Lists all Wix Stores collections (categories). Used by the multi-select
 * picker on the Wix syndication card. Cache-friendly — collections change rarely.
 */
export async function listWixCollections() {
  const { data, error } = await supabase.functions.invoke('wix-list-collections', {
    body: {},
  });

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
      // ignore
    }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data.collections ?? [];
}

/**
 * Read-only: fetch the current state of a product from Wix Stores
 * without writing anything to the PIM.
 *
 * Returns `{ exists, snapshot }`:
 *   - exists: false  → the product no longer exists in Wix (stale/broken link)
 *   - snapshot: the mapped Wix fields, or null when it doesn't exist
 * Throws only on real failures (network, auth, unexpected API errors).
 */
export async function readWixProduct(sku) {
  const { data, error } = await supabase.functions.invoke('wix-read-product', {
    body: { sku },
  });

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
      // ignore
    }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return { exists: data?.exists !== false, snapshot: data?.snapshot ?? null };
}

/**
 * Pushes to a linked Wix product. If `fields` is provided, those values are
 * sent directly to Wix WITHOUT writing to the PIM (PIM stays untouched).
 * If omitted, the Edge Function reads from PIM columns as before.
 */
export async function pushProductToWix(sku, fields = undefined) {
  const body = { sku };
  if (fields) body.fields = fields;
  const { data, error } = await supabase.functions.invoke('wix-push-product', {
    body,
  });

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
      // fall back
    }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
