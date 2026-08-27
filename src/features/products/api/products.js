import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { deleteStorageObjectsIfUnreferenced } from '@/features/media/api/media';
import { formatFieldList } from '@/lib/humanize';
import { autoLinkChannels } from '@/features/syndication/api/autoLink';

/**
 * List all products from the catalog with their primary image (if any).
 * Returns scalar columns useful for the table view.
 */
export async function listProducts() {
  const { data, error } = await supabase
    .from('products')
    .select(`
      sku,
      model_name,
      family_number,
      brand,
      category,
      series,
      material,
      workflow_status,
      msrp_cad,
      created_at,
      wix_product_id,
      product_media (storage_path, alt_text, is_primary)
    `)
    // Only the primary image is shown in the table, so filter the embed
    // server-side — without this, every media row (all photos + the
    // family-shared videos/docs on each variant) rides along in the payload.
    .eq('product_media.is_primary', true)
    // Bulk-imported products share a created_at; without a tie-breaker
    // Postgres returns ties in whatever order it likes, so the catalog
    // appeared to shuffle between visits.
    .order('created_at', { ascending: false })
    .order('sku', { ascending: true });

  if (error) throw error;

  // Flatten: extract just the primary image for each product
  return (data ?? []).map((p) => {
    const primary = p.product_media?.find((m) => m.is_primary) ?? null;
    return {
      sku: p.sku,
      model_name: p.model_name,
      family_number: p.family_number,
      brand: p.brand,
      category: p.category,
      series: p.series,
      material: p.material,
      workflow_status: p.workflow_status,
      msrp_cad: p.msrp_cad,
      created_at: p.created_at,
      wix_product_id: p.wix_product_id,
      primary_image: primary,
    };
  });
}

/**
 * Create a new product. `sku`, `brand`, and `category` are required by the
 * schema (NOT NULL). Everything else can be filled later via inline editing
 * on the product detail page.
 */
export async function createProduct({ sku, model_name, brand, category, series, family_number, msrp_cad }) {
  const row = {
    sku: sku.trim(),
    brand: brand.trim(),
    category,
    workflow_status: 'new',
    attributes: {},
  };
  if (model_name?.trim()) row.model_name = model_name.trim();
  if (series?.trim()) row.series = series.trim();
  if (family_number != null && family_number !== '') {
    const n = Number(family_number);
    if (!isNaN(n)) row.family_number = n;
  }
  if (msrp_cad != null && msrp_cad !== '') {
    const n = Number(msrp_cad);
    if (!isNaN(n)) row.msrp_cad = n;
  }

  const { data, error } = await supabase
    .from('products')
    .insert(row)
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error(`A product with SKU "${row.sku}" already exists.`);
    }
    throw new Error(error.message ?? 'Failed to create product');
  }

  logActivity({
    action: 'create',
    entityType: 'product',
    entityId: data.sku,
    summary: `Created product ${data.sku}${data.model_name ? ` — ${data.model_name}` : ''}`,
    metadata: { brand: data.brand, category: data.category },
  });
  return data;
}

/**
 * Get a single product by SKU with all columns including attributes JSONB.
 */
