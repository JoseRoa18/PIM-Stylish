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
import Pagination from '@/components/ui/Pagination';
import { useAuth } from '@/features/auth/AuthContext';
import { statusMeta, STATUS_ORDER } from '@/features/products/lib/workflowStatus';

const DEFAULT_PAGE_SIZE = 25;

// How each sortable column reads its value off a product row.
const SORT_ACCESSORS = {
  sku: (p) => p.sku,
  model: (p) => p.model_name,
  brand: (p) => p.brand,
  category: (p) => p.category,
  status: (p) => p.workflow_status,
  msrp: (p) => p.msrp_cad,
};

const parseList = (v) => (v ? v.split(',').filter(Boolean) : []);

export default function Catalog() {
  const { canEdit } = useAuth();
  const { products, loading, error, reload } = useProducts();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedSkus, setSelectedSkus] = useState(() => new Set());
  const [creating, setCreating] = useState(() => searchParams.get('new') === '1');

  // The URL is the single source of truth for search, filters, sort, and
  // pagination — so a filtered/sorted view can be shared, bookmarked, and
  // survives a refresh (Deep Linking).
  const searchTerm = searchParams.get('search') ?? '';
  const filters = useMemo(
    () => ({
      brand: parseList(searchParams.get('brand')),
      category: parseList(searchParams.get('category')),
      series: parseList(searchParams.get('series')),
      material: parseList(searchParams.get('material')),
    }),
    [searchParams],
  );
  const statusFilter = searchParams.get('status') ?? '';
  const sortKey = searchParams.get('sort') ?? '';
  const sortDir = searchParams.get('dir') === 'desc' ? 'desc' : 'asc';
  const pageSize = Number(searchParams.get('size')) || DEFAULT_PAGE_SIZE;
  const pageParam = Math.max(1, Number(searchParams.get('page')) || 1);

  // Merge a set of params into the URL. null/empty values are removed.
  const patchParams = useCallback(
    (patch) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            const empty =
              v == null || v === '' || (Array.isArray(v) && v.length === 0);
            if (empty) next.delete(k);
            else next.set(k, Array.isArray(v) ? v.join(',') : String(v));
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // The sidebar's "Create Product" button lands here with ?new=1. Sync that
  // one-shot URL trigger into the dialog state, then strip it from the URL.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCreating(true);
      patchParams({ new: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Any change that reshapes the result set resets to page 1.
  const setSearchTerm = (v) => patchParams({ search: v || null, page: null });
  const onFiltersChange = (next) =>
    patchParams({
      brand: next.brand,
      category: next.category,
      series: next.series,
      material: next.material,
      page: null,
    });
  const onSort = (key) => {
    if (sortKey === key) patchParams({ dir: sortDir === 'asc' ? 'desc' : 'asc' });
    else patchParams({ sort: key, dir: 'asc' });
  };
  const setPage = (p) => patchParams({ page: p <= 1 ? null : p });
  const setPageSize = (s) =>
    patchParams({ size: s === DEFAULT_PAGE_SIZE ? null : s, page: null });
  const toggleStatus = (key) =>
    patchParams({ status: statusFilter === key ? null : key, page: null });
  const clearFilters = () =>
    patchParams({
      search: null, brand: null, category: null, series: null, material: null,
      status: null, page: null,
    });

  const baseFiltered = useFilteredProducts(products, { searchTerm, filters });
  const filteredProducts = useMemo(
    () =>
      statusFilter
        ? baseFiltered.filter((p) => p.workflow_status === statusFilter)
        : baseFiltered,
    [baseFiltered, statusFilter],
  );

  // Status breakdown across the whole catalog — drives the KPI strip.
  // Counts every status that's actually present (incl. audit / re_launch).
  const statusCounts = useMemo(() => {
    const c = {};
    for (const p of products ?? []) {
      const k = p.workflow_status || 'unknown';
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [products]);

  const sortedProducts = useMemo(() => {
    const accessor = SORT_ACCESSORS[sortKey];
    if (!accessor) return filteredProducts;
    const dir = sortDir === 'desc' ? -1 : 1;
    return [...filteredProducts].sort((a, b) => {
      const va = accessor(a);
      const vb = accessor(b);
      const na = va == null || va === '';
      const nb = vb == null || vb === '';
      if (na && nb) return 0;
      if (na) return 1; // blanks always sink to the bottom, regardless of dir
      if (nb) return -1;
      const c =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb), undefined, { numeric: true });
      return c * dir;
    });
  }, [filteredProducts, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedProducts.length / pageSize));
  const currentPage = Math.min(pageParam, totalPages);

  const pagedProducts = useMemo(
    () => sortedProducts.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [sortedProducts, currentPage, pageSize],
  );

  const options = useMemo(() => getFilterOptions(products), [products]);

  const toggleSelect = useCallback((sku) => {
    setSelectedSkus((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }, []);

  // Header checkbox selects/deselects the visible page; selections persist
  // across pages (the bulk bar shows the total selected count).
  const toggleSelectAll = useCallback(
    (checked) => {
      setSelectedSkus((prev) => {
        const next = new Set(prev);
        for (const p of pagedProducts) {
          if (checked) next.add(p.sku);
          else next.delete(p.sku);
        }
        return next;
      });
    },
    [pagedProducts],
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
        {canEdit && (
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
        )}
      </header>

      {!loading && !error && totalCount > 0 && (
        <CatalogStats
          total={totalCount}
          counts={statusCounts}
          active={statusFilter}
          onSelect={toggleStatus}
        />
      )}

      {!loading && !error && totalCount > 0 && (
        <ProductsToolbar
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          filters={filters}
          onFiltersChange={onFiltersChange}
          onClearAll={clearFilters}
          options={options}
          resultCount={filteredProducts.length}
          totalCount={totalCount}
        />
      )}

      {!loading && !error && totalCount > 0 && filteredProducts.length === 0 ? (
        <EmptyFilterState onClearFilters={clearFilters} />
      ) : (
        <>
          <ProductsTable
            products={pagedProducts}
            loading={loading}
            error={error}
            selectedSkus={selectedSkus}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
          />
          {!loading && !error && (
            <Pagination
              page={currentPage}
              pageSize={pageSize}
              total={sortedProducts.length}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          )}
        </>
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

      {canEdit && creating && <CreateProductDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

// Clickable status breakdown, built from whatever statuses are actually
// present. Each card filters the catalog by workflow status; the active card
// is highlighted. "All products" clears the filter.
function CatalogStats({ total, counts, active, onSelect }) {
  const presentKeys = [
    ...STATUS_ORDER.filter((k) => counts[k] > 0),
    ...Object.keys(counts).filter((k) => !STATUS_ORDER.includes(k) && counts[k] > 0),
  ];
  const cards = [
    { key: '', label: 'All products', count: total, dot: 'bg-on-surface-variant' },
    ...presentKeys.map((k) => ({
      key: k,
      label: statusMeta(k).label,
      count: counts[k],
      dot: statusMeta(k).dot,
    })),
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {cards.map((card) => {
        const count = card.count;
        const isActive = (card.key || '') === (active || '');
        return (
          <button
            key={card.key || 'all'}
            type="button"
            onClick={() => onSelect(card.key)}
            aria-pressed={isActive}
            className={`text-left rounded-xl border px-4 py-3 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
              isActive
                ? 'border-primary bg-primary-container/20 ring-1 ring-primary/30'
                : 'border-outline-variant bg-surface-container-lowest hover:border-outline hover:bg-surface-container-low'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${card.dot}`} />
              <span className="text-label-md text-on-surface-variant truncate">
                {card.label}
              </span>
            </div>
            <div className="text-headline-sm font-semibold text-on-surface mt-1 tabular-nums">
              {count}
            </div>
          </button>
        );
      })}
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
