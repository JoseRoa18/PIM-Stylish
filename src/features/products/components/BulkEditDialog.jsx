import { useMemo, useState } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { bulkUpdateProducts } from '../api/products';

// Curated set of attributes that are safe to mass-edit. Category and the
// identity fields (sku, model, family) stay out on purpose: they drive
// template matching and variant grouping.
const EDITABLE_FIELDS = [
  { key: 'brand', label: 'Brand' },
  { key: 'series', label: 'Series' },
  { key: 'material', label: 'Material' },
  { key: 'finish', label: 'Finish' },
  { key: 'color', label: 'Color' },
  { key: 'product_type', label: 'Product type' },
  { key: 'manufacturer', label: 'Manufacturer' },
  { key: 'country_of_origin', label: 'Country of origin' },
  { key: 'warranty', label: 'Warranty' },
  { key: 'launch_lead', label: 'Launch lead' },
];

let rowSeq = 0;

/**
 * Bulk "Edit fields" dialog for the catalog selection: pick one or more
 * attributes, give each a value (or clear it), apply to every selected SKU
 * in one confirmed update. Values offer suggestions from the current
 * filtered product list.
 */
export default function BulkEditDialog({ selectedSkus, products, onClose, onChanged }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState(() => [{ id: ++rowSeq, field: 'brand', value: '', clear: false }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const count = selectedSkus.size;

  // Distinct existing values per field → datalist suggestions.
  const suggestions = useMemo(() => {
    const map = {};
    for (const { key } of EDITABLE_FIELDS) {
      map[key] = [...new Set(products.map((p) => p[key]).filter(Boolean))].sort();
    }
    return map;
  }, [products]);

  const usedFields = new Set(rows.map((r) => r.field));
  const patchRows = rows.filter((r) => r.clear || r.value.trim() !== '');
  const canApply = patchRows.length > 0 && !busy;

  function updateRow(id, patch) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function addRow() {
    const free = EDITABLE_FIELDS.find((f) => !usedFields.has(f.key));
    if (free) setRows((rs) => [...rs, { id: ++rowSeq, field: free.key, value: '', clear: false }]);
  }

  async function handleApply() {
    const patch = {};
    for (const r of patchRows) patch[r.field] = r.clear ? null : r.value.trim();

    const lines = patchRows
      .map((r) => {
        const label = EDITABLE_FIELDS.find((f) => f.key === r.field)?.label ?? r.field;
        return r.clear ? `${label} → (cleared)` : `${label} → "${r.value.trim()}"`;
      })
      .join(', ');
    const ok = await confirm({
      title: `Edit ${count} product${count === 1 ? '' : 's'}?`,
      message: `${lines}. This overwrites the current value on every selected product.`,
      confirmLabel: `Apply to ${count}`,
    });
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      await bulkUpdateProducts([...selectedSkus], patch);
      onChanged?.();
      onClose();
    } catch (err) {
      setError(err.message ?? 'Update failed');
      setBusy(false);
    }
  }

  return (
    <Dialog
      onClose={busy ? undefined : onClose}
      title="Edit fields"
      subtitle={`Applies to the ${count} selected product${count === 1 ? '' : 's'}.`}
      maxWidth="max-w-lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-lg text-label-md font-medium text-on-surface-variant hover:bg-surface-container-low transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!canApply}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-on-primary text-label-md font-semibold enabled:hover:brightness-110 transition disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Apply to {count}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-2">
            <select
              value={row.field}
              onChange={(e) => updateRow(row.id, { field: e.target.value, value: '' })}
              disabled={busy}
              className="w-44 flex-shrink-0 px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              {EDITABLE_FIELDS.map((f) => (
                <option key={f.key} value={f.key} disabled={f.key !== row.field && usedFields.has(f.key)}>
                  {f.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={row.clear ? '' : row.value}
              onChange={(e) => updateRow(row.id, { value: e.target.value })}
              disabled={busy || row.clear}
              list={`bulk-edit-${row.field}`}
              placeholder={row.clear ? 'Will be cleared' : 'New value…'}
              className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:bg-surface-container-low disabled:text-on-surface-variant"
            />
            <datalist id={`bulk-edit-${row.field}`}>
              {(suggestions[row.field] ?? []).map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <label className="flex items-center gap-1.5 text-label-md text-on-surface-variant whitespace-nowrap select-none">
              <input
                type="checkbox"
                checked={row.clear}
                onChange={(e) => updateRow(row.id, { clear: e.target.checked })}
                disabled={busy}
                className="accent-primary"
              />
              Clear
            </label>
            {rows.length > 1 && (
              <button
                type="button"
                onClick={() => setRows((rs) => rs.filter((r) => r.id !== row.id))}
                disabled={busy}
                aria-label="Remove field"
                className="p-1.5 rounded-lg text-on-surface-variant hover:text-error hover:bg-error-container/40 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}

        {rows.length < EDITABLE_FIELDS.length && (
          <button
            type="button"
            onClick={addRow}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-body-sm text-primary font-medium hover:underline disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            Add another field
          </button>
        )}

        {error && <p className="text-body-sm text-error">{error}</p>}
      </div>
    </Dialog>
  );
}