export async function getProduct(sku) {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('sku', sku)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Search products by SKU, name, or family number (case-insensitive substring).
 * Used by the global Topbar search.
 */
// Fields that must never travel to a clone (user rule: everything copies
// EXCEPT images, UPC, SKU, and any API/channel connection): identity,
// every channel link/sync column, and system columns.
const CLONE_EXCLUDE = [
  'sku', 'created_at', 'updated_at',
  'wix_product_id', 'wix_synced_at', 'wix_raw', 'wix_collection_ids',
  'wayfair_item_group_id', 'wayfair_synced_at',
];
// Identity attributes stripped from the cloned attributes object. The UPC
// barcode is unique per product; upc_certified (plumbing code cert) stays.
const CLONE_EXCLUDE_ATTRS = ['upc'];

/**
 * Create a new product as a copy of an existing one. Copies every content
 * column (attributes, descriptions, bullets, pricing, dimensions…), resets
 * workflow to "new", and never carries channel links. Family-shared media
 * (videos/documents) is re-registered on the clone pointing at the SAME
 * storage objects — a clone joins its source's family, so per the
 * family-shared rule those files belong to it too. Images are per-variant
 * and are NOT copied.
 */
export async function cloneProduct(sourceSku, newSku, overrides = {}) {
  const source = await getProduct(sourceSku);
  if (!source) throw new Error(`Source product "${sourceSku}" not found.`);

  const row = { ...source };
  for (const key of CLONE_EXCLUDE) delete row[key];
  if (row.attributes && typeof row.attributes === 'object') {
    row.attributes = { ...row.attributes };
    for (const key of CLONE_EXCLUDE_ATTRS) delete row.attributes[key];
  }
  row.sku = newSku.trim();
  row.workflow_status = 'new';
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) row[key] = value;
  }

  const { data, error } = await supabase
    .from('products')
    .insert(row)
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') throw new Error(`A product with SKU "${row.sku}" already exists.`);
    throw new Error(error.message ?? 'Failed to clone product');
  }

  // Family-shared docs/videos: same storage objects, one row per variant.
  const { data: sharedMedia, error: mediaErr } = await supabase
    .from('product_media')
    .select('*')
    .eq('sku', sourceSku)
    .in('media_type', ['video', 'document']);
  if (!mediaErr && sharedMedia?.length) {
    const mediaRows = sharedMedia.map((m) => {
      const copy = { ...m, sku: data.sku };
      delete copy.id;
      delete copy.created_at;
      return copy;
    });
    const { error: insErr } = await supabase.from('product_media').insert(mediaRows);
    if (insErr) console.error('Clone: family-shared media copy failed (non-fatal):', insErr);
  }

  logActivity({
    action: 'create',
    entityType: 'product',
    entityId: data.sku,
    summary: `Created ${data.sku} as a clone of ${sourceSku}`,
    metadata: { cloned_from: sourceSku, shared_media: sharedMedia?.length ?? 0 },
  });
  return data;
}

export async function searchProducts(query, limit = 8) {
  const q = (query ?? '').trim();
  if (!q) return [];

  // PostgREST uses * (not %) as the ilike wildcard in URL params, and ',' as
  // the OR condition separator. The standalone .ilike() helper translates %
  // for you, but .or() passes the raw filter string through — so we must
  // build it with * directly and escape any literal *, , or \ in the input.
  const safe = q.replace(/[\\*,]/g, (c) => `\\${c}`);

  // family_number is an integer in the schema, so it can't be ilike'd.
  // If the query is purely numeric, add an exact-match filter for it.
  const orParts = [
    `sku.ilike.*${safe}*`,
    `model_name.ilike.*${safe}*`,
  ];
  if (/^\d+$/.test(q)) {
    orParts.push(`family_number.eq.${q}`);
  }

  const { data, error } = await supabase
    .from('products')
    .select(`
      sku,
      model_name,
      family_number,
      brand,
      category,
      workflow_status,
      product_media (storage_path, is_primary)
    `)
    .eq('product_media.is_primary', true)
    .or(orParts.join(','))
    .limit(limit);

  if (error) throw error;

  return (data ?? []).map((p) => ({
    sku: p.sku,
    model_name: p.model_name,
    family_number: p.family_number,
    brand: p.brand,
    category: p.category,
    workflow_status: p.workflow_status,
    primary_image: p.product_media?.find((m) => m.is_primary) ?? null,
  }));
}

/**
 * Patch a product. Only the keys in `patch` are sent to Supabase.
 */
