import { useMemo } from 'react';
import { Search, X } from 'lucide-react';
import FilterDropdown from './FilterDropdown';
import { formatCategory } from '@/lib/format';

const FILTER_FIELDS = [
  { id: 'brand', label: 'Brand' },
  { id: 'category', label: 'Category' },
  { id: 'series', label: 'Series' },
  { id: 'material', label: 'Material' },
];

export default function ProductsToolbar({
  searchTerm,
  onSearchChange,
  filters,
  onFiltersChange,
  onClearAll,
  options,
  resultCount,
  totalCount,
}) {
  const updateFilter = (field, values) => {
    onFiltersChange({ ...filters, [field]: values });
  };

  const removePill = (field, value) => {
    updateFilter(
      field,
      filters[field].filter((v) => v !== value),
    );
  };

  // Single atomic clear — the parent resets search + all filters in one URL
  // update (two sequential setSearchParams calls would clobber each other).
  const clearAll = () => onClearAll();

  const activePills = useMemo(() => {
    const pills = [];
    FILTER_FIELDS.forEach(({ id, label }) => {
      (filters[id] || []).forEach((value) => {
        pills.push({ field: id, label, value });
      });
    });
    return pills;
  }, [filters]);

  const hasActiveFilters = Boolean(searchTerm.trim()) || activePills.length > 0;

  return (
    <div className="space-y-3">
      {/* Search bar */}
      <div className="relative">
        <Search
          className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant pointer-events-none"
          strokeWidth={2}
        />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filter by SKU, model, family number, factory code…"
          className="w-full pl-11 pr-11 py-2.5 rounded-full bg-surface-container-lowest text-body-md text-on-surface placeholder:text-on-surface-variant border border-outline-variant focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-shadow"
        />
        {searchTerm && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-surface-container text-on-surface-variant transition-colors"
            title="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Filter chips row */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTER_FIELDS.map(({ id, label }) => (
          <FilterDropdown
            key={id}
            label={label}
            options={options[id] || []}
            selected={filters[id] || []}
            onChange={(values) => updateFilter(id, values)}
          />
        ))}

        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearAll}
            className="ml-auto text-body-sm text-primary hover:underline font-semibold"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Active filter pills + result count */}
      {(activePills.length > 0 || hasActiveFilters) && (
        <div className="flex flex-wrap items-center gap-2">
          {activePills.length > 0 && (
            <>
              <span className="text-body-sm text-on-surface-variant">
                Active:
              </span>
              {activePills.map(({ field, label, value }) => (
                <button
                  key={`${field}-${value}`}
                  type="button"
                  onClick={() => removePill(field, value)}
                  className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-primary-container text-on-primary-container text-body-sm hover:bg-primary hover:text-on-primary transition-colors group"
                >
                  <span className="font-semibold">{label}:</span>
                  <span>{formatCategory(value)}</span>
                  <X className="w-3 h-3" strokeWidth={2.5} />
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {/* Result count */}
      <div className="text-body-sm text-on-surface-variant">
        Showing <span className="font-semibold text-on-surface">{resultCount}</span>{' '}
        of {totalCount} {totalCount === 1 ? 'product' : 'products'}
      </div>
    </div>
  );
}