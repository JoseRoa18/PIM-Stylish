import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera } from 'lucide-react';
import { formatCAD, formatCategory } from '@/lib/format';
import { getThumbnailUrl } from '@/features/media/api/media';
import Skeleton from '@/components/ui/Skeleton';
import StatusBadge from './StatusBadge';

export default function ProductsTable({
  products,
  loading,
  error,
  selectedSkus,
  onToggleSelect,
  onToggleSelectAll,
}) {
  const navigate = useNavigate();
  const selectionEnabled = typeof onToggleSelect === 'function';

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
            <tr className="text-on-surface-variant border-b border-outline-variant bg-surface-container-low">
              {selectionEnabled && (
                <th className="py-3 pl-4 pr-2 w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) => onToggleSelectAll(e.target.checked)}
                    aria-label="Select all"
                    className="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary/30 cursor-pointer"
                  />
                </th>
              )}
              <th className="py-3 px-4 w-20"></th>
              <th className="py-3 px-4 text-left text-label-md font-medium">SKU</th>
              <th className="py-3 px-4 text-left text-label-md font-medium">Model</th>
              <th className="py-3 px-4 text-left text-label-md font-medium">Brand</th>
              <th className="py-3 px-4 text-left text-label-md font-medium">Category</th>
              <th className="py-3 px-4 text-left text-label-md font-medium">Status</th>
              <th className="py-3 px-4 text-right text-label-md font-medium">MSRP</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => {
              const isSelected = selectionEnabled && selectedSkus?.has(product.sku);
              return (
                <tr
                  key={product.sku}
                  onClick={(e) => {
                    if (e.target.tagName === 'INPUT') return;
                    navigate(`/catalog/${product.sku}`);
                  }}
                  className={`border-b border-outline-variant last:border-0 hover:bg-surface-container-low transition-colors cursor-pointer ${
                    isSelected ? 'bg-primary-container/30' : ''
                  }`}
                >
                  {selectionEnabled && (
                    <td className="py-3 pl-4 pr-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={!!isSelected}
                        onChange={() => onToggleSelect(product.sku)}
                        aria-label={`Select ${product.sku}`}
                        className="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary/30 cursor-pointer"
                      />
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
                  <td className="py-3 px-4 text-body-md text-on-surface text-right whitespace-nowrap">
                    {formatCAD(product.msrp_cad)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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
        className="w-full h-full object-cover block"
      />
    </div>
  );
}
