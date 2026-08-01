import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { formatCAD, formatCategory } from '@/lib/format';
import { getThumbnailUrl } from '@/features/media/api/media';
import Skeleton from '@/components/ui/Skeleton';
import Checkbox from '@/components/ui/Checkbox';
import StatusBadge from './StatusBadge';

// Explicit widths (table-fixed) so column positions don't shift between
// pages; Model has no width and absorbs the remaining space. SKU is the
// identifying column, so it stays pinned when the table scrolls sideways.
const COLUMNS = [
  { key: 'sku', label: 'SKU', align: 'left', width: 'w-36', stickyLeft: true },
  { key: 'model', label: 'Model', align: 'left' },
  { key: 'brand', label: 'Brand', align: 'left', width: 'w-28' },
  { key: 'category', label: 'Category', align: 'left', width: 'w-44' },
  { key: 'status', label: 'Status', align: 'left', width: 'w-36' },
  { key: 'msrp', label: 'MSRP', align: 'right', width: 'w-28' },
];

// Header cells are individually sticky (sticky on <thead>/<tr> doesn't
// survive border-collapse), so each th carries its own opaque background
// and an inset shadow as bottom rule — borders don't travel with sticky
// cells either.
const TH_STICKY =
  'sticky top-0 bg-surface-container-low shadow-[inset_0_-1px_0_var(--color-outline-variant)]';

// Opaque stand-in for bg-primary-container/30 over the card background —
// the pinned SKU cell can't be translucent or the columns scrolling
// underneath would show through it.
const SELECTED_STICKY_BG =
  'bg-[color-mix(in_srgb,var(--color-primary-container)_30%,var(--color-surface-container-lowest))]';

