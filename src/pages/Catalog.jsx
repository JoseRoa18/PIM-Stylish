import { useState, useMemo, useEffect, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Plus, Upload } from 'lucide-react';
import { useProducts } from '@/features/products/hooks/useProducts';
import {
  useFilteredProducts,
  getFilterOptions,
} from '@/features/products/hooks/useFilteredProducts';
import ProductsToolbar from '@/features/products/components/ProductsToolbar';
import ProductsTable from '@/features/products/components/ProductsTable';
import BulkActionsBar from '@/features/products/components/BulkActionsBar';
import CreateProductDialog from '@/features/products/components/CreateProductDialog';

const EMPTY_FILTERS = { brand: [], category: [], series: [], material: [] };

export default function Catalog() {
  const { products, loading, error, reload } = useProducts();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get('search') ?? '');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [selectedSkus, setSelectedSkus] = useState(() => new Set());
  const [creating, setCreating] = useState(() => searchParams.get('new') === '1');

  useEffect(() => {
    const fromUrl = searchParams.get('search') ?? '';
    if (fromUrl !== searchTerm) setSearchTerm(fromUrl);
    // The sidebar's "Create Product" button lands here with ?new=1.
    if (searchParams.get('new') === '1') {
      setCreating(true);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('new');
        return next;
      }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const filteredProducts = useFilteredProducts(products, {
    searchTerm,
    filters,
  });

  const options = useMemo(() => getFilterOptions(products), [products]);

  const clearAll = () => {
    setSearchTerm('');
    setFilters(EMPTY_FILTERS);
  };

  const toggleSelect = useCallback((sku) => {
    setSelectedSkus((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(
    (checked) => {
      setSelectedSkus(() => {
        if (!checked) return new Set();
        return new Set(filteredProducts.map((p) => p.sku));
      });
    },
    [filteredProducts],
  );

  const clearSelection = useCallback(() => setSelectedSkus(new Set()), []);

  const totalCount = products?.length ?? 0;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-display-lg text-on-surface">Catalog</h1>
          <p className="text-body-md text-on-surface-variant mt-1">
            {loading
              ? 'Loading...'
              : `${totalCount} ${totalCount === 1 ? 'product' : 'products'}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/import"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md font-semibold text-on-surface hover:bg-surface-container-low transition-colors"
          >
            <Upload className="w-4 h-4" />
            Import
          </Link>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
          >
            <Plus className="w-4 h-4" />
            New Product
          </button>
        </div>
      </header>

      {!loading && !error && totalCount > 0 && (
        <ProductsToolbar
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          filters={filters}
          onFiltersChange={setFilters}
          options={options}
          resultCount={filteredProducts.length}
          totalCount={totalCount}
        />
      )}

      {!loading && !error && totalCount > 0 && filteredProducts.length === 0 ? (
        <EmptyFilterState onClearFilters={clearAll} />
      ) : (
        <ProductsTable
          products={filteredProducts}
          loading={loading}
          error={error}
          selectedSkus={selectedSkus}
          onToggleSelect={toggleSelect}
          onToggleSelectAll={toggleSelectAll}
        />
      )}

      <BulkActionsBar
        selectedSkus={selectedSkus}
        products={filteredProducts}
        onClear={clearSelection}
        onChanged={() => {
          clearSelection();
          reload();
        }}
      />

      {creating && <CreateProductDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function EmptyFilterState({ onClearFilters }) {
  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest py-16 px-6 text-center">
      <p className="text-body-lg text-on-surface mb-2">No products match your filters</p>
      <p className="text-body-md text-on-surface-variant mb-6">
        Try removing some filters or adjusting your search.
      </p>
      <button
        type="button"
        onClick={onClearFilters}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
      >
        Clear all filters
      </button>
    </div>
  );
}
