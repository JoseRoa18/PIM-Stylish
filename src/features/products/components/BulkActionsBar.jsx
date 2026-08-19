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
  Trash2,
  Pencil,
  Sparkles,
} from 'lucide-react';
import BulkEditDialog from './BulkEditDialog';
import ExportReadinessDialog from '@/features/syndication/components/ExportReadinessDialog';
import { ThinkingOrb } from 'thinking-orbs';
import { bulkUpdateProducts, getProduct, deleteProducts } from '../api/products';
import { generateKeywords } from '../api/keywords';
import { pushProductToWix, readWixProduct } from '@/features/syndication/api/wixSync';
import { generateBBBFromTemplateBulk } from '@/features/syndication/exports/bbbExport';
import { generateWayfairFromTemplate } from '@/features/syndication/exports/wayfairExport';
import { generateAmazonFromTemplate } from '@/features/syndication/exports/amazonExport';
import { generateMenardsFromTemplates } from '@/features/syndication/exports/menardsExport';
import { generateWalmartFromTemplate } from '@/features/syndication/exports/walmartExport';
import { generateHomeDepotFromTemplate } from '@/features/syndication/exports/homeDepotExport';
import { generateLowesSet } from '@/features/syndication/exports/lowesExport';
import { generateHomeDepotCaFromTemplate } from '@/features/syndication/exports/homeDepotCaExport';
import { generatePimExport, fetchAllProducts } from '@/features/syndication/exports/pimExport';
import { listTemplates, templateAppliesTo, templateForProduct, accessoryKind } from '@/features/templates/api/templates';
import { listMedia } from '@/features/media/api/media';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { useAuth } from '@/features/auth/AuthContext';

const WORKFLOW_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'in_review', label: 'In Review' },
  { value: 'ready_to_sell', label: 'Ready to Sell' },
  { value: 'archived', label: 'Archived' },
];

