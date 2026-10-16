import { loadCatalogWithMedia } from './catalogWithMedia';
import { completenessContext, inCompleteness, scoreCompleteness } from '@/features/products/lib/completeness';

/**
 * PIM data completeness, computed LIVE from the catalog on every call —
 * no snapshot, no cron: whatever was just edited is reflected immediately.
 * Archived products are left out (they are not being completed), and so are
 * obsolete ones (user, 2026-10-16). Returns the scored rows; the panel groups
 * them (by category / by field) for the brand on screen. `obsoleteLeftOut`
 * lists the obsolete products ({ sku, brand }) so the panel can say how many
 * it left out.
 */
export async function computePimCompleteness() {
  // Shared with the Listing Health scoring on the same page (one catalog
  // download instead of two); already in SKU order from the database.
  const products = (await loadCatalogWithMedia()).filter((p) => p.workflow_status !== 'archived');
  // Every non-archived product, obsolete ones included: a UPC on two products
  // fails both, even when one of them is no longer scored.
  const ctx = completenessContext(products);

  const rows = products.filter(inCompleteness).map((p) => {
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
  const obsoleteLeftOut = products.filter((p) => p.is_obsolete).map((p) => ({ sku: p.sku, brand: p.brand }));

  return { rows, obsoleteLeftOut, computedAt: new Date() };
}
