import { loadCatalogWithMedia } from './catalogWithMedia';
import { completenessContext, scoreCompleteness } from '@/features/products/lib/completeness';

/**
 * PIM data completeness, computed LIVE from the catalog on every call —
 * no snapshot, no cron: whatever was just edited is reflected immediately.
 * Archived products are left out (they are not being completed). Returns the
 * scored rows; the panel groups them (by category / by field) for the brand
 * on screen.
 */
export async function computePimCompleteness() {
  // Shared with the Listing Health scoring on the same page (one catalog
  // download instead of two); already in SKU order from the database.
  const products = (await loadCatalogWithMedia()).filter((p) => p.workflow_status !== 'archived');
  const ctx = completenessContext(products); // a UPC on two products fails both

  const rows = (products ?? []).map((p) => {
    const { product_media: media, ...product } = p;
    return {
      sku: product.sku,
      model_name: product.model_name,
      brand: product.brand,
      category: product.category,
      workflow_status: product.workflow_status,
      result: scoreCompleteness(product, media ?? [], ctx),
    };
  });

  return { rows, computedAt: new Date() };
}
