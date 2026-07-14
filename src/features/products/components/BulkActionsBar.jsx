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
import { generateWayfairFromTemplate } from '@/features/syndication/exports/wayfairExport';
import { generateAmazonFromTemplate } from '@/features/syndication/exports/amazonExport';
import { generateMenardsFromTemplates } from '@/features/syndication/exports/menardsExport';
import { listTemplates, templateAppliesTo, templateForProduct, accessoryKind } from '@/features/templates/api/templates';
import { listMedia } from '@/features/media/api/media';
import { useConfirm } from '@/components/ui/ConfirmProvider';

const WORKFLOW_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'in_review', label: 'In Review' },
  { value: 'ready_to_sell', label: 'Ready to Sell' },
  { value: 'archived', label: 'Archived' },
];

export default function BulkActionsBar({ selectedSkus, products, filteredCount = 0, onSelectAll, onClear, onChanged }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const count = selectedSkus.size;
  if (count === 0) return null;

  const selectedProducts = products.filter((p) => selectedSkus.has(p.sku));
  const linkedSkus = selectedProducts.filter((p) => p.wix_product_id).map((p) => p.sku);

  async function handleStatusChange(status) {
    if (!status) return;
    const ok = await confirm({
      title: 'Change workflow status?',
      message: `Set status to "${status}" for ${count} product${count === 1 ? '' : 's'}.`,
      confirmLabel: 'Change Status',
    });
    if (!ok) return;
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
    const ok = await confirm({
      title: `Push ${linkedSkus.length} product${linkedSkus.length === 1 ? '' : 's'} to Wix?`,
      message: 'This sends the current PIM values to each linked Wix product, overwriting what is in Wix.',
      confirmLabel: 'Push to Wix',
    });
    if (!ok) return;
    await runBatch(linkedSkus, (sku) => pushProductToWix(sku), 'push');
  }

  async function handleRefreshAll() {
    if (linkedSkus.length === 0) {
      setResult({ type: 'error', message: 'None of the selected products are linked to Wix.' });
      return;
    }
    await runBatch(linkedSkus, (sku) => readWixProduct(sku), 'refresh');
  }

  // One entry point for every marketplace with an uploaded template.
  async function handleExportMarketplace(marketplace) {
    const templates = (await listTemplates()).filter((t) => t.marketplace === marketplace);
    if (/bb&b|bbb|overstock/i.test(marketplace)) return handleExportBBB(templates);
    if (/wayfair|amazon/i.test(marketplace)) return handleExportGrouped(marketplace, templates);
    if (/menards/i.test(marketplace)) return handleExportMenards(templates);
    setResult({
      type: 'error',
      message: `${marketplace} templates are uploaded but the export mapping isn't built yet — Wayfair, Amazon, BB&B and Menards are supported so far.`,
    });
  }

  // Menards is a file SET per category (content + one container file per
  // dimension). Fill every applicable file in one action.
  async function handleExportMenards(templates) {
    setBusy('export');
    setResult(null);
    try {
      const cats = [...new Set(selectedProducts.map((p) => p.category))];
      // Recipient Reference is documentation, not fillable. NOTE: the five
      // Containers files share a name except the "(n)" suffix but hold
      // DIFFERENT dimensions — real duplicates are detected inside the
      // generator by their data sheet name, never by file name.
      const usable = templates.filter(
        (t) => !/recipient|reference\.xls/i.test(t.file_name) && cats.every((c) => templateAppliesTo(t, c)),
      );
      if (!usable.length) {
        throw new Error(`No Menards template covers the selected categor${cats.length === 1 ? 'y' : 'ies'} (${cats.join(', ')}).`);
      }

      const skus = [...selectedSkus];
      const productList = [];
      for (const sku of skus) {
        const p = await getProduct(sku);
        if (p) productList.push(p);
      }
      if (!productList.length) throw new Error('Could not load product data.');

      const res = await generateMenardsFromTemplates(usable, productList);
      const unmappedTotal = new Set(res.results.flatMap((r) => r.unmapped)).size;
      setResult({
        type: 'success',
        message: `Exported ${res.files} Menards file(s) for ${res.count} product(s).` +
          (unmappedTotal ? ` ${unmappedTotal} column(s) left for manual/account data (vendor terms, master packs…).` : ''),
      });
    } catch (err) {
      setResult({ type: 'error', message: err.message ?? 'Menards export failed' });
    } finally {
      setBusy(null);
    }
  }

  async function handleExportBBB(templates) {
    setBusy('export');
    setResult(null);
    setProgress({ done: 0, total: count + 1 });
    try {
      // 1. Find a BB&B template that applies to EVERY selected category
      // (one BB&B template can span categories, e.g. kitchen + bathroom sinks).
      const cats = [...new Set(selectedProducts.map((p) => p.category))];
      const bbb = templates.find((t) => cats.every((c) => templateAppliesTo(t, c)));
      if (!bbb) {
        throw new Error(
          `No single BB&B / Overstock template covers the selected categor${cats.length === 1 ? 'y' : 'ies'} (${cats.join(', ')}). Upload one in /templates or narrow the selection.`
        );
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

  // Wayfair/Amazon templates are class-specific — resolve each product to its
  // template (category + accessory kind) and generate one file per template.
  async function handleExportGrouped(marketplace, mkTemplates) {
    setBusy('export');
    setResult(null);
    try {
      if (!mkTemplates.length) {
        throw new Error(`No ${marketplace} template found. Upload one in /templates first.`);
      }
      const generate = /amazon/i.test(marketplace) ? generateAmazonFromTemplate : generateWayfairFromTemplate;
      const prefix = marketplace.replace(/[^a-z0-9]+/gi, '_');

      const skus = [...selectedSkus];
      const byTemplate = new Map(); // template.id → { tmpl, label, products }
      const noTemplate = [];
      for (const sku of skus) {
        const p = await getProduct(sku);
        if (!p) continue;
        const tmpl = templateForProduct(mkTemplates, p);
        if (!tmpl) {
          const label = p.category === 'accessory' ? `accessory (${accessoryKind(p) ?? p.sku})` : p.category;
          if (!noTemplate.includes(label)) noTemplate.push(label);
          continue;
        }
        if (!byTemplate.has(tmpl.id)) {
          const label = p.category === 'accessory' ? `${p.category}/${accessoryKind(p)}` : p.category;
          byTemplate.set(tmpl.id, { tmpl, label, products: [] });
        }
        byTemplate.get(tmpl.id).products.push(p);
      }
      if (!byTemplate.size && !noTemplate.length) throw new Error('Could not load product data.');

      const parts = [];
      let warnings = 0;
      for (const { tmpl, label, products: productList } of byTemplate.values()) {
        const res = await generate(tmpl.storage_path, productList, `${prefix}_${label.replace(/[^a-z0-9_]+/gi, '_')}`);
        warnings += res.warnings?.length ?? 0;
        parts.push(`${label}: ${res.count} product(s)${res.families != null ? ` / ${res.families} group(s)` : ''}`);
      }

      if (!parts.length) {
        throw new Error(`No ${marketplace} template available for: ${noTemplate.join(', ')}. Upload the matching category template(s).`);
      }
      let message = `Exported ${parts.length} file(s) — ${parts.join(' · ')}.`;
      if (noTemplate.length) message += ` ⚠ Skipped (no template): ${noTemplate.join(', ')}.`;
      if (warnings) message += ` ⚠ ${warnings} variant(s) share a finish — set a 2nd Variant Grouping in Excel (see console).`;
      setResult({ type: noTemplate.length || warnings ? 'error' : 'success', message });
    } catch (err) {
      setResult({ type: 'error', message: err.message ?? `${marketplace} export failed` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sticky bottom-4 z-30 mx-auto max-w-4xl">
      {/* No overflow-hidden here — the dropdown menus open above the bar. */}
      <div className="rounded-2xl border border-outline-variant bg-surface shadow-lg">
        {result && (
          <div
            className={`px-5 py-2 rounded-t-2xl text-body-sm flex items-center gap-2 ${
              result.type === 'error'
                ? 'bg-error-container text-on-error-container'
                : 'bg-success-container text-on-success-container'
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
            {onSelectAll && filteredCount > count && (
              <button
                type="button"
                onClick={onSelectAll}
                disabled={!!busy}
                className="text-body-sm text-primary font-semibold hover:underline disabled:opacity-50"
              >
                Select all {filteredCount}
              </button>
            )}
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

            <ExportTemplateDropdown
              disabled={!!busy}
              busy={busy === 'export'}
              onSelect={handleExportMarketplace}
            />

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

// One export button; the menu lists every marketplace with an uploaded
// template (loaded lazily when the menu opens).
function ExportTemplateDropdown({ disabled, busy, onSelect }) {
  const [open, setOpen] = useState(false);
  const [marketplaces, setMarketplaces] = useState(null); // null = not loaded

  async function toggle() {
    if (open) return setOpen(false);
    setOpen(true);
    if (marketplaces === null) {
      try {
        const templates = await listTemplates();
        setMarketplaces([...new Set(templates.map((t) => t.marketplace))]);
      } catch {
        setMarketplaces([]);
      }
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
        {busy ? 'Exporting…' : 'Export Template'}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full mb-1 right-0 min-w-[12rem] rounded-xl border border-outline-variant bg-surface shadow-lg py-1 z-40">
            {marketplaces === null && (
              <div className="px-4 py-2 text-body-sm text-on-surface-variant inline-flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
              </div>
            )}
            {marketplaces?.length === 0 && (
              <div className="px-4 py-2 text-body-sm text-on-surface-variant">
                No templates uploaded — add one in /templates.
              </div>
            )}
            {marketplaces?.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setOpen(false); onSelect(m); }}
                className="w-full text-left px-4 py-2 text-body-sm text-on-surface hover:bg-surface-container-low transition-colors"
              >
                {m}
              </button>
            ))}
          </div>
        </>
      )}
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
