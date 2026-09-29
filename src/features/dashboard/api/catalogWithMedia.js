import { supabase } from '@/lib/supabase';

// The whole catalog with each product's media rows — what the Listing Health
// scoring and the PIM completeness panel both read. Listing Health used to
// download it twice at the same time (once per panel); a load is now shared
// for a few seconds (performance pass 2026-09-29). Ordered by SKU in the
// database, so completeness keeps exactly its former order.
const TTL_MS = 15000;
let cache = null; // { at, promise }

const MEDIA_COLUMNS = 'id, storage_path, media_type, is_primary, display_order, image_role, language, document_type';

export function loadCatalogWithMedia() {
  if (!cache || Date.now() - cache.at >= TTL_MS) {
    const promise = supabase
      .from('products')
      .select(`*, product_media (${MEDIA_COLUMNS})`)
      .order('sku')
      .then(({ data, error }) => {
        if (error) throw error;
        return data ?? [];
      });
    cache = { at: Date.now(), promise };
    promise.catch(() => { if (cache?.promise === promise) cache = null; });
  }
  // Each caller gets its own product objects and media arrays, so one
  // panel's scoring can never change what the other reads.
  return cache.promise.then((rows) => rows.map((p) => ({ ...p, product_media: [...(p.product_media ?? [])] })));
}
