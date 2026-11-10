import { supabase } from '@/lib/supabase';
import { insertSnapshot, latestSnapshotItem } from '@/features/syndication/lib/channels';
import { isExcluded } from '../lib/marketplaces';
import { buildBestBuyRow, defaultBestBuyCategory } from '../lib/bestbuyContent';
import { logActivity } from '@/features/activity/api/activityLog';
import { priceOff } from '@/features/pricing/lib/priceTolerance';

// Best Buy Canada (Mirakl). Reads pull the seller's offers; writes are
// product CONTENT via bestbuy-push-content (P41 import) and — since the
// no-price-push rule was lifted 2026-08-16 — offer PRICES via
// bestbuy-push-price (OF24 import, price/discount fields only). Every push
// is manual and confirmed by the user; nothing runs from crons.

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

// What buildBestBuyRow reads of a product.
const PRODUCT_COLUMNS = 'sku, brand, model_name, category, color, finish, material, series, product_type, description, attributes, channel_exclusions';

async function invokeBestBuy(body = {}) {
  return invokeFn('bestbuy-pull-offers', body);
}

/**
 * Push offer prices to Best Buy (OF24 — async Mirakl import). Each update
 * carries only price and/or a scheduled discount; content, stock and state
 * are never touched. `dryRun: true` returns the exact Mirakl payload without
 * submitting anything — the preview the alignment tab shows before a push.
 * `protectRunning: { start, end }` leaves out offers running another
 * promotion's discount right now (one began outside that window); an update
 * with `clear_discount: { start, end }` drops a discount that began in it.
 */
export async function pushBestBuyPrices(updates, { dryRun = false, protectRunning = null } = {}) {
  const data = await invokeFn('bestbuy-push-price', { updates, dryRun, ...(protectRunning ? { protect_running: protectRunning } : {}) });
  if (!dryRun) {
    logActivity({
      action: 'push',
      entityType: 'product',
      entityId: updates.length === 1 ? updates[0].sku : `${updates.length} products`,
      target: 'bestbuy',
      summary: `Pushed ${updates.length} price${updates.length === 1 ? '' : 's'} to Best Buy (import ${data.import_id ?? '?'})`,
      metadata: {
        count: updates.length,
        import_id: data.import_id ?? null,
        lines_in_error: data.lines_in_error ?? 0,
        skus: updates.map((u) => u.sku).slice(0, 50),
      },
    });
  }
  return data;
}

/**
 * Pull the seller's Best Buy offers and persist a channel_health snapshot
 * (read-only against Best Buy; the snapshot lives in our own DB) so
 * Listing Health can score against it instantly. `task` (optional
 * taskProgress reporter): the pull (one call, 70%), the MSRPs, the snapshot.
 */
export async function refreshBestBuyOffers({ task = null } = {}) {
  if (task) await task.step('Pulling the Best Buy offers…');
  const { total, offers } = await invokeBestBuy();

  // Enrich the snapshot with the PIM's MAP CAD — what Best Buy sells at — so price
  // mismatches are self-contained (they were measured against the MSRP until 2026-11-10).
  task?.progress(0.7, `Reading the PIM prices for ${offers.length} offers…`);
  const { data: prods, error } = await supabase.from('products').select('sku, map_cad');
  if (error) throw error;
  const mapBySku = new Map((prods ?? []).map((p) => [p.sku, p.map_cad]));

  const results = offers.map((o) => ({
    ...o,
    map: mapBySku.get(o.sku) ?? null,
  }));
  // `origin_price`: the offer's own price; `price` is the discounted one while a promotion runs.
  const priceMismatches = results.filter((o) => o.map != null && (o.origin_price ?? o.price) != null && priceOff(Number(o.origin_price ?? o.price), Number(o.map))).length;

  task?.progress(0.85, 'Saving the snapshot…');
  await insertSnapshot({
    channel: 'bestbuy',
    target: 'marketplace.bestbuy.ca',
    total,
    in_sync: results.filter((o) => o.active).length,
    with_diffs: priceMismatches,
    errors: results.filter((o) => (o.quantity ?? 0) === 0).length,
    partial: false,
    results,
  });
  task?.progress(1);

  return { total, priceMismatches };
}

// ---------------------------------------------------------------------------
// Content push (P41): one row per product, built by lib/bestbuyContent.js from
// the attributes Best Buy asks for in the offer's category.

