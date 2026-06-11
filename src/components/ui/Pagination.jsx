import { ChevronLeft, ChevronRight } from 'lucide-react';

const PAGE_SIZES = [10, 25, 50, 100];

/**
 * Client-side pagination bar: range label, page-number buttons with ellipsis,
 * prev/next, and a page-size selector.
 *
 * Props:
 *   page       — current 1-based page
 *   pageSize   — items per page
 *   total      — total item count (after filtering)
 *   onPageChange(page)
 *   onPageSizeChange(size)
 */
export default function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, totalPages);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);

  if (total === 0) return null;

  return (
    <div className="flex items-center justify-between gap-4 flex-wrap px-1">
      <div className="flex items-center gap-3 text-body-sm text-on-surface-variant">
        <span>
          Showing <span className="text-on-surface font-medium">{from}–{to}</span> of{' '}
          <span className="text-on-surface font-medium">{total}</span>
        </span>
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="px-2 py-1 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
          aria-label="Items per page"
        >
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>{s} / page</option>
          ))}
        </select>
      </div>

      {totalPages > 1 && (
        <nav className="flex items-center gap-1" aria-label="Pagination">
          <PageButton
            disabled={current === 1}
            onClick={() => onPageChange(current - 1)}
            ariaLabel="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
          </PageButton>

          {buildPageItems(current, totalPages).map((item, i) =>
            item === '…' ? (
              <span key={`gap-${i}`} className="px-1.5 text-body-sm text-on-surface-variant select-none">
                …
              </span>
            ) : (
              <PageButton
                key={item}
                active={item === current}
                onClick={() => onPageChange(item)}
                ariaLabel={`Page ${item}`}
              >
                {item}
              </PageButton>
            ),
          )}

          <PageButton
            disabled={current === totalPages}
            onClick={() => onPageChange(current + 1)}
            ariaLabel="Next page"
          >
            <ChevronRight className="w-4 h-4" />
          </PageButton>
        </nav>
      )}
    </div>
  );
}

function PageButton({ children, onClick, disabled = false, active = false, ariaLabel }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || active}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      className={`min-w-8 h-8 px-2 inline-flex items-center justify-center rounded-lg text-body-sm transition-colors ${
        active
          ? 'bg-primary text-on-primary font-semibold cursor-default'
          : disabled
            ? 'text-on-surface-variant/40 cursor-not-allowed'
            : 'text-on-surface hover:bg-surface-container-high'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Page-number list with ellipsis: always shows first/last, plus a window
 * around the current page. e.g. [1, '…', 4, 5, 6, '…', 12]
 */
function buildPageItems(current, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const items = [1];
  const windowStart = Math.max(2, current - 1);
  const windowEnd = Math.min(totalPages - 1, current + 1);

  if (windowStart > 2) items.push('…');
  for (let p = windowStart; p <= windowEnd; p++) items.push(p);
  if (windowEnd < totalPages - 1) items.push('…');
  items.push(totalPages);
  return items;
}
