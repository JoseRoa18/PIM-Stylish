import { useMemo } from 'react';

/**
 * Filter products client-side based on search term + multi-select filters.
 * For ~50 products, in-memory filtering is faster and simpler than re-querying.
 */
export function useFilteredProducts(products, { searchTerm, filters }) {
  return useMemo(() => {
    if (!products) return [];

    let result = products;

    // Text search across SKU, model_name, family_number, factory_code
    if (searchTerm && searchTerm.trim()) {
      const term = searchTerm.trim().toLowerCase();
      result = result.filter((p) => {
        const haystack = [
          p.sku,
          p.model_name,
          p.family_number,
          p.factory_code,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(term);
      });
    }

    // Multi-select filters — if any values selected for a field, product must match one
    const filterFields = ['brand', 'category', 'series', 'material'];
    filterFields.forEach((field) => {
      const selected = filters[field];
      if (selected && selected.length > 0) {
        result = result.filter((p) => selected.includes(p[field]));
      }
    });

    return result;
  }, [products, searchTerm, filters]);
}

/**
 * Derive unique filter options from the full product list.
 * As products are added, filter dropdowns auto-populate with new values.
 */
export function getFilterOptions(products) {
  const empty = { brand: [], category: [], series: [], material: [] };
  if (!products) return empty;

  const collect = (field) => {
    const values = new Set();
    products.forEach((p) => {
      if (p[field]) values.add(p[field]);
    });
    return Array.from(values).sort();
  };

  return {
    brand: collect('brand'),
    category: collect('category'),
    series: collect('series'),
    material: collect('material'),
  };
}