export async function updateProduct(sku, patch) {
  const { data, error } = await supabase
    .from('products')
    .update(patch)
    .eq('sku', sku)
    .select('*')
    .maybeSingle();

  if (error) throw error;

  const changedKeys = Object.keys(patch ?? {});
  logActivity({
    action: 'update',
    entityType: 'product',
    entityId: sku,
    summary: `Edited product ${sku}${changedKeys.length ? ` (${formatFieldList(changedKeys)})` : ''}`,
    metadata: { fields: changedKeys },
  });
  // Ready to Sell refreshes channel links (adopt listings that already exist,
  // by SKU). It NEVER creates or publishes anything — publishing is always an
  // explicit user action (rule 2026-08-21). Fire-and-forget — results land in
  // the Activity Log.
  if (patch?.workflow_status === 'ready_to_sell') {
    autoLinkChannels(sku).catch((err) => console.error('Channel auto-link failed:', err));
  }
  return data;
}

/**
 * List products that share a family number — used to surface variants
 * of the same sink design (different color, gauge, accessories, etc.).
 */
export async function listVariants(familyNumber, excludeSku = null) {
  if (familyNumber == null) return [];
  let query = supabase
    .from('products')
    .select(`
      sku,
      model_name,
      brand,
      material,
      finish,
      color,
      msrp_cad,
      attributes,
      product_media (storage_path, is_primary)
    `)
    .eq('product_media.is_primary', true)
    .eq('family_number', familyNumber);
  if (excludeSku) query = query.neq('sku', excludeSku);

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((p) => ({
    ...p,
    primary_image: p.product_media?.find((m) => m.is_primary) ?? null,
  }));
}

/**
 * Apply the same patch to many products at once.
 */
export async function bulkUpdateProducts(skus, patch) {
  if (!skus?.length) return [];
  const { data, error } = await supabase
    .from('products')
    .update(patch)
    .in('sku', skus)
    .select('*');

  if (error) throw error;

  const changedKeys = Object.keys(patch ?? {});
  logActivity({
    action: 'update',
    entityType: 'product',
    entityId: skus.length === 1 ? skus[0] : `${skus.length} products`,
    summary: `Bulk-edited ${skus.length} ${skus.length === 1 ? 'product' : 'products'}${changedKeys.length ? ` (${formatFieldList(changedKeys)})` : ''}`,
    metadata: { count: skus.length, fields: changedKeys, skus },
  });
  // Same Ready-to-Sell link refresh as updateProduct, for the whole batch.
  if (patch?.workflow_status === 'ready_to_sell') {
    autoLinkChannels(skus).catch((err) => console.error('Channel auto-link failed:', err));
  }
  return data ?? [];
}

/**
 * Permanently delete products from the PIM. product_media rows cascade with
 * the FK; their Supabase-hosted files (images, documents, videos) are removed
 * from Storage afterwards, best-effort. Channel listings (Wix, Wayfair, …)
 * are NOT touched — this only removes the PIM's copy.
 */
export async function deleteProducts(skus) {
  if (!skus?.length) return { count: 0 };

  // Collect the storage paths BEFORE deleting — the rows cascade away.
  const mediaPaths = [];
  for (let i = 0; i < skus.length; i += 40) {
    const { data } = await supabase
      .from('product_media')
      .select('storage_path')
      .in('sku', skus.slice(i, i + 40));
    for (const m of data ?? []) mediaPaths.push(m.storage_path);
  }

  const { error } = await supabase.from('products').delete().in('sku', skus);
  if (error) throw error;

  // Unreferenced-only: videos/documents are family-shared, so a file can
  // still be linked by surviving variants of the deleted product's family.
  await deleteStorageObjectsIfUnreferenced(mediaPaths);

  logActivity({
    action: 'delete',
    entityType: 'product',
    entityId: skus.length === 1 ? skus[0] : `${skus.length} products`,
    summary: `Deleted ${skus.length} ${skus.length === 1 ? 'product' : 'products'}: ${skus.slice(0, 10).join(', ')}${skus.length > 10 ? '…' : ''}`,
    metadata: { count: skus.length, skus, mediaFiles: mediaPaths.length },
  });
  return { count: skus.length };
}