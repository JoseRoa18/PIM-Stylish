import { supabase } from '@/lib/supabase';
import { getAppSetting, saveAppSetting } from './appSettings';
import { DOCS_BUCKET, deleteStorageObjectsIfUnreferenced } from '@/features/media/api/media';
import { logActivity } from '@/features/activity/api/activityLog';

/**
 * General warranty per brand (user rule 2026-09-29): one warranty document
 * for Stylish and one for Azuni, managed in Settings. Every product of the
 * brand carries it as its warranty_file (one storage object, a row per
 * product — see 20260929_brand_warranty.sql); new products get it on
 * creation by trigger.
 */
export const WARRANTY_BRANDS = ['Stylish', 'Azuni'];
const KEY = 'brand_warranty';

/** { Stylish?: {storage_path, file_name, …}, Azuni?: {…} } */
export async function getBrandWarranties() {
  return (await getAppSetting(KEY, {})) ?? {};
}

/** The general warranty of a product's brand, or null when none is set. */
export function brandWarrantyFor(warranties, brand) {
  if (!brand || !warranties) return null;
  const hit = Object.entries(warranties).find(([b]) => b.toLowerCase() === String(brand).toLowerCase());
  return hit?.[1]?.storage_path ? hit[1] : null;
}

/** How many products the brand has (for the confirmation). */
export async function countBrandProducts(brand) {
  const { count, error } = await supabase.from('products').select('sku', { count: 'exact', head: true }).ilike('brand', brand);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Upload a brand's general warranty and put it on every product of the
 * brand, replacing their current warranty file. Old files are deleted once
 * nothing references them. Returns { products } — how many carry it now.
 */
export async function setBrandWarranty(brand, file) {
  if (!file) throw new Error('No file selected.');
  if (!/\.pdf$/i.test(file.name)) throw new Error(`${file.name} is not a PDF.`);

  const rand = Math.random().toString(36).slice(2, 8);
  const path = `_warranty/${brand.toLowerCase()}-warranty-${rand}.pdf`;
  const { error: upErr } = await supabase.storage.from(DOCS_BUCKET).upload(path, file, {
    cacheControl: '2592000',
    upsert: false,
    contentType: 'application/pdf',
  });
  if (upErr) throw new Error(`Upload failed for ${file.name}: ${upErr.message}`);
  const { data: pub } = supabase.storage.from(DOCS_BUCKET).getPublicUrl(path);

  const current = await getBrandWarranties();
  const entry = {
    storage_path: pub.publicUrl,
    file_name: file.name,
    file_size_bytes: file.size ?? null,
    mime_type: 'application/pdf',
    uploaded_at: new Date().toISOString(),
  };
  await saveAppSetting(KEY, { ...current, [brand]: entry });

  const { data: old, error } = await supabase.rpc('apply_brand_warranty', { p_brand: brand });
  if (error) throw error;
  await deleteStorageObjectsIfUnreferenced((old ?? []).map((r) => r.old_path));

  const products = await countBrandProducts(brand);
  logActivity({
    action: 'media',
    entityType: 'setting',
    entityId: KEY,
    summary: `General ${brand} warranty set to ${file.name} — on all ${products} ${brand} products`,
    metadata: { brand, file_name: file.name, replaced_files: (old ?? []).length },
  });
  return { products };
}