export default function BulkActionsBar({ selectedSkus, products, filteredCount = 0, onSelectAll, onClear, onChanged }) {
  const confirm = useConfirm();
  // Viewers keep the read-only actions (template exports); every mutation
  // (status, Wix push/refresh, delete) is editor/admin only.
  const { canEdit } = useAuth();
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [editingFields, setEditingFields] = useState(false);
  // Post-export column readiness ([{file, rows, columns}] → dialog).
  const [readiness, setReadiness] = useState(null);

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

  // Permanent removal — spells out exactly which SKUs go before asking.
  async function handleDelete() {
    const skus = [...selectedSkus];
    const preview = skus.slice(0, 8).join(', ') + (skus.length > 8 ? ` … +${skus.length - 8} more` : '');
    const ok = await confirm({
      title: `Delete ${count} product${count === 1 ? '' : 's'}?`,
      message: `${preview} will be permanently deleted from the PIM, including all their images, videos and documents. Marketplace listings are not touched. This cannot be undone.`,
      confirmLabel: `Delete ${count}`,
      destructive: true,
    });
    if (!ok) return;
    setBusy('delete');
    setResult(null);
    try {
      await deleteProducts(skus);
      onChanged?.();
      onClear?.();
    } catch (err) {
      setResult({ type: 'error', message: err.message ?? 'Delete failed' });
    } finally {
      setBusy(null);
    }
  }

  // Fills search keywords (EN + FR) for selected products that don't have any.
  // Products with keywords are left untouched — regeneration is per-product,
  // from the product page, where the overwrite can be confirmed deliberately.
  async function handleGenerateKeywords() {
    const skus = [...selectedSkus];
    const ok = await confirm({
      title: `Generate search keywords for ${count} product${count === 1 ? '' : 's'}?`,
      message: 'AI writes EN + FR search terms for the selected products that have none yet. Products that already have keywords are kept as they are.',
      confirmLabel: 'Generate',
    });
    if (!ok) return;
    setBusy('keywords');
    setResult(null);
    setProgress({ done: 0, total: skus.length });
    try {
      const { generated, skipped, failed } = await generateKeywords(skus, {
        onProgress: (done, total) => setProgress({ done, total }),
      });
      const parts = [`${generated.length} generated`];
      if (skipped.length) parts.push(`${skipped.length} already had keywords`);
      if (failed.length) parts.push(`${failed.length} failed (${failed.slice(0, 3).map((f) => f.sku).join(', ')}${failed.length > 3 ? '…' : ''})`);
      // No onChanged here: keywords aren't a catalog column, and reloading the
      // list clears the selection — which unmounts this bar and its message.
      setResult({ type: failed.length ? 'error' : 'success', message: parts.join(', ') + '.' });
    } catch (err) {
      setResult({ type: 'error', message: err.message ?? 'Generation failed' });
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

  // Exports products back into the PIM's own category templates (round-trip
  // CSVs the importer accepts) — selection or the whole catalog.
  async function handleExportPim(scope) {
    setBusy('export');
    setResult(null);
    try {
      let productList;
      if (scope === 'all') {
        productList = await fetchAllProducts();
      } else {
        productList = [];
        for (const sku of [...selectedSkus]) {
          const p = await getProduct(sku);
          if (p) productList.push(p);
        }
      }
      if (!productList.length) throw new Error('No products to export.');
      const res = await generatePimExport(productList);
      setResult({
        type: 'success',
        message: `Exported ${res.count} product(s) into ${res.files} template file(s): ${res.categories.join(', ')}.`,
      });
    } catch (err) {
      setResult({ type: 'error', message: err.message ?? 'PIM export failed' });
    } finally {
      setBusy(null);
    }
  }

  // One entry point for every marketplace with an uploaded template.
  async function handleExportMarketplace(marketplace) {
    if (marketplace === '__pim_selected__') return handleExportPim('selected');
    if (marketplace === '__pim_all__') return handleExportPim('all');
    const templates = (await listTemplates()).filter((t) => t.marketplace === marketplace);
    if (/bb&b|bbb|overstock/i.test(marketplace)) return handleExportBBB(templates);
    if (/wayfair|amazon|walmart|home ?depot/i.test(marketplace)) return handleExportGrouped(marketplace, templates);
    if (/lowe/i.test(marketplace)) return handleExportLowes(templates);
    if (/menards/i.test(marketplace)) return handleExportMenards(templates);
    setResult({
      type: 'error',
      message: `${marketplace} templates are uploaded but the export mapping isn't built yet — Wayfair, Amazon, BB&B, Menards, Walmart, Home Depot and Lowe's are supported so far.`,
    });
  }

  // Lowe's new-item setup is a two-file package (Item Template + SOS Freight
  // Analysis); one Lowe's template covers every category, so no grouping.
  async function handleExportLowes(templates) {
    setBusy('export');
    setResult(null);
    try {
      const skus = [...selectedSkus];
      const productList = [];
      for (const sku of skus) {
        const p = await getProduct(sku);
        if (p) productList.push(p);
      }
      if (!productList.length) throw new Error('Could not load product data.');

      const res = await generateLowesSet(templates, productList);
      setResult({
        type: 'success',
        message: `Exported the Lowe's set (${res.files} file(s), one ZIP) for ${res.count} product(s) — USD cost/MSRP/MAP included; lead times, forecast and competitive URLs stay blank for the business.`,
      });
    } catch (err) {
      setResult({ type: 'error', message: err.message ?? "Lowe's export failed" });
    } finally {
      setBusy(null);
    }
  }

  // Menards is a file SET per category (content + one container file per
  // dimension). Like the grouped exporters, a mixed selection exports the
  // categories that HAVE a template set and reports the ones that don't —
  // it never refuses the whole selection over one uncovered category.
  async function handleExportMenards(templates) {
    setBusy('export');
    setResult(null);
    try {
      // Recipient Reference is documentation, not fillable. NOTE: the five
      // Containers files share a name except the "(n)" suffix but hold
      // DIFFERENT dimensions — real duplicates are detected inside the
      // generator by their data sheet name, never by file name.
      const fillable = templates.filter((t) => !/recipient|reference\.xls/i.test(t.file_name));

      const cats = [...new Set(selectedProducts.map((p) => p.category))];
      const coveredCats = cats.filter((c) => fillable.some((t) => templateAppliesTo(t, c)));
      const skippedCats = cats.filter((c) => !coveredCats.includes(c));
      if (!coveredCats.length) {
        throw new Error(
          `No Menards template covers the selected categor${cats.length === 1 ? 'y' : 'ies'} (${cats.join(', ')}). Upload the set(s) in /templates.`,
        );
      }

      const wanted = new Set(coveredCats);
      const productList = [];
      for (const p of selectedProducts) {
        if (!wanted.has(p.category)) continue;
        const full = await getProduct(p.sku);
        if (full) productList.push(full);
      }
      if (!productList.length) throw new Error('Could not load product data.');

      // One file set per covered category (today that's kitchen sinks; more
      // sets slot in as they're uploaded).
      let files = 0;
      let countTotal = 0;
      const menardsReports = [];
      const unmapped = new Set();
      for (const cat of coveredCats) {
        const catTemplates = fillable.filter((t) => templateAppliesTo(t, cat));
        const catProducts = productList.filter((p) => p.category === cat);
        if (!catProducts.length) continue;
        const res = await generateMenardsFromTemplates(catTemplates, catProducts);
        files += res.files;
        countTotal += res.count;
        for (const r of res.results) {
          if (r.fillReport) menardsReports.push({ file: r.file, ...r.fillReport });
          for (const u of r.unmapped ?? []) unmapped.add(u);
        }
      }
      if (menardsReports.length) setReadiness(menardsReports);

      let message = `Exported ${files} Menards file(s) for ${countTotal} product(s).`;
      if (unmapped.size) message += ` ${unmapped.size} column(s) left for manual/account data (vendor terms, master packs…).`;
      if (skippedCats.length) message += ` ⚠ Skipped (no template): ${skippedCats.join(', ')}.`;
      setResult({ type: skippedCats.length ? 'error' : 'success', message });
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
      // 1. Pick the BB&B template covering the MOST selected categories (one
      // template can span several, e.g. kitchen + bathroom sinks). Products
      // in categories it doesn't cover are skipped and reported — a mixed
      // selection never blocks the covered ones.
      const cats = [...new Set(selectedProducts.map((p) => p.category))];
      const bbb = templates
        .map((t) => ({ t, covered: cats.filter((c) => templateAppliesTo(t, c)) }))
        .sort((a, b) => b.covered.length - a.covered.length)[0];
      if (!bbb || !bbb.covered.length) {
        throw new Error(
          `No BB&B / Overstock template covers the selected categor${cats.length === 1 ? 'y' : 'ies'} (${cats.join(', ')}). Upload one in /templates.`
        );
      }
      const wanted = new Set(bbb.covered);
      const skippedCats = cats.filter((c) => !wanted.has(c));
      setProgress({ done: 1, total: count + 1 });

      // 2. Fetch full product + media for each covered SKU
      const skus = selectedProducts.filter((p) => wanted.has(p.category)).map((p) => p.sku);
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
      const res = await generateBBBFromTemplateBulk(bbb.t.storage_path, productList);
      if (res?.fillReport) setReadiness([{ file: 'BB&B template', ...res.fillReport }]);

      setResult({
        type: skippedCats.length ? 'error' : 'success',
        message: `Exported ${productList.length} product${productList.length === 1 ? '' : 's'} to BB&B template.` +
          (skippedCats.length ? ` ⚠ Skipped (no template): ${skippedCats.join(', ')}.` : ''),
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
      const generate = /amazon/i.test(marketplace)
        ? generateAmazonFromTemplate
        : /walmart/i.test(marketplace)
          ? generateWalmartFromTemplate
          : /home ?depot.*(\bca\b|canada)/i.test(marketplace)
            ? generateHomeDepotCaFromTemplate
            : /home ?depot/i.test(marketplace)
              ? generateHomeDepotFromTemplate
              : generateWayfairFromTemplate;
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
      const reports = [];
      let warnings = 0;
      for (const { tmpl, label, products: productList } of byTemplate.values()) {
        const res = await generate(tmpl.storage_path, productList, `${prefix}_${label.replace(/[^a-z0-9_]+/gi, '_')}`);
        warnings += res.warnings?.length ?? 0;
        if (res.fillReport) reports.push({ file: `${marketplace} — ${label}`, ...res.fillReport });
        parts.push(`${label}: ${res.count} product(s)${res.families != null ? ` / ${res.families} group(s)` : ''}`);
      }
      if (reports.length) setReadiness(reports);

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
    <>
    {/* Fixed to the viewport (offset past the sidebar) so the bar sits at the
        bottom even when the table is short; pointer-events pass through the
        empty side gutters. The dialog lives OUTSIDE this wrapper — inside it,
        pointer-events-none would swallow its clicks. */}
    <div className="fixed bottom-4 left-0 right-0 lg:left-64 z-30 px-4 sm:px-8 flex justify-center pointer-events-none">
      {/* No overflow-hidden here — the dropdown menus open above the bar. */}
      <div className="w-full max-w-5xl pointer-events-auto rounded-2xl border border-outline-variant bg-surface shadow-lg">
        {result && (
          <div
            className={`px-5 py-2 rounded-t-2xl text-body-sm flex items-center gap-2 animate-banner-in ${
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
            <span className="text-body-md text-on-surface font-medium whitespace-nowrap">
              {count === 1 ? 'product selected' : 'products selected'}
            </span>
            {onSelectAll && filteredCount > count && (
              <button
                type="button"
                onClick={onSelectAll}
                disabled={!!busy}
                className="text-body-sm text-primary font-semibold hover:underline disabled:opacity-50 whitespace-nowrap"
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
            {canEdit && (
              <>
                <button
                  type="button"
                  onClick={() => setEditingFields(true)}
                  disabled={!!busy}
                  title="Set shared attributes on all selected products"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Edit fields
                </button>

                <StatusDropdown disabled={!!busy} onChange={handleStatusChange} />

                <button
                  type="button"
                  onClick={handleGenerateKeywords}
                  disabled={!!busy}
                  title="Generate EN + FR search keywords for selected products that have none"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
                >
                  {busy === 'keywords' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  Keywords
                </button>

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
              </>
            )}

            <ExportTemplateDropdown
              disabled={!!busy}
              busy={busy === 'export'}
              count={count}
              onSelect={handleExportMarketplace}
            />

            {canEdit && (
              <>
                <div className="w-px h-5 bg-outline-variant mx-1" />

                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={!!busy}
                  title="Permanently delete the selected products"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-error hover:bg-error-container hover:text-on-error-container transition-colors disabled:opacity-50"
                >
                  {busy === 'delete' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Delete
                </button>
              </>
            )}

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

    {editingFields && (
      <BulkEditDialog
        selectedSkus={selectedSkus}
        products={products}
        onClose={() => setEditingFields(false)}
        onChanged={onChanged}
      />
    )}

    {readiness && (
      <ExportReadinessDialog reports={readiness} onClose={() => setReadiness(null)} />
    )}
    </>
  );
}

// One export button; the menu lists every marketplace with an uploaded
// template (loaded lazily when the menu opens).
function ExportTemplateDropdown({ disabled, busy, count, onSelect }) {
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
        {busy ? <ThinkingOrb state="composing" size={20} className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}
        {busy ? 'Exporting…' : 'Export Template'}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full mb-1 right-0 min-w-[12rem] rounded-xl border border-outline-variant bg-surface shadow-lg py-1 z-40 animate-menu-in-up">
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
            {/* PIM data round-trip: fills the PIM's own category templates */}
            <div className="my-1 border-t border-outline-variant" />
            <div className="px-4 pt-1.5 pb-0.5 text-label-md uppercase tracking-wider text-on-surface-variant">
              PIM data (CSV per category)
            </div>
            <button
              type="button"
              onClick={() => { setOpen(false); onSelect('__pim_selected__'); }}
              className="w-full text-left px-4 py-2 text-body-sm text-on-surface hover:bg-surface-container-low transition-colors"
            >
              Selected products{count ? ` (${count})` : ''}
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); onSelect('__pim_all__'); }}
              className="w-full text-left px-4 py-2 text-body-sm text-on-surface hover:bg-surface-container-low transition-colors"
            >
              Entire catalog
            </button>
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
          <div className="absolute right-0 bottom-full mb-1 z-20 min-w-[160px] rounded-lg border border-outline-variant bg-surface shadow-lg overflow-hidden animate-menu-in-up">
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
