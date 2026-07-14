import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { formatCAD, formatCategory } from '@/lib/format';
import { getThumbnailUrl } from '@/features/media/api/media';
import Skeleton from '@/components/ui/Skeleton';
import StatusBadge from './StatusBadge';

const COLUMNS = [
  { key: 'sku', label: 'SKU', align: 'left' },
  { key: 'model', label: 'Model', align: 'left' },
  { key: 'brand', label: 'Brand', align: 'left' },
  { key: 'category', label: 'Category', align: 'left' },
  { key: 'status', label: 'Status', align: 'left' },
  { key: 'msrp', label: 'MSRP', align: 'right' },
];

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
}) {
  const navigate = useNavigate();
  const selectionEnabled = typeof onToggleSelect === 'function';
  // A price column that is almost entirely "—" is noise, not information —
  // show MSRP only when the current list actually carries prices.
  const showMsrp = (products ?? []).some((p) => p.msrp_cad != null && p.msrp_cad !== '');
  const columns = showMsrp ? COLUMNS : COLUMNS.filter((c) => c.key !== 'msrp');

  if (error) {
    return (
      <div className="p-12 rounded-xl border border-outline-variant bg-surface-container-lowest text-center">
        <p className="text-body-md text-error">Failed to load products</p>
        <p className="text-body-sm text-on-surface-variant mt-1">{error.message}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
        <div className="p-4 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-4 items-center">
              <Skeleton className="h-16 w-16 rounded-md" />
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
      <div className="p-12 rounded-xl border-2 border-dashed border-outline-variant bg-surface-container-low text-center">
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
    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-on-surface-variant border-b border-outline-variant bg-surface-container-low sticky top-0 z-10">
              {selectionEnabled && (
                <th className="py-3 pl-4 pr-2 w-10">
                  <label className="flex items-center justify-center p-2 -m-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) => onToggleSelectAll(e.target.checked)}
                      aria-label="Select all"
                      className="w-4 h-4 rounded border-outline-variant accent-primary focus:ring-primary/30 cursor-pointer"
                    />
                  </label>
                </th>
              )}
              <th className="py-3 px-4 w-20"></th>
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
            {products.map((product) => {
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
                  className={`group border-b border-outline-variant last:border-0 hover:bg-primary-container/10 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${
                    isSelected ? 'bg-primary-container/30' : ''
                  }`}
                >
                  {selectionEnabled && (
                    <td className="py-3 pl-4 pr-2" onClick={(e) => e.stopPropagation()}>
                      <label className="flex items-center justify-center p-2 -m-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!isSelected}
                          onChange={() => onToggleSelect(product.sku)}
                          aria-label={`Select ${product.sku}`}
                          className="w-4 h-4 rounded border-outline-variant accent-primary focus:ring-primary/30 cursor-pointer"
                        />
                      </label>
                    </td>
                  )}
                  <td className="py-3 px-4">
                    <ProductThumbnail
                      primaryImage={product.primary_image}
                      alt={product.model_name}
                    />
                  </td>
                  <td className="py-3 px-4 text-body-sm font-mono text-on-surface whitespace-nowrap">
                    {product.sku}
                  </td>
                  <td className="py-3 px-4">
                    <div className="text-body-md font-semibold text-on-surface">
                      {product.model_name || '—'}
                    </div>
                    {product.family_number && (
                      <div className="text-body-sm text-on-surface-variant">
                        Family {product.family_number}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-4 text-body-md text-on-surface">
                    {product.brand || '—'}
                  </td>
                  <td className="py-3 px-4 text-body-md text-on-surface">
                    {formatCategory(product.category)}
                  </td>
                  <td className="py-3 px-4">
                    <StatusBadge status={product.workflow_status} />
                  </td>
                  {showMsrp && (
                    <td className="py-3 px-4 text-body-md font-semibold text-on-surface text-right whitespace-nowrap tabular-nums">
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

  if (typeof onSort !== 'function') {
    return (
      <th
        className={`py-3 px-4 text-label-md font-semibold uppercase tracking-wide ${alignRight ? 'text-right' : 'text-left'}`}
      >
        {col.label}
      </th>
    );
  }

  return (
    <th
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`py-3 px-4 text-label-md font-medium ${alignRight ? 'text-right' : 'text-left'}`}
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

function ProductThumbnail({ primaryImage, alt }) {
  const [error, setError] = useState(false);

  if (!primaryImage || error) {
    return (
      <div className="w-16 aspect-square rounded-md bg-surface-container border border-outline-variant flex items-center justify-center flex-shrink-0">
        <Camera className="w-5 h-5 text-on-surface-variant opacity-40" strokeWidth={1.5} />
      </div>
    );
  }

  return (
    <div className="w-16 aspect-square rounded-md overflow-hidden flex-shrink-0 border border-outline-variant bg-surface-container">
      <img
        src={getThumbnailUrl(primaryImage.storage_path, 128)}
        alt={primaryImage.alt_text || alt || ''}
        onError={() => setError(true)}
        loading="lazy"
        className="w-full h-full object-cover block transition-transform duration-200 group-hover:scale-105"
      />
    </div>
  );
}
