import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

// Best Buy Canada (Mirakl). Reads pull the seller's offers; the ONLY write is
// product CONTENT via the bestbuy-push-content edge function (P41 import) —
// PRICES are never pushed (explicit user rule, 2026-07-31), and the edge
// function rejects any row that carries a price column.

async function invokeFn(name, body = {}) {
  const { data, error } = await supabase.functions.invoke(name, { body });
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
  return data;
}

async function invokeBestBuy(body = {}) {
  return invokeFn('bestbuy-pull-offers', body);
}

/**
 * Pull the seller's Best Buy offers and persist a channel_health snapshot
 * (read-only against Best Buy; the snapshot lives in our own DB) so
 * Listing Health can score against it instantly.
 */
export async function refreshBestBuyOffers() {
  const { total, offers } = await invokeBestBuy();

  // Enrich the snapshot with PIM MSRPs so price mismatches are self-contained.
  const { data: prods, error } = await supabase.from('products').select('sku, msrp_cad');
  if (error) throw error;
  const msrpBySku = new Map((prods ?? []).map((p) => [p.sku, p.msrp_cad]));

  const results = offers.map((o) => ({
    ...o,
    msrp: msrpBySku.get(o.sku) ?? null,
  }));
  const priceMismatches = results.filter(
    (o) => o.msrp != null && o.price != null && Math.abs(o.price - o.msrp) > 0.01,
  ).length;

  await supabase.from('channel_health').insert({
    channel: 'bestbuy',
    target: 'marketplace.bestbuy.ca',
    total,
    in_sync: results.filter((o) => o.active).length,
    with_diffs: priceMismatches,
    errors: results.filter((o) => (o.quantity ?? 0) === 0).length,
    partial: false,
    results,
  });

  return { total, priceMismatches };
}

// ---------------------------------------------------------------------------
// Content push (P41). Categories whose only extra requirement is Product
// Condition — always "Brand New" for our regular catalog. Accessories
// (CAT_314937) also demand accessory-type and dishwasher-safe values we can't
// derive truthfully from the PIM, so they sit out of v1.
const CONDITION_ONLY_CATS = new Set(['CAT_660943', 'CAT_37129', 'CAT_328963']);

const stripHtml = (h) =>
  String(h ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Everything the push card needs: which listed products CAN be pushed (and
 * with what content), and which can't yet (with the reason). A product is
 * pushable when it has a Best Buy offer, a supported category, a UPC on the
 * offer (the identity anchor — deliberately Best Buy's, not the PIM's, so a
 * placeholder UPC in the PIM can't break the match), a PIM title, a
 * description and at least one image.
 */
export async function loadBestBuyPushCandidates() {
  const { data: snaps, error: snapErr } = await supabase
    .from('channel_health')
    .select('run_at, results')
    .eq('channel', 'bestbuy')
    .order('run_at', { ascending: false })
    .limit(1);
  if (snapErr) throw snapErr;
  const snap = snaps?.[0];
  if (!snap?.results?.length) return { runAt: null, pushable: [], excluded: [] };

  const offers = snap.results.filter((o) => o.sku);
  const skus = offers.map((o) => o.sku);

  // PostgREST caps unfiltered selects — always filter by the SKUs we need.
  const [{ data: prods, error: prodErr }, { data: media, error: mediaErr }] = await Promise.all([
    supabase
      .from('products')
      .select('sku, brand, description, attributes')
      .in('sku', skus),
    supabase
      .from('product_media')
      .select('sku, storage_path, is_primary, display_order')
      .eq('media_type', 'image')
      .in('sku', skus)
      .order('is_primary', { ascending: false })
      .order('display_order', { ascending: true }),
  ]);
  if (prodErr) throw prodErr;
  if (mediaErr) throw mediaErr;

  const bySku = new Map((prods ?? []).map((p) => [p.sku, p]));
  const imagesBySku = new Map();
  for (const m of media ?? []) {
    if (!imagesBySku.has(m.sku)) imagesBySku.set(m.sku, []);
    imagesBySku.get(m.sku).push(m.storage_path);
  }

  const pushable = [];
  const excluded = [];
  for (const offer of offers) {
    const pim = bySku.get(offer.sku);
    if (!pim) continue; // Best Buy-only offers (open box etc.) are not ours to push
    const skip = (reason) => excluded.push({ sku: offer.sku, reason });

    if (!CONDITION_ONLY_CATS.has(offer.category_code)) {
      skip('accessory category — needs manual attributes (not in v1)');
      continue;
    }
    if (!offer.upc) { skip('no UPC on the Best Buy offer'); continue; }
    const title = pim.attributes?.general_title_en?.trim();
    if (!title) { skip('no General Title (EN) in the PIM'); continue; }
    const shortDesc = stripHtml(pim.attributes?.marketing_copy || pim.description).slice(0, 500);
    if (!shortDesc) { skip('no description in the PIM'); continue; }
    const images = imagesBySku.get(offer.sku) ?? [];
    if (!images.length) { skip('no images in the PIM'); continue; }

    pushable.push({
      sku: offer.sku,
      bbTitle: offer.product_title ?? '',
      pimTitle: title,
      row: {
        BBYCat: offer.category_code,
        shop_sku: offer.sku,
        _Title_BB_Category_Root_EN: title,
        _Short_Description_BB_Category_Root_EN: shortDesc,
        _Long_Description_BB_Category_Root_EN: stripHtml(pim.description).slice(0, 4000),
        _Brand_Name_Category_Root_EN: /azuni/i.test(pim.brand ?? '') ? 'AZUNI' : 'Stylish',
        _Primary_UPC_Category_Root_EN: offer.upc,
        _Model_Number_Category_Root_EN: offer.sku,
        _Manufacturers_Part_Number_Category_Root_EN: offer.sku,
        [`_ProductCondition_20257570_${offer.category_code}_EN`]: 'Brand New',
        ...Object.fromEntries(
          images.slice(0, 5).map((url, i) => [`_MP_Source_Image_URL_0${i + 1}_Category_Root_EN`, url]),
        ),
      },
    });
  }

  return { runAt: snap.run_at, pushable, excluded };
}

/**
 * Push content rows to Best Buy in chunks (the edge function caps 50/call).
 * Returns aggregate transformation results; Best Buy's own QC applies the
 * content asynchronously afterwards.
 */
export async function pushBestBuyContent(candidates, { onProgress } = {}) {
  const CHUNK = 50;
  const imports = [];
  let linesOk = 0;
  let linesError = 0;
  let errorsText = '';

  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    const data = await invokeFn('bestbuy-push-content', { rows: chunk.map((c) => c.row) });
    imports.push(data.import_id);
    linesOk += data.lines_ok ?? 0;
    linesError += data.lines_error ?? 0;
    if (data.transformation_errors) errorsText += data.transformation_errors + '\n';
    onProgress?.(Math.min(i + CHUNK, candidates.length), candidates.length);
  }

  logActivity({
    action: 'sync',
    entityType: 'product',
    entityId: candidates.length === 1 ? candidates[0].sku : `${candidates.length} products`,
    target: 'marketplace.bestbuy.ca',
    summary: `Pushed content to Best Buy for ${candidates.length} product${candidates.length === 1 ? '' : 's'}`,
    metadata: { skus: candidates.map((c) => c.sku), imports },
  });

  return { imports, linesOk, linesError, errorsText };
}
