import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { WIX_SITES, DEFAULT_WIX_SITE } from '../lib/wixSites';

const siteLabel = (site) => WIX_SITES[site]?.label ?? 'Wix';

/**
 * Calls the wix-import-products Edge Function (link-only mode).
 * Links PIM rows to the site's Wix products by SKU match (wix_links table).
 *
 * @param {Object} opts
 * @param {boolean} opts.dryRun - true → preview only, false → apply
 * @param {string} opts.site - which Wix site (defaults to SinksDirect Canada)
 */
export async function runWixImport({ dryRun = true, site = DEFAULT_WIX_SITE } = {}) {
  const { data, error } = await supabase.functions.invoke('wix-import-products', {
    body: { dryRun, site },
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

  // Only the apply run is a real change to the Wix site; skip dry-run previews.
  if (!dryRun) {
    const matched = data?.applied ?? data?.linked ?? data?.matched;
    logActivity({
      action: 'import',
      entityType: 'product',
      target: 'wix',
      summary: matched != null
        ? `Linked PIM products to ${siteLabel(site)} (${matched} matched)`
        : `Linked PIM products to ${siteLabel(site)}`,
      metadata: { site, result: data ?? null },
    });
  }
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
export async function readWixProduct(sku, site = DEFAULT_WIX_SITE) {
  const { data, error } = await supabase.functions.invoke('wix-read-product', {
    body: { sku, site },
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
export async function pushProductToWix(sku, fields = undefined, only = undefined, site = DEFAULT_WIX_SITE) {
  const body = { sku, site };
  if (fields) body.fields = fields;
  if (only) body.only = only;
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

  logActivity({
    action: 'push',
    entityType: 'product',
    entityId: sku,
    target: 'wix',
    summary: `Pushed ${sku} to ${siteLabel(site)}`,
    metadata: { site, ...(fields ? { fields: Object.keys(fields) } : { source: 'pim' }), ...(only ? { only } : {}) },
  });
  return data;
}

/**
 * Create a PIM product on Wix (hidden — publishing is a later, deliberate
 * push). If Wix already has the SKU unlinked, the function links it instead
 * of duplicating. Returns { created?, linked_existing?, id, name }.
 */
export async function createProductOnWix(sku, site = DEFAULT_WIX_SITE) {
  const { data, error } = await supabase.functions.invoke('wix-create-product', { body: { sku, site } });
  if (error) {
    let detail = error.message;
    try {
      if (error.context && typeof error.context.text === 'function') {
        const text = await error.context.text();
        try {
          detail = JSON.parse(text).error ?? text;
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

  logActivity({
    action: data.linked_existing ? 'sync' : 'create',
    entityType: 'product',
    entityId: sku,
    target: 'wix',
    summary: data.linked_existing
      ? `Linked ${sku} to its existing ${siteLabel(site)} product`
      : `Created ${sku} on ${siteLabel(site)} (hidden)`,
    metadata: { site, wix_product_id: data.id },
  });
  return data;
}

/**
 * Replace the Wix product's gallery with the PIM's images (primary first,
 * PIM order). Language rule for the bilingual Canadian store: the EN/FR set
 * if the product has one, else EN, else EN/ES + universal — sets never mix.
 * The full selected set is sent; Wix silently keeps at most ~16 (reported as
 * over_wix_cap). Ingestion is asynchronous on Wix's side (~15-30s to appear).
 */
export async function pushMediaToWix(sku, site = DEFAULT_WIX_SITE) {
  const { data, error } = await supabase.functions.invoke('wix-push-media', {
    body: { sku, action: 'replace', site },
  });
  if (error) {
    let detail = error.message;
    try {
      if (error.context && typeof error.context.text === 'function') {
        const text = await error.context.text();
        try {
          detail = JSON.parse(text).error ?? text;
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

  logActivity({
    action: 'push',
    entityType: 'product',
    entityId: sku,
    target: 'wix',
    summary: `Pushed ${data.added ?? 0} image${(data.added ?? 0) === 1 ? '' : 's'} to ${siteLabel(site)} for ${sku}`,
    metadata: {
      site,
      added: data.added,
      removed: data.removed ?? 0,
      language_set: data.language_set ?? null,
      skipped_other_language: data.skipped_other_language ?? 0,
      over_wix_cap: data.over_wix_cap ?? 0,
    },
  });
  return data;
}

/**
 * Fleet-level Wix monitoring: pull the whole store catalog (read-only), join
 * it against the PIM, and persist a channel_health snapshot — same pattern as
 * the Best Buy / Walmart pulls, so Listing Health and the dashboard can show
 * PIM↔Wix drift without touching the live API on every page view.
 *
 * in_sync    = linked products present and visible on Wix
 * with_diffs = live price differs from the EXPECTED price: the active promo
 *              price for promo members, else the regular MAP (CAD) — the
 *              SinksDirect selling price is the Canadian MAP, not MSRP
 * errors     = broken links (PIM points at a Wix id that no longer exists)
 */
export async function refreshWixCatalog() {
  const { data, error: fnError } = await supabase.functions.invoke('wix-pull-catalog', { body: {} });
  if (fnError) throw new Error(fnError.message ?? 'wix-pull-catalog failed');
  if (data?.error) throw new Error(data.error);
  const { total, products: wixProducts } = data;

  const { data: prods, error } = await supabase
    .from('products')
    .select('sku, map_cad, wix_product_id');
  if (error) throw error;

  const { data: activePromos, error: promoErr } = await supabase
    .from('promotions')
    .select('period, promotion_prices(sku, promo_price_cad)')
    .eq('status', 'active')
    .order('period', { ascending: true });
  if (promoErr) throw promoErr;
  const promoBySku = new Map();
  for (const promo of activePromos ?? []) {
    for (const row of promo.promotion_prices ?? []) {
      if (row.promo_price_cad != null) promoBySku.set(row.sku, row.promo_price_cad);
    }
  }

  const wixById = new Map(wixProducts.map((w) => [w.id, w]));
  const linked = (prods ?? []).filter((p) => p.wix_product_id);

  const results = [];
  let inSync = 0;
  let priceDiffs = 0;
  let broken = 0;
  for (const p of linked) {
    const w = wixById.get(p.wix_product_id);
    if (!w) {
      broken += 1;
      results.push({ sku: p.sku, wix_id: p.wix_product_id, state: 'missing' });
      continue;
    }
    const livePrice = w.discountedPrice ?? w.price;
    const promoPrice = promoBySku.get(p.sku);
    const expected = promoPrice ?? p.map_cad;
    const priceDiff = expected != null && livePrice != null && Math.abs(livePrice - expected) > 0.01;
    if (priceDiff) priceDiffs += 1;
    if (w.visible) inSync += 1;
    results.push({
      sku: p.sku,
      wix_id: p.wix_product_id,
      state: w.visible ? 'live' : 'hidden',
      name: w.name,
      price: livePrice,
      expected: expected ?? null,
      expected_source: promoPrice != null ? 'promo' : 'map',
      map: p.map_cad ?? null,
      price_diff: priceDiff,
    });
  }

  // Wix products that aren't in the PIM at all (orphans on the site).
  const pimSkus = new Set((prods ?? []).map((p) => p.sku));
  const orphans = wixProducts
    .filter((w) => w.sku && !pimSkus.has(w.sku))
    .map((w) => ({ sku: w.sku, wix_id: w.id, state: 'not_in_pim', name: w.name }));

  await supabase.from('channel_health').insert({
    channel: 'wix',
    target: 'wixapis.com',
    total,
    in_sync: inSync,
    with_diffs: priceDiffs,
    errors: broken,
    partial: false,
    top_offenders: results.filter((r) => r.state === 'missing' || r.price_diff).slice(0, 10),
    results: [...results, ...orphans],
  });

  return { total, linked: linked.length, inSync, priceDiffs, broken, orphans: orphans.length };
}
