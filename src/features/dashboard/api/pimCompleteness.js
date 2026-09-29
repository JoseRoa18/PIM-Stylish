import { loadCatalogWithMedia } from './catalogWithMedia';
import { scoreCompleteness, summarizeByCategory } from '@/features/products/lib/completeness';

/**
 * PIM data completeness, computed LIVE from the catalog on every call —
 * no snapshot, no cron: whatever was just edited is reflected immediately.
 * Archived products are left out (they are not being completed).
 */
export async function computePimCompleteness() {
  // Shared with the Listing Health scoring on the same page (one catalog
  // download instead of two); already in SKU order from the database.
  const products = (await loadCatalogWithMedia()).filter((p) => p.workflow_status !== 'archived');

  const rows = (products ?? []).map((p) => {
    const { product_media: media, ...product } = p;
    return {
      sku: product.sku,
      model_name: product.model_name,
      brand: product.brand,
      category: product.category,
      workflow_status: product.workflow_status,
      result: scoreCompleteness(product, media ?? []),
    };
  });

  const categories = summarizeByCategory(rows);
  const total = rows.length;
  const complete = rows.filter((r) => r.result.complete).length;
  return {
    rows,
    categories,
    totals: {
      total,
      complete,
      pct: total ? Math.round((complete / total) * 100) : 0,
      avg: total ? Math.round(rows.reduce((s, r) => s + r.result.score, 0) / total) : 0,
    },
    computedAt: new Date(),
  };
}
