import { useRef, useState } from 'react';
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
  PackageX,
} from 'lucide-react';
import BulkEditDialog from './BulkEditDialog';
import ExportReadinessDialog from '@/features/syndication/components/ExportReadinessDialog';
import { ThinkingOrb } from 'thinking-orbs';
import { bulkUpdateProducts, getProducts, deleteProducts, setProductsObsolete } from '../api/products';
import { generateKeywords } from '../api/keywords';
import { listTemplates, templateAppliesTo, templateForProduct, accessoryKind, purposesIn, templatePurpose } from '@/features/templates/api/templates';
import ExportPurposeDialog from '@/features/templates/components/ExportPurposeDialog';
import { listMediaFor } from '@/features/media/api/media';
import { startTask } from '@/lib/taskProgress';
import { useDockClearance } from '@/components/ui/useDockClearance';
import WixStoresPushDialog from '@/features/syndication/components/WixStoresPushDialog';

// The exporters, the PIM round-trip export and the Wix push load on click
// (performance pass 2026-09-29) — they stay out of the Catalog's first download.
const loadExports = {
  bbb: () => import('@/features/syndication/exports/bbbExport'),
  wayfair: () => import('@/features/syndication/exports/wayfairExport'),
  amazon: () => import('@/features/syndication/exports/amazonExport'),
  menards: () => import('@/features/syndication/exports/menardsExport'),
  walmart: () => import('@/features/syndication/exports/walmartExport'),
  homeDepot: () => import('@/features/syndication/exports/homeDepotExport'),
  homeDepotCa: () => import('@/features/syndication/exports/homeDepotCaExport'),
  lowes: () => import('@/features/syndication/exports/lowesExport'),
  pim: () => import('@/features/syndication/exports/pimExport'),
};
const loadWixSync = () => import('@/features/syndication/api/wixSync');
// Shared with the exporters above (already loaded with any of them).
const loadTemplateFiller = () => import('@/features/syndication/exports/templateFiller');
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { isExcluded, templateMarketplaceKey } from '@/features/syndication/lib/marketplaces';
import { useAuth } from '@/features/auth/AuthContext';

const WORKFLOW_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'in_review', label: 'In Review' },
  { value: 'ready_to_sell', label: 'Ready to Sell' },
  { value: 'archived', label: 'Archived' },
];