export default function ProductsTable({
  products,
  loading,
  error,
  selectedSkus,
  onToggleSelect,
  onToggleSelectAll,
  sortKey,
  sortDir,
  onSort,
  showMsrp = false,
}) {
  const navigate = useNavigate();
  const selectionEnabled = typeof onToggleSelect === 'function';
  const columns = showMsrp ? COLUMNS : COLUMNS.filter((c) => c.key !== 'msrp');

  if (error) {
    return (
      <div className="p-12 rounded-2xl border border-outline-variant bg-surface-container-lowest text-center">
        <p className="text-body-md text-error">Failed to load products</p>
        <p className="text-body-sm text-on-surface-variant mt-1">{error.message}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
        <div className="p-4 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-4 items-center">
              <Skeleton className="h-12 w-12 rounded-md" />
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-6 flex-1" />
              <Skeleton className="h-6 w-20" />
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-6 w-20" />
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="p-12 rounded-2xl border-2 border-dashed border-outline-variant bg-surface-container-low text-center">
        <h3 className="text-headline-sm text-on-surface mb-2">No products yet</h3>
        <p className="text-body-md text-on-surface-variant">
          Click "New Product" to add your first product to the catalog.
        </p>
      </div>
    );
  }

  const allSelected =
    selectionEnabled &&
    products.length > 0 &&
    products.every((p) => selectedSkus?.has(p.sku));

  return (
    <div className="relative rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden after:absolute after:inset-y-0 after:right-0 after:w-6 after:z-20 after:bg-gradient-to-l after:from-on-surface/10 after:to-transparent after:pointer-events-none min-[84rem]:after:hidden">
      {/* This wrapper is the scroll container for BOTH axes — the sticky
          header only works when its own ancestor scrolls, and <main>'s
          page scroll never activates it. data-lenis-prevent keeps the
          Lenis instance on <main> from swallowing wheel events here. */}
      <div className="max-h-[max(24rem,calc(100vh-16rem))] overflow-auto" data-lenis-prevent>
        <table className="w-full min-w-[64rem] table-fixed">
          <thead>
            <tr className="text-on-surface-variant">
              {selectionEnabled && (
                <th className={`${TH_STICKY} z-10 py-3 pl-4 pr-2 w-10`}>
                  <Checkbox
                    checked={allSelected}
                    onChange={(e) => onToggleSelectAll(e.target.checked)}
                    aria-label="Select all"
                    className="p-2 -m-2"
                  />
                </th>
              )}
              <th className={`${TH_STICKY} z-10 py-3 px-4 w-20`}></th>
              {columns.map((col) => (
                <SortableHeader
                  key={col.key}
                  col={col}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {products.map((product, index) => {
              const isSelected = selectionEnabled && selectedSkus?.has(product.sku);
              const open = () => navigate(`/catalog/${product.sku}`);
              return (
                <tr
                  key={product.sku}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${product.sku}`}
                  onClick={(e) => {
                    if (e.target.tagName === 'INPUT') return;
                    open();
                  }}
                  onKeyDown={(e) => {
                    if (e.target.tagName === 'INPUT') return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      open();
                    }
                  }}
                  className={`group border-b border-outline-variant last:border-0 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${
                    isSelected ? 'bg-primary-container/30' : 'hover:bg-surface-container'
                  }`}
                >
                  {selectionEnabled && (
                    <td className="py-2 pl-4 pr-2" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={!!isSelected}
                        onChange={() => onToggleSelect(product.sku)}
                        aria-label={`Select ${product.sku}`}
                        className="p-2 -m-2"
                      />
                    </td>
                  )}
                  <td className="py-2 px-4">
                    <ProductThumbnail
                      primaryImage={product.primary_image}
                      alt={product.model_name}
                      eager={index < 6}
                    />
                  </td>
                  <td
                    className={`py-2 px-4 text-body-sm font-mono text-on-surface whitespace-nowrap sticky left-0 z-[1] ${
                      isSelected
                        ? SELECTED_STICKY_BG
                        : 'bg-surface-container-lowest group-hover:bg-surface-container'
                    }`}
                  >
                    {product.sku}
                  </td>
                  <td className="py-2 px-4">
                    <div className="text-body-md font-semibold text-on-surface">
                      {product.model_name || '—'}
                    </div>
                    {product.family_number && (
                      <div className="text-body-sm text-on-surface-variant">
                        Family {product.family_number}
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-4 text-body-md text-on-surface">
                    {product.brand || '—'}
                  </td>
                  <td className="py-2 px-4 text-body-md text-on-surface">
                    {formatCategory(product.category)}
                  </td>
                  <td className="py-2 px-4">
                    <StatusBadge status={product.workflow_status} />
                  </td>
                  {showMsrp && (
                    <td className="py-2 px-4 text-body-md font-semibold text-on-surface text-right whitespace-nowrap tabular-nums">
                      {formatCAD(product.msrp_cad)}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortableHeader({ col, sortKey, sortDir, onSort }) {
  const active = sortKey === col.key;
  const alignRight = col.align === 'right';
  const base = `${TH_STICKY} ${col.stickyLeft ? 'left-0 z-20' : 'z-10'} ${col.width ?? ''} py-3 px-4`;

  if (typeof onSort !== 'function') {
    return (
      <th
        className={`${base} text-label-md font-semibold uppercase tracking-wide ${alignRight ? 'text-right' : 'text-left'}`}
      >
        {col.label}
      </th>
    );
  }

  return (
    <th
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`${base} text-label-md font-medium ${alignRight ? 'text-right' : 'text-left'}`}
    >
      <button
        type="button"
        onClick={() => onSort(col.key)}
        className={`inline-flex items-center gap-1 rounded px-1 -mx-1 hover:text-on-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
          alignRight ? 'flex-row-reverse' : ''
        } ${active ? 'text-on-surface' : ''}`}
      >
        {col.label}
        {active ? (
          sortDir === 'asc' ? (
            <ChevronUp className="w-3.5 h-3.5" strokeWidth={2.5} />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" strokeWidth={2.5} />
          )
        ) : (
          <ChevronsUpDown className="w-3.5 h-3.5 opacity-40" />
        )}
      </button>
    </th>
  );
}

// `eager` marks above-the-fold rows: they skip lazy-loading and get high
// fetch priority so the first thumbnails the user sees load first.
function ProductThumbnail({ primaryImage, alt, eager = false }) {
  const [error, setError] = useState(false);

  if (!primaryImage || error) {
    return (
      <div className="w-12 aspect-square rounded-md bg-surface-container border border-outline-variant flex items-center justify-center flex-shrink-0">
        <Camera className="w-5 h-5 text-on-surface-variant opacity-40" strokeWidth={1.5} />
      </div>
    );
  }

  return (
    <div className="w-12 aspect-square rounded-md overflow-hidden flex-shrink-0 border border-outline-variant bg-surface-container">
      <img
        src={getThumbnailUrl(primaryImage.storage_path, 128)}
        alt={primaryImage.alt_text || alt || ''}
        onError={() => setError(true)}
        loading={eager ? 'eager' : 'lazy'}
        fetchPriority={eager ? 'high' : 'auto'}
        decoding="async"
        className="w-full h-full object-cover block transition-transform duration-200 group-hover:scale-105"
      />
    </div>
  );
}
