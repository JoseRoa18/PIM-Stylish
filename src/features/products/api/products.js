import { supabase } from '@/lib/supabase';

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
      workflow_status,
      msrp_cad,
      created_at,
      wix_product_id,
      product_media (storage_path, alt_text, is_primary)
    `)
    .order('created_at', { ascending: false });

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
      workflow_status: p.workflow_status,
      msrp_cad: p.msrp_cad,
      created_at: p.created_at,
      wix_product_id: p.wix_product_id,
      primary_image: primary,
    };
  });
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
  return data ?? [];
}