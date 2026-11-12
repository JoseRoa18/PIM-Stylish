import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';

// The button inside a sortable column header — the catalog's own (the same
// button and arrows): the label with the arrow of the order it is in, or the
// two faint arrows while the table is not sorted by it. Its `<th>` carries
// `aria-sort` (ariaSort in lib/tableSort.js). `right`: a right-aligned column.
export default function SortButton({ active, dir, right = false, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded px-1 -mx-1 py-1 -my-1 hover:text-on-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${right ? 'flex-row-reverse' : ''} ${active ? 'text-on-surface' : ''}`}
    >
      <span>{children}</span>
      {active
        ? (dir === 'asc'
          ? <ChevronUp className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden="true" />
          : <ChevronDown className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden="true" />)
        : <ChevronsUpDown className="w-3.5 h-3.5 opacity-40" aria-hidden="true" />}
    </button>
  );
}