// The image rows per SKU, primary first then display order. The API returns at
// most 1,000 rows a query and the ~450 Best Buy offers carry ~5,300 images,
// so a single query left most SKUs looking image-less and they were skipped
// as "no images in the PIM" (found 2026-09-29). 20 SKUs a query stays under
// the cap (a product has at most ~46 media rows); a query that still reaches
// it is redone SKU by SKU.
async function imagesForSkus(skus, task = null) {
  const CAP = 1000;
  const imagesBySku = new Map();
  const query = (part) => supabase
    .from('product_media')
    .select('sku, storage_path, is_primary, display_order, language, image_role')
    .eq('media_type', 'image')
    .in('sku', part)
    .order('is_primary', { ascending: false })
    .order('display_order', { ascending: true });
  const add = (rows) => {
    for (const m of rows ?? []) {
      if (!imagesBySku.has(m.sku)) imagesBySku.set(m.sku, []);
      imagesBySku.get(m.sku).push(m);
    }
  };
  const chunks = [];
  for (let i = 0; i < skus.length; i += 20) chunks.push(skus.slice(i, i + 20));
  let settled = 0;
  const results = await Promise.all(chunks.map(async (part) => {
    const { data, error } = await query(part);
    if (error) throw error;
    const rows = (data ?? []).length < CAP ? [data] : await Promise.all(part.map(async (sku) => {
      const one = await query([sku]);
      if (one.error) throw one.error;
      return one.data;
    }));
    settled += 1;
    task?.count(settled, chunks.length, `Reading the images… (${settled} of ${chunks.length})`);
    return rows;
  }));
  // Chunk order kept, so each SKU's images stay primary-first, display order.
  for (const group of results) for (const rows of group) add(rows);
  return imagesBySku;
}

/**
 * Everything the push card needs: which listed products CAN be pushed (and
 * with what content), and which can't yet (with the reason). A product is
 * pushable when it has a Best Buy offer in a mapped category, a UPC on the
 * offer (the identity anchor — deliberately Best Buy's, not the PIM's, so a
 * placeholder UPC in the PIM can't break the match), a PIM title, a
 * description and at least one image.
 * `task` (optional taskProgress reporter): the snapshot 30%, the PIM reads 70%.
 */
export async function loadBestBuyPushCandidates({ task = null } = {}) {
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
  task?.progress(0.3, `Reading ${skus.length} products and their images…`);

  // PostgREST caps unfiltered selects — always filter by the SKUs we need.
  const [{ data: prods, error: prodErr }, imagesBySku] = await Promise.all([
    supabase
      .from('products')
      .select(PRODUCT_COLUMNS)
      .in('sku', skus),
    imagesForSkus(skus, task?.part(0.3, 1)),
  ]);
  if (prodErr) throw prodErr;

  const bySku = new Map((prods ?? []).map((p) => [p.sku, p]));

  const pushable = [];
  const excluded = [];
  for (const offer of offers) {
    const pim = bySku.get(offer.sku);
    if (!pim) continue; // Best Buy-only offers (open box etc.) are not ours to push
    const skip = (reason) => excluded.push({ sku: offer.sku, reason });

    // Marketplace exclusion (rule 2026-09-22): switched-off products are never pushed.
    if (isExcluded(pim, 'bestbuy')) { skip('excluded from Best Buy Canada (product switch)'); continue; }
    const built = buildBestBuyRow(pim, offer, imagesBySku.get(offer.sku) ?? []);
    if (!built.row) { skip(built.problems.join('; ')); continue; }

    pushable.push({
      sku: offer.sku,
      bbTitle: offer.product_title ?? '',
      pimTitle: built.fields.find((f) => f.key === 'title')?.value ?? '',
      row: built.row,
    });
  }

  return { runAt: snap.run_at, pushable, excluded };
}

/**
 * Push content rows to Best Buy in chunks (the edge function caps 50/call).
 * Rows with the same columns travel together: a file has one set of columns,
 * and an empty cell could wipe what Best Buy holds for a field the PIM has no
 * value for. Returns aggregate transformation results; Best Buy's own QC
 * applies the content asynchronously afterwards.
 */