// The obsolete mark (user, 2026-10-16), apart from the status it never changes.
const OBSOLETE_ACTIONS = [
  { value: true, label: 'Mark as obsolete' },
  { value: false, label: 'Remove obsolete mark' },
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
  const [pushingStores, setPushingStores] = useState(false); // the store picker of Push to Wix
  // Post-export column readiness ([{file, rows, columns}] → dialog).
  const [readiness, setReadiness] = useState(null);
  // A marketplace with several kinds of template asks which one to fill.
  const [asking, setAsking] = useState(null); // { marketplace, purposes, templates }

  const count = selectedSkus.size;
  // The progress cards sit above the bar instead of covering its buttons.
  const barRef = useRef(null);
  useDockClearance(barRef, count > 0);
  if (count === 0) return null;

  const selectedProducts = products.filter((p) => selectedSkus.has(p.sku));
  const linkedSkus = selectedProducts.filter((p) => p.wix_product_id).map((p) => p.sku);
  const noun = (n) => `${n} product${n === 1 ? '' : 's'}`;

  // Every action starts clean: busy, no message, and no "N/M" left over from
  // an earlier one (the inline counter read "N/N" after a Wix push).
  function begin(kind) {
    setBusy(kind);
    setResult(null);
    setProgress({ done: 0, total: 0 });
  }

  async function handleStatusChange(status) {
    if (!status) return;
    const statusLabel = WORKFLOW_OPTIONS.find((o) => o.value === status)?.label ?? status;
    const ok = await confirm({
      title: 'Change workflow status?',
      message: `Set status to "${statusLabel}" for ${count} product${count === 1 ? '' : 's'}.`,
      confirmLabel: 'Change Status',
    });
    if (!ok) return;
    begin('status');
    const task = startTask('Change status', { detail: `Setting ${noun(count)} to ${statusLabel}…` });
    try {
      await bulkUpdateProducts([...selectedSkus], { workflow_status: status }, {}, { task });
      task.finish(`${noun(count)} set to ${statusLabel}`);
      setResult({ type: 'success', message: `Updated status for ${count} product${count === 1 ? '' : 's'}.` });
      onChanged?.();
    } catch (err) {
      task.fail(err);
      setResult({ type: 'error', message: err.message ?? 'Update failed' });
    } finally {
      setBusy(null);
    }
  }

  // The obsolete mark only marks: the status, listings, exports and
  // promotions stay as they are, and PIM completeness leaves the products out.
  async function handleObsolete(obsolete) {
    const noun = `${count} product${count === 1 ? '' : 's'}`;
    const ok = await confirm(obsolete
      ? {
          title: `Mark ${noun} as obsolete?`,
          message: 'Only the mark changes: status, listings, exports and promotions stay as they are. Obsolete products are left out of PIM completeness.',
          confirmLabel: 'Mark as obsolete',
        }
      : {
          title: `Remove the obsolete mark from ${noun}?`,
          message: 'They count in PIM completeness again. Status, listings, exports and promotions stay as they are.',
          confirmLabel: 'Remove mark',
        });
    if (!ok) return;
    const skus = [...selectedSkus];
    begin('obsolete');
    const task = startTask(obsolete ? 'Mark as obsolete' : 'Remove obsolete mark', { detail: `${noun(skus.length)}…` });
    try {
      const changed = await setProductsObsolete(skus, obsolete, { task });
      const n = changed.length;
      // The others were already in that state (setProductsObsolete skips them).
      const rest = skus.length - n;
      task.finish(obsolete ? `${noun(n)} marked obsolete` : `Mark removed from ${noun(n)}`);
      setResult({
        type: 'success',
        message: (obsolete
          ? `Marked ${n} product${n === 1 ? '' : 's'} obsolete.`
          : `Removed the obsolete mark from ${n} product${n === 1 ? '' : 's'}.`) +
          (rest ? ` ${rest} ${rest === 1 ? 'was' : 'were'} ${obsolete ? 'already obsolete' : 'not marked'}.` : ''),
      });
      // Nothing changed: the selection, and this message, stay on screen.
      if (n) onChanged?.();
    } catch (err) {
      // A later batch failed: the earlier ones did change. The selection and
      // this message stay (reloading the catalog would clear both); running it
      // again finishes the rest, as the products already done are skipped.
      const n = err.changed?.length ?? 0;
      task.fail(n ? `${n} of ${skus.length} done before an error: ${err.message}` : err);
      setResult({
        type: 'error',
        message: n
          ? `${obsolete ? 'Marked' : 'Removed the mark from'} ${n} of ${skus.length} products before an error: ${err.message} Run it again to finish — the ones already done are skipped.`
          : err.message ?? 'Update failed',
      });
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
    begin('delete');
    const task = startTask('Delete products', { detail: `Deleting ${noun(skus.length)}…` });
    try {
      await deleteProducts(skus, { task });
      task.finish(`${noun(skus.length)} deleted`);
      onChanged?.();
      onClear?.();
    } catch (err) {
      task.fail(err);
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
    begin('keywords');
    setProgress({ done: 0, total: skus.length });
    const task = startTask('Generate keywords', { detail: `Writing keywords for ${noun(skus.length)}…` });
    try {
      const { generated, skipped, failed } = await generateKeywords(skus, {
        onProgress: (done, total) => setProgress({ done, total }),
        task,
      });
      const parts = [`${generated.length} generated`];
      if (skipped.length) parts.push(`${skipped.length} already had keywords`);
      if (failed.length) parts.push(`${failed.length} failed (${failed.slice(0, 3).map((f) => f.sku).join(', ')}${failed.length > 3 ? '…' : ''})`);
      if (failed.length) task.fail(parts.join(', '));
      else task.finish(parts.join(', '));
      // No onChanged here: keywords aren't a catalog column, and reloading the
      // list clears the selection — which unmounts this bar and its message.
      setResult({ type: failed.length ? 'error' : 'success', message: parts.join(', ') + '.' });
    } catch (err) {
      task.fail(err);
      setResult({ type: 'error', message: err.message ?? 'Generation failed' });
    } finally {
      setBusy(null);
    }
  }

  // Three products at a time; the card counts each product as it answers.
  async function runBatch(skus, action, taskLabel, title) {
    begin(taskLabel);
    setProgress({ done: 0, total: skus.length });
    const task = startTask(title, { detail: `${noun(skus.length)}…` });
    let succeeded = 0;
    let failed = 0;
    let answered = 0;
    for (let i = 0; i < skus.length; i += 3) {
      const batch = skus.slice(i, i + 3);
      const results = await Promise.allSettled(batch.map((sku) => Promise.resolve(action(sku)).finally(() => {
        answered += 1;
        task.count(answered, skus.length, `Product ${answered} of ${skus.length}`);
      })));
      for (const r of results) {
        if (r.status === 'fulfilled') succeeded++;
        else failed++;
      }
      setProgress({ done: Math.min(i + 3, skus.length), total: skus.length });
    }
    if (failed > 0) task.fail(`${succeeded} succeeded, ${failed} failed`);
    else task.finish(`${noun(succeeded)} done`);
    setBusy(null);
    setResult({
      type: failed > 0 ? 'error' : 'success',
      message: failed > 0
        ? `${succeeded} succeeded, ${failed} failed.`
        : `${succeeded} ${succeeded === 1 ? 'push' : 'pushes'} complete.`,
    });
    onChanged?.();
  }

  // Push to Wix (user, 2026-11-05): it used to send only the content, only to
  // Sinks Direct Canada. Now the person picks the stores (WixStoresPushDialog)
  // and each product gets its full push on each — two at a time, one card.
  function handlePushAll() {
    setPushingStores(true);
  }
  async function runStorePushes(pairs) {
    setPushingStores(false);
    begin('push');
    const stores = new Set(pairs.map((x) => x.site)).size;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : word.endsWith('h') ? 'es' : 's'}`;
    const task = startTask('Push to Wix stores', { detail: `${plural(pairs.length, 'push')} to ${plural(stores, 'store')}…` });
    setProgress({ done: 0, total: pairs.length });
    const { pushProductToWixSite } = await loadWixSync();
    const failures = [];
    let done = 0;
    for (let i = 0; i < pairs.length; i += 2) {
      await Promise.all(pairs.slice(i, i + 2).map(async ({ sku, site }) => {
        try {
          const r = await pushProductToWixSite(sku, site, { create: false });
          if (r?.ok === false) failures.push(`${sku} (${site}): ${r.error}`);
        } catch (err) {
          failures.push(`${sku} (${site}): ${err.message ?? err}`);
        }
        done += 1;
        task.count(done, pairs.length, `${sku} → ${site}`);
      }));
      setProgress({ done, total: pairs.length });
    }
    const ok = pairs.length - failures.length;
    const message = failures.length
      ? `${ok} of ${plural(pairs.length, 'push')} done; failed: ${failures.slice(0, 4).join('; ')}${failures.length > 4 ? '…' : ''}`
      : `${plural(ok, 'push')} done on ${plural(stores, 'store')}.`;
    if (failures.length) task.fail(message);
    else task.finish(message);
    setBusy(null);
    setResult({ type: failures.length ? 'error' : 'success', message });
    onChanged?.();
  }

  async function handleRefreshAll() {
    if (linkedSkus.length === 0) {
      setResult({ type: 'error', message: 'None of the selected products are linked to Wix.' });
      return;
    }
    const { readWixProduct } = await loadWixSync();
    await runBatch(linkedSkus, (sku) => readWixProduct(sku), 'refresh', 'Refresh from Wix');
  }

  // Exports products back into the PIM's own category templates (one sectioned
  // .xlsx, a sheet per category, that the importer accepts) — selection or the
  // whole catalog.
  async function handleExportPim(scope) {
    begin('export');
    const task = startTask(scope === 'all' ? 'PIM export · entire catalog' : 'PIM export', { detail: 'Loading products…' });
    try {
      const { generatePimExport, fetchAllProducts } = await loadExports.pim();
      const productList = scope === 'all' ? await fetchAllProducts() : await getProducts([...selectedSkus]);
      if (!productList.length) throw new Error('No products to export.');
      task.progress(0.1);
      const res = await generatePimExport(productList, { task: task.part(0.1, 1) });
      task.finish(`Downloaded · ${noun(res.count)}, ${res.sheets} sheet${res.sheets === 1 ? '' : 's'}`);
      setResult({
        type: 'success',
        message: `Exported ${res.count} product(s) into one Excel file, ${res.sheets} sheet${res.sheets === 1 ? '' : 's'}: ${res.categories.join(', ')}.`,
      });
    } catch (err) {
      task.fail(err);
      setResult({ type: 'error', message: err.message ?? 'PIM export failed' });
    } finally {
      setBusy(null);
    }
  }

  // One entry point for every marketplace with an uploaded template. The
  // card starts here; when the marketplace asks which file first, it goes
  // away with the question and the chosen export starts its own.
  async function handleExportMarketplace(marketplace) {
    if (marketplace === '__pim_selected__') return handleExportPim('selected');
    if (marketplace === '__pim_all__') return handleExportPim('all');
    begin('export');
    const task = startTask(`${marketplace} export`, { detail: 'Loading the templates…' });
    let all;
    try {
      all = (await listTemplates()).filter((t) => t.marketplace === marketplace);
    } catch (err) {
      task.fail(err);
      setResult({ type: 'error', message: err.message ?? 'Could not load the templates' });
      setBusy(null);
      return;
    }
    const purposes = purposesIn(all);
    if (purposes.length > 1) {
      // "N files" is what THIS selection downloads for each purpose, not how
      // many templates the purpose has (Amazon CA's six listing templates).
      try {
        const loaded = await getProducts([...selectedSkus]);
        const counted = purposes.map((p) => ({ ...p, count: filesForSelection(marketplace, all.filter((t) => templatePurpose(t) === p.value), loaded) }));
        task.cancel();
        setAsking({ marketplace, purposes: counted, templates: all });
      } catch (err) {
        task.fail(err);
        setResult({ type: 'error', message: err.message ?? 'Could not load the selected products' });
      } finally {
        setBusy(null);
      }
      return;
    }
    return runMarketplaceExport(marketplace, all, null, task);
  }

  // The files an export of these products will write — the same routing the
  // exporters below use: Lowe's fills its whole set, Menards each covered
  // category's set, the others one file per template a product resolves to.
  function filesForSelection(marketplace, templates, loaded) {
    const exclusionKey = templateMarketplaceKey(marketplace);
    const kept = loaded.filter((p) => !(exclusionKey && isExcluded(p, exclusionKey)));
    if (!kept.length) return 0;
    if (/lowe/i.test(marketplace)) return templates.length;
    if (/menards/i.test(marketplace)) {
      const fillable = templates.filter((t) => !/recipient|reference\.xls/i.test(t.file_name));
      const cats = new Set(kept.map((p) => p.category));
      return fillable.filter((t) => [...cats].some((c) => templateAppliesTo(t, c))).length;
    }
    return new Set(kept.map((p) => templateForProduct(templates, p)?.id).filter(Boolean)).size;
  }

  // The chosen purpose's files go through the marketplace's own exporter,
  // on the card handleExportMarketplace started (or a new one after the
  // purpose question).
  function runMarketplaceExport(marketplace, templates, purpose = null, task = null) {
    setAsking(null);
    task ??= startTask(`${marketplace} export`, { detail: 'Loading products…' });
    if (purpose) templates = templates.filter((t) => templatePurpose(t) === purpose);
    if (/bb&b|bbb|overstock/i.test(marketplace)) return handleExportBBB(templates, marketplace, task);
    if (/wayfair|amazon|walmart|home ?depot/i.test(marketplace)) return handleExportGrouped(marketplace, templates, task);
    if (/lowe/i.test(marketplace)) return handleExportLowes(templates, marketplace, task);
    if (/menards/i.test(marketplace)) return handleExportMenards(templates, marketplace, task);
    const message = `${marketplace} templates are uploaded but the export mapping isn't built yet — Wayfair, Amazon, BB&B, Menards, Walmart, Home Depot and Lowe's are supported so far.`;
    task.fail(message);
    setBusy(null);
    setResult({ type: 'error', message });
  }

  // Lowe's new-item setup is a two-file package (Item Template + SOS Freight
  // Analysis); one Lowe's template covers every category, so no grouping.
  async function handleExportLowes(templates, marketplace, task) {
    begin('export');
    try {
      const productList = [];
      const excludedSkus = [];
      const exclusionKey = templateMarketplaceKey(marketplace);
      task.step(`Loading ${noun(count)}…`);
      const [{ generateLowesSet }, loaded] = await Promise.all([loadExports.lowes(), getProducts([...selectedSkus])]);
      for (const p of loaded) {
        // Marketplace exclusion (rule 2026-09-22): switched-off products stay out of the file.
        if (exclusionKey && isExcluded(p, exclusionKey)) { excludedSkus.push(p.sku); continue; }
        productList.push(p);
      }
      if (!productList.length) {
        throw new Error(excludedSkus.length ? `Every selected product is excluded from ${marketplace}: ${excludedSkus.join(', ')}.` : 'Could not load product data.');
      }

      task.progress(0.1);
      const res = await generateLowesSet(templates, productList, undefined, { task: task.part(0.1, 1) });
      task.finish(`Downloaded · ${res.files} file${res.files === 1 ? '' : 's'}, ${noun(res.count)}`);
      setResult({
        type: 'success',
        message: `Exported the Lowe's set (${res.files} file(s), one ZIP) for ${res.count} product(s) — USD cost/MSRP/MAP included; lead times, forecast and competitive URLs stay blank for the business.` +
          (excludedSkus.length ? ` Excluded from ${marketplace}, left out: ${excludedSkus.join(', ')}.` : ''),
      });
    } catch (err) {
      task.fail(err);
      setResult({ type: 'error', message: err.message ?? "Lowe's export failed" });
    } finally {
      setBusy(null);
    }
  }

  // Menards is a file SET per category (content + one container file per
  // dimension). Like the grouped exporters, a mixed selection exports the
  // categories that HAVE a template set and reports the ones that don't —
  // it never refuses the whole selection over one uncovered category.
  async function handleExportMenards(templates, marketplace, task) {
    begin('export');
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
      const excludedSkus = [];
      const exclusionKey = templateMarketplaceKey(marketplace);
      task.step(`Loading ${noun(count)}…`);
      const [{ generateMenardsFromTemplates }, loaded] = await Promise.all([
        loadExports.menards(),
        getProducts(selectedProducts.filter((p) => wanted.has(p.category)).map((p) => p.sku)),
      ]);
      for (const full of loaded) {
        // Marketplace exclusion (rule 2026-09-22): switched-off products stay out of the files.
        if (exclusionKey && isExcluded(full, exclusionKey)) { excludedSkus.push(full.sku); continue; }
        productList.push(full);
      }
      if (!productList.length) {
        throw new Error(excludedSkus.length ? `Every selected product is excluded from ${marketplace}: ${excludedSkus.join(', ')}.` : 'Could not load product data.');
      }

      // One file set per covered category (today that's kitchen sinks; more
      // sets slot in as they're uploaded).
      let files = 0;
      let countTotal = 0;
      const menardsReports = [];
      const unmapped = new Set();
      const { labelTask } = await loadTemplateFiller();
      const sets = coveredCats.filter((cat) => productList.some((p) => p.category === cat));
      task.progress(0.1);
      for (const [i, cat] of sets.entries()) {
        const catTemplates = fillable.filter((t) => templateAppliesTo(t, cat));
        const catProducts = productList.filter((p) => p.category === cat);
        const slice = labelTask(task.part(0.1 + (0.9 * i) / sets.length, 0.1 + (0.9 * (i + 1)) / sets.length), sets.length > 1 ? `Set ${i + 1} of ${sets.length}: ${cat}` : '');
        const res = await generateMenardsFromTemplates(catTemplates, catProducts, { task: slice });
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
      if (excludedSkus.length) message += ` Excluded from ${marketplace}, left out: ${excludedSkus.join(', ')}.`;
      task.finish(`Downloaded · ${files} file${files === 1 ? '' : 's'}, ${noun(countTotal)}`);
      setResult({ type: skippedCats.length ? 'error' : 'success', message });
    } catch (err) {
      task.fail(err);
      setResult({ type: 'error', message: err.message ?? 'Menards export failed' });
    } finally {
      setBusy(null);
    }
  }

  // BB&B's First Cost files are one per Beyond category (Kitchen Sinks, Bar
  // Sinks, Bathroom Faucets, Soap Dispensers…) — resolve each product to ITS
  // template, fill each, one ZIP. Products without a template are reported,
  // never block the rest.
  async function handleExportBBB(templates, marketplace, task) {
    begin('export');
    try {
      const groups = new Map(); // template id → { template, productList }
      const skippedSkus = [];
      const excludedSkus = [];
      const exclusionKey = templateMarketplaceKey(marketplace);
      // Products and their media for every selected product that has a
      // template, in a few batched queries (was two round trips per product).
      const withTemplate = [];
      for (const p of selectedProducts) {
        const tpl = templateForProduct(templates, p);
        if (tpl) withTemplate.push({ sku: p.sku, tpl });
        else skippedSkus.push(p.sku);
      }
      // The exporter, the products and their media load together (20%).
      const loading = task.part(0, 0.2);
      loading.step(`Loading ${noun(withTemplate.length)} and their media…`);
      let reads = 0;
      const settle = (p) => p.then((v) => { reads += 1; loading.count(reads, 3); return v; });
      const [{ generateBBBSet }, loaded, mediaBySku] = await Promise.all([
        settle(loadExports.bbb()),
        settle(getProducts(withTemplate.map((w) => w.sku))),
        settle(listMediaFor(withTemplate.map((w) => w.sku))),
      ]);
      const productBySku = new Map(loaded.map((p) => [p.sku, p]));
      for (const { sku, tpl } of withTemplate) {
        const product = productBySku.get(sku);
        // Marketplace exclusion (rule 2026-09-22): switched-off products stay out of the files.
        if (product && exclusionKey && isExcluded(product, exclusionKey)) {
          excludedSkus.push(sku);
        } else if (product) {
          const g = groups.get(tpl.id) ?? { template: tpl, productList: [] };
          g.productList.push({ product, media: mediaBySku.get(sku) ?? [] });
          groups.set(tpl.id, g);
        }
      }
      if (groups.size === 0) {
        if (excludedSkus.length && !skippedSkus.length) throw new Error(`Every selected product is excluded from ${marketplace}: ${excludedSkus.join(', ')}.`);
        throw new Error(
          `No BB&B / Overstock template matches the selected products (${skippedSkus.slice(0, 6).join(', ')}${skippedSkus.length > 6 ? '…' : ''}). Upload the category's First Cost file in /templates.`
        );
      }

      const res = await generateBBBSet([...groups.values()], { task: task.part(0.2, 1) });
      if (res?.reports) setReadiness(res.reports);
      task.finish(`Downloaded · ${res.files} file${res.files === 1 ? '' : 's'}, ${noun(res.count)}`);

      setResult({
        type: skippedSkus.length ? 'error' : 'success',
        message: `Exported ${res.count} product${res.count === 1 ? '' : 's'} to ${res.files} BB&B file${res.files === 1 ? '' : 's'}${res.files > 1 ? ' (one ZIP)' : ''}.` +
          (skippedSkus.length ? ` ⚠ No template for: ${skippedSkus.slice(0, 8).join(', ')}${skippedSkus.length > 8 ? '…' : ''}.` : '') +
          (excludedSkus.length ? ` Excluded from ${marketplace}, left out: ${excludedSkus.join(', ')}.` : ''),
      });
    } catch (err) {
      task.fail(err);
      setResult({ type: 'error', message: err.message ?? 'Export failed' });
    } finally {
      setBusy(null);
    }
  }

  // Wayfair/Amazon templates are class-specific — resolve each product to its
  // template (category + accessory kind) and generate one file per template.
  // One card: loading the products 10%, then each template an equal share
  // ("Template 2 of 3 · kitchen_sink: …").
  async function handleExportGrouped(marketplace, mkTemplates, task) {
    begin('export');
    try {
      if (!mkTemplates.length) {
        throw new Error(`No ${marketplace} template found. Upload one in /templates first.`);
      }
      const generate = /amazon/i.test(marketplace)
        ? (await loadExports.amazon()).generateAmazonFromTemplate
        : /walmart/i.test(marketplace)
          ? (await loadExports.walmart()).generateWalmartFromTemplate
          : /home ?depot.*(\bca\b|canada)/i.test(marketplace)
            ? (await loadExports.homeDepotCa()).generateHomeDepotCaFromTemplate
            : /home ?depot/i.test(marketplace)
              ? (await loadExports.homeDepot()).generateHomeDepotFromTemplate
              : (await loadExports.wayfair()).generateWayfairFromTemplate;
      const prefix = marketplace.replace(/[^a-z0-9]+/gi, '_');

      const byTemplate = new Map(); // template.id → { tmpl, label, products }
      const noTemplate = [];
      const excludedSkus = [];
      const exclusionKey = templateMarketplaceKey(marketplace);
      task.step(`Loading ${noun(count)}…`);
      for (const p of await getProducts([...selectedSkus])) {
        const sku = p.sku;
        // Marketplace exclusion (rule 2026-09-22): switched-off products stay out of the file.
        if (exclusionKey && isExcluded(p, exclusionKey)) { excludedSkus.push(sku); continue; }
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
      if (!byTemplate.size && !noTemplate.length) {
        throw new Error(excludedSkus.length ? `Every selected product is excluded from ${marketplace}: ${excludedSkus.join(', ')}.` : 'Could not load product data.');
      }

      const parts = [];
      const reports = [];
      let warnings = 0;
      const leftOut = []; // products an exporter could not write (e.g. no Home Depot Canada item number)
      const media = { files: 0, parts: 0, failed: 0 }; // Home Depot Canada's media .zip
      const { labelTask } = await loadTemplateFiller();
      const groups = [...byTemplate.values()];
      task.progress(0.1);
      for (const [i, { tmpl, label, products: productList }] of groups.entries()) {
        const slice = labelTask(task.part(0.1 + (0.9 * i) / groups.length, 0.1 + (0.9 * (i + 1)) / groups.length), groups.length > 1 ? `Template ${i + 1} of ${groups.length} · ${label}` : '');
        const res = await generate(tmpl.storage_path, productList, `${prefix}_${label.replace(/[^a-z0-9_]+/gi, '_')}`, { task: slice });
        warnings += res.warnings?.length ?? 0;
        if (res.skipped?.length) leftOut.push(`${res.skipped.join(', ')} (${res.skippedReason ?? 'not written'})`);
        if (res.fillReport) reports.push({ file: `${marketplace} — ${label}`, ...res.fillReport });
        parts.push(`${label}: ${res.count} product(s)${res.families != null ? ` / ${res.families} group(s)` : ''}`);
        media.files += res.media?.files ?? 0;
        media.parts += res.media?.parts ?? 0;
        media.failed += res.media?.failed?.length ?? 0;
      }
      if (reports.length) setReadiness(reports);

      if (!parts.length) {
        throw new Error(`No ${marketplace} template available for: ${noTemplate.join(', ')}. Upload the matching category template(s).`);
      }
      let message = `Exported ${parts.length} file(s) — ${parts.join(' · ')}.`;
      if (noTemplate.length) message += ` ⚠ Skipped (no template): ${noTemplate.join(', ')}.`;
      if (excludedSkus.length) message += ` Excluded from ${marketplace}, left out: ${excludedSkus.join(', ')}.`;
      if (warnings) message += ` ⚠ ${warnings} variant(s) share a finish — set a 2nd Variant Grouping in Excel (see console).`;
      if (leftOut.length) message += ` ⚠ Left out: ${leftOut.join('; ')}.`;
      task.finish(`Downloaded · ${parts.length} file${parts.length === 1 ? '' : 's'}` +
        (media.parts ? ` + ${media.files} media file${media.files === 1 ? '' : 's'} in ${media.parts} .zip${media.parts === 1 ? '' : 's'}` : '') +
        (media.failed ? ` · ${media.failed} could not be fetched` : ''));
      setResult({ type: noTemplate.length || warnings || leftOut.length ? 'error' : 'success', message });
    } catch (err) {
      task.fail(err);
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
      <div ref={barRef} role="region" aria-label="Bulk actions" className="w-full max-w-5xl pointer-events-auto rounded-2xl border border-outline-variant bg-surface shadow-lg">
        {result && (
          <div
            role={result.type === 'error' ? 'alert' : 'status'}
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
              <span role="status" className="text-body-sm text-on-surface-variant inline-flex items-center gap-1.5">
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

                <ObsoleteDropdown disabled={!!busy} busy={busy === 'obsolete'} onChange={handleObsolete} />

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
                  disabled={!!busy}
                  title="Push the selected products to the Wix stores you pick"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Send className="w-3.5 h-3.5" />
                  Push to Wix
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

    {pushingStores && (
      <WixStoresPushDialog skus={selectedProducts.map((p) => p.sku)} onClose={() => setPushingStores(false)} onPush={runStorePushes} />
    )}
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

    {asking && (
      <ExportPurposeDialog
        marketplace={asking.marketplace}
        purposes={asking.purposes}
        onPick={(purpose) => runMarketplaceExport(asking.marketplace, asking.templates, purpose)}
        onClose={() => setAsking(null)}
      />
    )}
    </>
  );
}

// One export button; the menu lists every marketplace with an uploaded
// template (loaded lazily when the menu opens).
// The bar's menus open upward, aligned to their button's right edge. On a
// narrow phone the button can start a line, where a right-aligned menu would
// run off the left edge of the screen — there it aligns left instead.
function menuAlign(button, menuWidth) {
  const box = button?.getBoundingClientRect();
  return box && box.right < menuWidth + 8 ? 'left-0' : 'right-0';
}

function ExportTemplateDropdown({ disabled, busy, count, onSelect }) {
  const [open, setOpen] = useState(false);
  const [align, setAlign] = useState('right-0');
  const [marketplaces, setMarketplaces] = useState(null); // null = not loaded

  async function toggle(e) {
    if (open) return setOpen(false);
    setAlign(menuAlign(e.currentTarget, 192));
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
    <div className="relative" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="true"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
      >
        {busy ? <ThinkingOrb state="composing" size={20} className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}
        {busy ? 'Exporting…' : 'Export Template'}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className={`absolute bottom-full mb-1 ${align} min-w-[12rem] rounded-xl border border-outline-variant bg-surface shadow-lg py-1 z-40 animate-menu-in-up`}>
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
              PIM data (Excel, a sheet per category)
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
  const [align, setAlign] = useState('right-0');

  return (
    <div className="relative" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        onClick={(e) => { setAlign(menuAlign(e.currentTarget, 200)); setOpen((v) => !v); }}
        disabled={disabled}
        aria-expanded={open && !disabled}
        aria-haspopup="true"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
      >
        <Tag className="w-3.5 h-3.5" />
        Change Status
      </button>
      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className={`absolute ${align} bottom-full mb-1 z-20 min-w-[160px] rounded-lg border border-outline-variant bg-surface shadow-lg overflow-hidden animate-menu-in-up`}>
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

// Same menu as StatusDropdown. Closing it (Escape or a choice) puts focus
// back on the trigger, so the confirm dialog also returns focus there.
function ObsoleteDropdown({ disabled, busy, onChange }) {
  const [open, setOpen] = useState(false);
  const [align, setAlign] = useState('right-0');
  const triggerRef = useRef(null);
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="relative" onKeyDown={(e) => e.key === 'Escape' && open && close()}>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => { setAlign(menuAlign(e.currentTarget, 200)); setOpen((v) => !v); }}
        disabled={disabled}
        aria-expanded={open && !disabled}
        aria-haspopup="true"
        title="Mark the selected products as obsolete, or remove the mark (their status doesn't change)"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <PackageX className="w-3.5 h-3.5" aria-hidden="true" />}
        Obsolete
      </button>
      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className={`absolute ${align} bottom-full mb-1 z-20 min-w-[160px] rounded-lg border border-outline-variant bg-surface shadow-lg overflow-hidden animate-menu-in-up`}>
            {OBSOLETE_ACTIONS.map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => {
                  close();
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
