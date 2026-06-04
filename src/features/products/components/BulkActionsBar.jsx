import { useState } from 'react';
import {
  X,
  Tag,
  Send,
  RefreshCw,
  Loader2,
  Check,
  AlertCircle,
  Download,
} from 'lucide-react';
import { bulkUpdateProducts, getProduct } from '../api/products';
import { pushProductToWix, readWixProduct } from '@/features/syndication/api/wixSync';
import { generateBBBFromTemplateBulk } from '@/features/syndication/exports/bbbExport';
import { listTemplates } from '@/features/templates/api/templates';
import { listMedia } from '@/features/media/api/media';

const WORKFLOW_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'in_review', label: 'In Review' },
  { value: 'ready_to_sell', label: 'Ready to Sell' },
  { value: 'archived', label: 'Archived' },
];

export default function BulkActionsBar({ selectedSkus, products, onClear, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const count = selectedSkus.size;
  if (count === 0) return null;

  const selectedProducts = products.filter((p) => selectedSkus.has(p.sku));
  const linkedSkus = selectedProducts.filter((p) => p.wix_product_id).map((p) => p.sku);

  async function handleStatusChange(status) {
    if (!status) return;
    if (!window.confirm(`Change status to "${status}" for ${count} product${count === 1 ? '' : 's'}?`)) return;
    setBusy('status');
    setResult(null);
    try {
      await bulkUpdateProducts([...selectedSkus], { workflow_status: status });
      setResult({ type: 'success', message: `Updated status for ${count} product${count === 1 ? '' : 's'}.` });
      onChanged?.();
    } catch (err) {
      setResult({ type: 'error', message: err.message ?? 'Update failed' });
    } finally {
      setBusy(null);
    }
  }

  async function runBatch(skus, action, taskLabel) {
    setBusy(taskLabel);
    setResult(null);
    setProgress({ done: 0, total: skus.length });
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < skus.length; i += 3) {
      const batch = skus.slice(i, i + 3);
      const results = await Promise.allSettled(batch.map(action));
      for (const r of results) {
        if (r.status === 'fulfilled') succeeded++;
        else failed++;
      }
      setProgress({ done: Math.min(i + 3, skus.length), total: skus.length });
    }
    setBusy(null);
    setResult({
      type: failed > 0 ? 'error' : 'success',
      message: failed > 0
        ? `${succeeded} succeeded, ${failed} failed.`
        : `${succeeded} ${succeeded === 1 ? 'push' : 'pushes'} complete.`,
    });
    onChanged?.();
  }

  async function handlePushAll() {
    if (linkedSkus.length === 0) {
      setResult({ type: 'error', message: 'None of the selected products are linked to Wix.' });
      return;
    }
    if (!window.confirm(`Push ${linkedSkus.length} product${linkedSkus.length === 1 ? '' : 's'} to Wix? This sends the current PIM values to each linked Wix product.`)) return;
    await runBatch(linkedSkus, (sku) => pushProductToWix(sku), 'push');
  }

  async function handleRefreshAll() {
    if (linkedSkus.length === 0) {
      setResult({ type: 'error', message: 'None of the selected products are linked to Wix.' });
      return;
    }
    await runBatch(linkedSkus, (sku) => readWixProduct(sku), 'refresh');
  }

  async function handleExportBBB() {
    setBusy('export');
    setResult(null);
    setProgress({ done: 0, total: count + 1 });
    try {
      // 1. Find the BB&B template uploaded to /templates
      const templates = await listTemplates();
      const bbb = templates.find((t) =>
        t.marketplace.toLowerCase().includes('bb&b') ||
        t.marketplace.toLowerCase().includes('bbb') ||
        t.marketplace.toLowerCase().includes('overstock')
      );
      if (!bbb) {
        throw new Error('No BB&B / Overstock template found. Upload one in /templates first.');
      }
      setProgress({ done: 1, total: count + 1 });

      // 2. Fetch full product + media for each selected SKU
      const skus = [...selectedSkus];
      const productList = [];
      for (let i = 0; i < skus.length; i++) {
        const [product, media] = await Promise.all([
          getProduct(skus[i]),
          listMedia(skus[i]),
        ]);
        if (product) productList.push({ product, media });
        setProgress({ done: i + 2, total: count + 1 });
      }

      if (productList.length === 0) {
        throw new Error('Could not load product data.');
      }

      // 3. Generate the combined XLSX and trigger download
      await generateBBBFromTemplateBulk(bbb.storage_path, productList);

      setResult({
        type: 'success',
        message: `Exported ${productList.length} product${productList.length === 1 ? '' : 's'} to BB&B template.`,
      });
    } catch (err) {
      setResult({ type: 'error', message: err.message ?? 'Export failed' });
    } finally {
      setBusy(null);
      setProgress({ done: 0, total: 0 });
    }
  }

  return (
    <div className="sticky bottom-4 z-30 mx-auto max-w-4xl">
      <div className="rounded-2xl border border-outline-variant bg-surface shadow-lg overflow-hidden">
        {result && (
          <div
            className={`px-5 py-2 text-body-sm flex items-center gap-2 ${
              result.type === 'error'
                ? 'bg-error-container text-on-error-container'
                : 'bg-emerald-50 text-emerald-800'
            }`}
          >
            {result.type === 'error' ? (
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
            ) : (
              <Check className="w-4 h-4 flex-shrink-0" />
            )}
            <span>{result.message}</span>
          </div>
        )}
        <div className="px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-primary-container text-on-primary-container text-label-md font-bold">
              {count}
            </span>
            <span className="text-body-md text-on-surface font-medium">
              {count === 1 ? 'product selected' : 'products selected'}
            </span>
            {busy && (
              <span className="text-body-sm text-on-surface-variant inline-flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {progress.total > 0 ? `${progress.done}/${progress.total}` : 'Working…'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <StatusDropdown disabled={!!busy} onChange={handleStatusChange} />

            <button
              type="button"
              onClick={handlePushAll}
              disabled={!!busy || linkedSkus.length === 0}
              title={linkedSkus.length === 0 ? 'No linked products selected' : `Push ${linkedSkus.length} to Wix`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send className="w-3.5 h-3.5" />
              Push to Wix
              {linkedSkus.length > 0 && linkedSkus.length !== count && (
                <span className="text-on-surface-variant">({linkedSkus.length})</span>
              )}
            </button>

            <button
              type="button"
              onClick={handleRefreshAll}
              disabled={!!busy || linkedSkus.length === 0}
              title="Refresh Wix cache for selected"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh from Wix
            </button>

            <button
              type="button"
              onClick={handleExportBBB}
              disabled={!!busy}
              title={`Export ${count} product${count === 1 ? '' : 's'} into one BB&B template`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="w-3.5 h-3.5" />
              Export BB&B
            </button>

            <div className="w-px h-5 bg-outline-variant mx-1" />

            <button
              type="button"
              onClick={onClear}
              disabled={!!busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" />
              Clear
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusDropdown({ disabled, onChange }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
      >
        <Tag className="w-3.5 h-3.5" />
        Change Status
      </button>
      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 bottom-full mb-1 z-20 min-w-[160px] rounded-lg border border-outline-variant bg-surface shadow-lg overflow-hidden">
            {WORKFLOW_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onChange(o.value);
                }}
                className="block w-full text-left px-3 py-2 text-body-sm text-on-surface hover:bg-surface-container-low transition-colors"
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