export async function pushBestBuyContent(candidates, { onProgress } = {}) {
  const CHUNK = 50;
  const imports = [];
  let linesOk = 0;
  let linesError = 0;
  let errorsText = '';

  const groups = new Map();
  for (const c of candidates) {
    const key = Object.keys(c.row).sort().join();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  let done = 0;
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += CHUNK) {
      const chunk = group.slice(i, i + CHUNK);
      const data = await invokeFn('bestbuy-push-content', { rows: chunk.map((c) => c.row) });
      imports.push(data.import_id);
      linesOk += data.lines_ok ?? 0;
      linesError += data.lines_error ?? 0;
      if (data.transformation_errors) errorsText += data.transformation_errors + '\n';
      done += chunk.length;
      onProgress?.(done, candidates.length);
    }
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

/**
 * One product's content for Best Buy, for its card and its push. With an offer:
 * the row a push would send. Without one (it may be newer than the snapshot, so
 * Best Buy is asked): whether Best Buy's catalog already has its UPC, what the
 * PIM proposes for the offer, and the row that would create the product in
 * `category` (`defaultBestBuyCategory` unless the person chose another).
 */
export async function loadBestBuyContent(sku, { category = null } = {}) {
  const [snapshotOffer, { data: product, error: prodErr }, { data: images, error: mediaErr }, { data: listing, error: listingErr }] = await Promise.all([
    latestSnapshotItem('bestbuy', sku),
    supabase.from('products').select(PRODUCT_COLUMNS).eq('sku', sku).maybeSingle(),
    supabase.from('product_media').select('storage_path, is_primary, display_order, language, image_role').eq('sku', sku).eq('media_type', 'image')
      .order('is_primary', { ascending: false }).order('display_order', { ascending: true }),
    supabase.from('bestbuy_new_listings').select('*').eq('sku', sku).maybeSingle(),
  ]);
  if (prodErr) throw prodErr;
  if (mediaErr) throw mediaErr;
  if (listingErr) throw listingErr;
  if (!product) throw new Error(`${sku} is not in the PIM.`);
  const lookup = snapshotOffer ? null : await invokeFn('bestbuy-new-listing', { mode: 'lookup', sku });
  const offer = snapshotOffer ?? lookup?.offer ?? null;
  if (offer) return { offer, product, listing: listing ?? null, built: buildBestBuyRow(product, offer, images ?? []) };
  const chosen = category ?? listing?.category_code ?? defaultBestBuyCategory(product);
  return {
    offer: null,
    product,
    listing: listing ?? null,
    catalog: lookup.catalog,
    mismatch: lookup.mismatch,
    plan: lookup.plan,
    category: chosen,
    built: lookup.catalog ? null : buildBestBuyRow(product, { category_code: chosen, upc: product.attributes?.upc ?? null, product_brand: null }, images ?? []),
  };
}

/**
 * A person's click: the product into Best Buy's catalog, for its review. Best
 * Buy takes no offer until it has the product: `offer` asks for it, and it goes
 * at the first check after Best Buy approves it.
 */
export async function createBestBuyProduct(sku, category, { offer: withOffer = false, task = null } = {}) {
  task?.progress(0.05, 'Reading the product…');
  const { offer, product, built, catalog } = await loadBestBuyContent(sku, { category });
  if (offer) throw new Error(`${sku} already has an offer on Best Buy: push it to update it.`);
  if (catalog) throw new Error('Best Buy already has this product: only the offer is missing.');
  if (isExcluded(product, 'bestbuy')) throw new Error(`${sku} is excluded from Best Buy Canada.`);
  if (!built.row) throw new Error(`${sku} can't go to Best Buy yet: ${built.problems.join('; ')}.`);
  task?.progress(0.2, 'Best Buy is checking the file…');
  const data = await invokeFn('bestbuy-new-listing', { mode: 'create', sku, row: built.row, offer: withOffer });
  if (!data.ok) throw new Error(`Best Buy refused it: ${data.note ?? `import ${data.import_id}`}`);
  return { importId: data.import_id, status: data.status };
}

/** A person's click: the offer now, MAP Blue and warranty 0 (the function reads them from the PIM). */
export async function createBestBuyOffer(sku) {
  const data = await invokeFn('bestbuy-new-listing', { mode: 'offer', sku });
  return { importId: data.import_id, status: data.status };
}

/** A product in Best Buy's review: ask for its offer once approved, or stop asking. */
export const setBestBuyOfferWanted = (sku, want) => invokeFn('bestbuy-new-listing', { mode: 'want_offer', sku, want });

/** Follows the listings under way: how Best Buy answered, and the offer that was asked for once approved. */
export const checkBestBuyListings = (sku = null) => invokeFn('bestbuy-new-listing', { mode: 'check', ...(sku ? { sku } : {}) });

/** Every PIM product with no offer on Best Buy, for the person to choose from. Reads only. */
export async function loadBestBuyCandidates() {
  const { candidates } = await invokeFn('bestbuy-new-listing', { mode: 'candidates' });
  return candidates;
}

/**
 * "Push Best Buy" on the product page: the product's content, as the PIM
 * recommends it. Best Buy checks the file at once (a refusal comes back here)
 * and its QC applies it later. Prices, stock and the offer never travel.
 */
export async function pushProductToBestBuy(sku, { task = null } = {}) {
  task?.progress(0.05, 'Reading the product…');
  const { offer, product, built } = await loadBestBuyContent(sku);
  if (!offer) throw new Error(`${sku} has no offer on Best Buy.`);
  if (isExcluded(product, 'bestbuy')) throw new Error(`${sku} is excluded from Best Buy Canada.`);
  if (!built.row) throw new Error(`${sku} can't go to Best Buy yet: ${built.problems.join('; ')}.`);
  task?.progress(0.2, 'Best Buy is checking the file…');
  const data = await invokeFn('bestbuy-push-content', { rows: [built.row] });
  if (!data.ok || (data.lines_error ?? 0) > 0) throw new Error(`Best Buy refused it: ${data.transformation_errors ?? `import ${data.import_id}`}`);
  logActivity({
    action: 'push',
    entityType: 'product',
    entityId: sku,
    target: 'marketplace.bestbuy.ca',
    summary: `Pushed the content of ${sku} to Best Buy (import ${data.import_id}) — accepted as the PIM recommends`,
    metadata: { imports: [data.import_id], status: data.status, fields: built.fields.map((f) => f.key), images: built.images.length },
  });
  return { importId: data.import_id, status: data.status };
}
