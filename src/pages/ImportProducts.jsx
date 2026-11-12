import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Upload,
  Download,
  FileSpreadsheet,
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  X,
} from 'lucide-react';
import { parseSpreadsheetFile } from '@/features/import/lib/parseSpreadsheet';
import { buildImportRows } from '@/features/import/lib/buildImportRows';
import { TEMPLATE_HEADERS, FAUCET_TEMPLATE_HEADERS, BATH_FAUCET_TEMPLATE_HEADERS, BATH_SINK_TEMPLATE_HEADERS, CUTTING_BOARD_TEMPLATE_HEADERS, ACCESSORY_TEMPLATE_HEADERS, DRAIN_TEMPLATE_HEADERS, STRAINER_TEMPLATE_HEADERS, FAUCET_PLATE_TEMPLATE_HEADERS, COLANDER_TEMPLATE_HEADERS, templateLayout, templateKindOf, scoreImportHeader, excelValidationFor, isProductSheet } from '@/features/import/lib/importSchema';
import { buildSectionedWorkbook } from '@/features/import/lib/sectionedXlsx';
import { loadSuggestionLists } from '@/features/import/api/suggestionLists';
import { fetchProductsForImport, fetchUpcOwners, importProducts } from '@/features/import/api/importProducts';
import { rowChanges } from '@/features/import/lib/importChanges';
import { flagInvalidUpcs, flagRepeatedUpcs } from '@/features/import/lib/upcCheck';
import { flagPriceProblems } from '@/features/import/lib/priceCheck';
import { isOdooPushOn } from '@/features/odoo/api/odooPush';
import { autoLinkChannels } from '@/features/syndication/api/autoLink';
import { startTask } from '@/lib/taskProgress';
import Pagination from '@/components/ui/Pagination';

const BLANK_TEMPLATE_GROUPS = [
  {
    label: 'Sinks',
    templates: [
      { key: 'sink', label: 'Kitchen Sink' },
      { key: 'outdoor_sink', label: 'Outdoor Sink & Ice Chest' },
      { key: 'bathroom_sink', label: 'Bathroom Sink' },
    ],
  },
  {
    label: 'Faucets',
    templates: [
      { key: 'kitchen_faucet', label: 'Kitchen Faucet' },
      { key: 'bathroom_faucet', label: 'Bathroom Faucet' },
    ],
  },
  {
    label: 'Accessories',
    templates: [
      { key: 'cutting_board', label: 'Cutting Board' },
      { key: 'soap_dispenser', label: 'Soap Dispenser' },
      { key: 'pop_up_drain', label: 'Pop-Up Drain' },
      { key: 'basket_strainer', label: 'Basket Strainer' },
      { key: 'colander_drying_rack', label: 'Colanders & Drying Racks' },
      { key: 'faucet_plate', label: 'Faucet Plate' },
    ],
  },
];

// One button with a category menu — the pill-per-category row outgrew the
// header once accessories arrived, and this mirrors the catalog's
// "Export Template" menu (download blank ↔ export filled, same gesture).
function BlankTemplateMenu({ onDownload }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-on-surface/8 transition-colors"
      >
        <Download className="w-4 h-4" />
        Blank template
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full mt-1 left-0 sm:left-auto sm:right-0 z-20 min-w-[13rem] max-h-[60vh] overflow-y-auto rounded-xl border border-outline-variant bg-surface shadow-lg py-1 animate-menu-in" data-lenis-prevent>
            {BLANK_TEMPLATE_GROUPS.map((group, i) => (
              <div key={group.label} className={i > 0 ? 'mt-1 pt-1 border-t border-outline-variant' : ''}>
                <div className="px-4 pt-2 pb-1 text-label-md uppercase tracking-wide text-on-surface-variant">
                  {group.label}
                </div>
                {group.templates.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => { setOpen(false); onDownload(t.key); }}
                    className="w-full text-left px-4 py-2 text-body-sm text-on-surface hover:bg-on-surface/8 transition-colors"
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function ImportProducts() {
  const navigate = useNavigate();
  const fileRef = useRef(null);

  const [phase, setPhase] = useState('upload'); // upload | preview | importing | done
  const [isDragging, setIsDragging] = useState(false);
  // dragenter/dragleave fire for every child the cursor crosses — track depth
  // so the highlight only clears when the pointer truly leaves the zone.
  const dragDepth = useRef(0);
  const [fileName, setFileName] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [rows, setRows] = useState([]);
  const [unknownHeaders, setUnknownHeaders] = useState([]);
  // Sheets of the workbook that were not read: tables without the columns a
  // product row needs (the Full Report's Media and Marketplace IDs).
  const [skippedSheets, setSkippedSheets] = useState([]);
  const [existingMap, setExistingMap] = useState(new Map());
  // The preview shows one page of rows (2026-11-11: every row at once — 13,438
  // of them from a Full Report — made the page crawl) and can show one kind
  // only: the summary's counters are its filters.
  const [show, setShow] = useState('all'); // all | new | updates | unchanged | errors
  const [showIgnored, setShowIgnored] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState(null);
  const [expandedRow, setExpandedRow] = useState(null);
  // "Create the new products in Odoo too" (user, 2026-11-11): offered while
  // Settings → Odoo is on, ticked unless the person unticks it.
  const [odooOn, setOdooOn] = useState(false);
  const [createInOdoo, setCreateInOdoo] = useState(true);
  useEffect(() => {
    let active = true;
    isOdooPushOn().then((on) => { if (active) setOdooOn(on); }).catch(() => {});
    return () => { active = false; };
  }, []);

  const validRows = useMemo(() => rows.filter((r) => r.errors.length === 0), [rows]);
  const errorRows = useMemo(() => rows.filter((r) => r.errors.length > 0), [rows]);
  const newRows = useMemo(() => validRows.filter((r) => !existingMap.has(r.sku)), [validRows, existingMap]);
  // A product the PIM has: an update when the row changes something on it
  // (r.changes, worked out when the file is read), else unchanged — a row that
  // changes nothing is not imported (user, 2026-11-11: a report uploaded back
  // updates "aquellos datos nuevos" only).
  const updateRows = useMemo(() => validRows.filter((r) => existingMap.has(r.sku) && r.changes?.length > 0), [validRows, existingMap]);
  const unchangedRows = useMemo(() => validRows.filter((r) => existingMap.has(r.sku) && !(r.changes?.length > 0)), [validRows, existingMap]);
  // What the Import button writes, in the file's order.
  const importRows = useMemo(() => validRows.filter((r) => !existingMap.has(r.sku) || r.changes?.length > 0), [validRows, existingMap]);
  const newCount = newRows.length;
  const updateCount = updateRows.length;
  const shownRows = show === 'errors' ? errorRows : show === 'new' ? newRows : show === 'updates' ? updateRows : show === 'unchanged' ? unchangedRows : rows;
  const lastPage = Math.max(1, Math.ceil(shownRows.length / pageSize));
  const currentPage = Math.min(page, lastPage);
  const pageRows = shownRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  // A counter pressed again goes back to every row.
  const showOnly = (kind) => { setShow((cur) => (cur === kind ? 'all' : kind)); setPage(1); setExpandedRow(null); };

  const TEMPLATES = {
    sink: TEMPLATE_HEADERS,
    // Outdoor sinks / ice chests share the kitchen sink columns; the Category
    // cell ("Outdoor Sink") is what routes rows to the outdoor_sink category.
    outdoor_sink: TEMPLATE_HEADERS,
    bathroom_sink: BATH_SINK_TEMPLATE_HEADERS,
    kitchen_faucet: FAUCET_TEMPLATE_HEADERS,
    bathroom_faucet: BATH_FAUCET_TEMPLATE_HEADERS,
    cutting_board: CUTTING_BOARD_TEMPLATE_HEADERS,
    soap_dispenser: ACCESSORY_TEMPLATE_HEADERS,
    pop_up_drain: DRAIN_TEMPLATE_HEADERS,
    basket_strainer: STRAINER_TEMPLATE_HEADERS,
    colander_drying_rack: COLANDER_TEMPLATE_HEADERS,
    faucet_plate: FAUCET_PLATE_TEMPLATE_HEADERS,
  };

  // The blank template is the same sectioned Excel the PIM export writes
  // (user, 2026-10-15), with no rows.
  async function downloadTemplate(category = 'sink') {
    const headers = TEMPLATES[category] ?? TEMPLATE_HEADERS;
    const label = BLANK_TEMPLATE_GROUPS.flatMap((g) => g.templates).find((t) => t.key === category)?.label ?? 'Products';
    // the catalog's values for the dropdowns 30%, the workbook the rest
    const task = startTask('Blank template', { detail: `${label} · reading the catalog’s values…` });
    try {
      const suggestions = await loadSuggestionLists({ task: task.part(0, 0.3) });
      const blob = await buildSectionedWorkbook([{ name: label, kind: templateKindOf(headers), sections: templateLayout(headers), rows: [] }], {
        validationFor: (h, kind) => excelValidationFor(h, kind, suggestions),
        task: task.part(0.3, 1),
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `stylish_pim_${category}_import_template.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      task.finish(`Downloaded · ${label}`);
    } catch (err) {
      console.error('Blank template failed:', err);
      task.fail(err);
    }
  }

  async function handleFile(file) {
    if (!file) return;
    setParseError(null);
    setFileName(file.name);
    // reading the sheets 70%, the rows 5%, the lookup of existing SKUs the rest
    const task = startTask('Import file', { detail: `Opening ${file.name}…` });
    try {
      // Every sheet (the PIM export has one per category), headers found under the section band.
      // A sheet without the columns a product row needs (SKU, Brand, Category)
      // is another kind of table — the Full Report's Media and Marketplace IDs —
      // and is left out when the workbook has a product sheet.
      const parsed = await parseSpreadsheetFile(file, { scoreHeader: scoreImportHeader, allSheets: true, isDataSheet: isProductSheet, task: task.part(0, 0.7) });
      if (parsed.rows.length === 0) {
        throw new Error('The file has headers but no data rows.');
      }
      await task.step(`Checking ${parsed.rows.length} rows…`);
      const built = buildImportRows(parsed);
      task.progress(0.75);
      const skus = built.rows.map((r) => r.sku).filter(Boolean);
      const existing = await fetchProductsForImport(skus, { task: task.part(0.75, 0.95) });
      // A UPC must be well formed (12 digits, right check digit) and can be
      // on one product only: a row that breaks either is an error here,
      // before anything is written (the database refuses it too).
      if (built.rows.some((r) => r.attributes?.upc)) {
        task.progress(0.95, 'Checking the UPCs…');
        flagInvalidUpcs(built.rows, existing);
        flagRepeatedUpcs(built.rows, existing, await fetchUpcOwners());
      }
      // The prices a row sets must make sense (more than 0, Orange and Purple
      // never above Blue, a cost under the MAP of its level): an error here,
      // like the database's own refusal.
      flagPriceProblems(built.rows, existing);
      // What each row would change on the product the PIM has.
      for (const r of built.rows) {
        if (!r.errors.length && existing.has(r.sku)) r.changes = rowChanges(r, existing.get(r.sku));
      }
      setRows(built.rows);
      setUnknownHeaders(built.unknownHeaders);
      setSkippedSheets(parsed.skippedSheets ?? []);
      setExistingMap(existing);
      setShow('all');
      setShowIgnored(false);
      setPage(1);
      setPhase('preview');
      task.finish(`${built.rows.length} ${built.rows.length === 1 ? 'row' : 'rows'} ready to review`);
    } catch (err) {
      task.fail(err.message ?? 'Failed to parse the file.');
      setParseError(err.message ?? 'Failed to parse the file.');
      setFileName(null);
    }
  }

  async function handleImport() {
    setPhase('importing');
    setProgress({ done: 0, total: importRows.length });
    const task = startTask('Import', { detail: `Importing ${importRows.length} ${importRows.length === 1 ? 'product' : 'products'}…` });
    try {
      const summary = await importProducts(
        importRows,
        existingMap,
        (done, total) => setProgress({ done, total }),
        { task, createInOdoo: odooOn && createInOdoo },
      );
      task.finish(`${summary.created} created · ${summary.updated} updated`);
      // Fire-and-forget: link the whole batch to every API-connected channel
      // where the products already exist (Wix by SKU, Wayfair group ids).
      autoLinkChannels(importRows.map((r) => r.sku)).catch((err) =>
        console.error('Channel auto-link failed (non-fatal):', err),
      );
      setResult({ ok: true, ...summary, unchanged: unchangedRows.length });
      setPhase('done');
    } catch (err) {
      task.fail(err);
      setResult({ ok: false, message: err.message });
      setPhase('done');
    }
  }

  function reset() {
    setPhase('upload');
    setRows([]);
    setUnknownHeaders([]);
    setSkippedSheets([]);
    setExistingMap(new Map());
    setShow('all');
    setPage(1);
    setFileName(null);
    setParseError(null);
    setResult(null);
    setExpandedRow(null);
  }

  return (
    <div className="max-w-6xl">
      <Link
        to="/catalog"
        className="inline-flex items-center gap-1 min-h-6 sm:min-h-0 text-body-sm text-on-surface-variant hover:text-primary mb-4 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Catalog
      </Link>

      <header className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-display-lg text-on-surface">Import Products</h1>
          <p className="text-body-md text-on-surface-variant mt-1 max-w-[46ch]">
            Upload a spreadsheet to create or update products in bulk. Images and documents are added separately on each product.
          </p>
        </div>
        <BlankTemplateMenu onDownload={downloadTemplate} />
      </header>

      {phase === 'upload' && (
        // The "Choose file" button inside is the keyboard path; the zone itself
        // only takes clicks and drops.
        <div
          className={`rounded-2xl border-2 border-dashed py-20 px-6 text-center cursor-pointer transition-colors ${
            isDragging
              ? 'border-primary bg-primary-container/20'
              : 'border-outline bg-surface-container-lowest'
          }`}
          onClick={() => fileRef.current?.click()}
          onDragEnter={(e) => {
            e.preventDefault();
            dragDepth.current += 1;
            setIsDragging(true);
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setIsDragging(false);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            dragDepth.current = 0;
            setIsDragging(false);
            handleFile(e.dataTransfer.files?.[0]);
          }}
        >
          <FileSpreadsheet
            className={`w-12 h-12 mx-auto mb-4 transition-colors ${isDragging ? 'text-primary' : 'text-on-surface-variant opacity-40'}`}
            strokeWidth={1.5}
          />
          <p className="hidden sm:block text-body-lg text-on-surface mb-1">
            {isDragging ? 'Drop to upload' : 'Drop your .xlsx or .csv here'}
          </p>
          <p className="sm:hidden text-body-lg text-on-surface mb-1">Select a .xlsx or .csv file</p>
          <p className="text-body-sm text-on-surface-variant mb-6">
            Use the blank template or a PIM export (every sheet is read). SKU (Model Number), Brand and Category are required per row.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.csv"
            className="hidden"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              fileRef.current?.click();
            }}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
          >
            <Upload className="w-4 h-4" />
            Choose file
          </button>
          {parseError && (
            <div role="alert" className="mt-6 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-error-container text-on-error-container text-body-sm animate-banner-in">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {parseError}
            </div>
          )}
        </div>
      )}

      {phase === 'preview' && (
        <>
          {/* Summary bar */}
          <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-5 mb-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-6 flex-wrap">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-on-surface-variant" />
                <span className="text-body-md text-on-surface font-medium">{fileName}</span>
                <button
                  type="button"
                  onClick={reset}
                  className="p-1 rounded-full text-on-surface-variant hover:bg-on-surface/8 transition-colors"
                  title="Choose another file"
                  aria-label="Choose another file"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <Stat label="rows" value={rows.length} pressed={show === 'all'} onClick={() => showOnly('all')} title="Show every row" />
              <Stat label="new" value={newCount} tone="success" pressed={show === 'new'} onClick={() => showOnly('new')} title="Show only the new products" />
              <Stat label="updates" value={updateCount} tone="tertiary" pressed={show === 'updates'} onClick={() => showOnly('updates')} title="Show only the updates" />
              {unchangedRows.length > 0 && <Stat label="unchanged" value={unchangedRows.length} pressed={show === 'unchanged'} onClick={() => showOnly('unchanged')} title="Show only the products that already have every value of their row — they are not imported" />}
              {errorRows.length > 0 && <Stat label="with errors" value={errorRows.length} tone="error" pressed={show === 'errors'} onClick={() => showOnly('errors')} title="Show only the rows with errors" />}
            </div>
            <button
              type="button"
              onClick={handleImport}
              disabled={importRows.length === 0}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 transition-opacity disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed"
            >
              <Upload className="w-4 h-4" />
              Import {importRows.length} {importRows.length === 1 ? 'product' : 'products'}
            </button>
          </div>

          {importRows.length === 0 && unchangedRows.length > 0 && (
            <div role="status" className="mb-4 px-4 py-3 rounded-xl bg-surface-container border border-outline-variant text-on-surface text-body-sm">
              <span className="font-medium">Nothing to import: </span>
              the PIM already has every value of this file. Change a cell and upload it again to update that product.
            </div>
          )}

          {odooOn && newCount > 0 && (
            <label className="mb-4 flex items-start gap-2.5 px-4 py-3 rounded-xl border border-outline-variant bg-surface-container-lowest cursor-pointer">
              <input
                type="checkbox"
                checked={createInOdoo}
                onChange={(e) => setCreateInOdoo(e.target.checked)}
                className="mt-1 w-4 h-4 accent-primary flex-shrink-0"
              />
              <span>
                <span className="block text-body-md text-on-surface">
                  Create the {newCount} new {newCount === 1 ? 'product' : 'products'} in Odoo too
                </span>
                <span className="block text-body-sm text-on-surface-variant">
                  With SKU, category and brand, tracked in inventory. A SKU Odoo already has is not created again. Route, bill of materials, vendor and cost are filled in Odoo.
                </span>
              </span>
            </label>
          )}

          {skippedSheets.length > 0 && (
            <div role="status" className="mb-4 px-4 py-3 rounded-xl bg-surface-container border border-outline-variant text-on-surface text-body-sm">
              <span className="font-medium">{skippedSheets.length === 1 ? 'Sheet' : 'Sheets'} not read: </span>
              {skippedSheets.join(', ')}
              <span className="text-on-surface-variant"> — no SKU, Brand and Category columns, so {skippedSheets.length === 1 ? 'it holds' : 'they hold'} no products.</span>
            </div>
          )}

          {/* The columns the import does not read. A report has dozens of its
              own (completeness, stock, links…): the first few, the rest on
              demand. */}
          {unknownHeaders.length > 0 && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-warning-container/50 border border-warning-container text-on-warning-container text-body-sm">
              <span className="font-medium">{unknownHeaders.length} {unknownHeaders.length === 1 ? 'column' : 'columns'} not imported (read-only or not recognized): </span>
              {(showIgnored ? unknownHeaders : unknownHeaders.slice(0, 6)).join(', ')}
              {unknownHeaders.length > 6 && (
                <>
                  {!showIgnored && '… '}
                  <button type="button" onClick={() => setShowIgnored((v) => !v)} aria-expanded={showIgnored} className="ml-1 font-medium underline underline-offset-2">
                    {showIgnored ? 'Show fewer' : `Show all ${unknownHeaders.length}`}
                  </button>
                </>
              )}
            </div>
          )}

          {/* Rows table. On a phone it is wider than the page: it scrolls inside
              its own box (focusable, so the keyboard can scroll it), and the
              box is `relative` so the header's screen-reader text stays in it
              instead of making the whole page scroll sideways. */}
          <div className="relative rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-x-auto" tabIndex={0}>
            <table className="w-full">
              <thead>
                <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md font-medium text-on-surface-variant">
                  <th scope="col" className="text-left px-5 py-3">Row</th>
                  <th scope="col" className="text-left px-5 py-3">SKU</th>
                  <th scope="col" className="text-left px-5 py-3">Name</th>
                  <th scope="col" className="text-left px-5 py-3">Action</th>
                  <th scope="col" className="text-left px-5 py-3">Fields</th>
                  <th scope="col" className="px-5 py-3"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {pageRows.map((r) => {
                  const hasErrors = r.errors.length > 0;
                  const isUpdate = r.sku && existingMap.has(r.sku);
                  const isExpanded = expandedRow === r.rowNumber;
                  return (
                    <RowGroup
                      key={r.rowNumber}
                      row={r}
                      hasErrors={hasErrors}
                      isUpdate={isUpdate}
                      changes={isUpdate ? r.changes ?? [] : null}
                      isExpanded={isExpanded}
                      onToggle={() => setExpandedRow(isExpanded ? null : r.rowNumber)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-4">
            <Pagination
              label="Import rows"
              page={currentPage}
              pageSize={pageSize}
              total={shownRows.length}
              onPageChange={(n) => { setPage(n); setExpandedRow(null); }}
              onPageSizeChange={(n) => { setPageSize(n); setPage(1); setExpandedRow(null); }}
            />
          </div>
        </>
      )}

      {phase === 'importing' && (
        <div role="status" className="rounded-2xl border border-outline-variant bg-surface-container-lowest py-20 px-6 text-center">
          <Loader2 className="w-8 h-8 mx-auto mb-4 animate-spin text-primary" />
          <p className="text-body-lg text-on-surface">
            Importing {progress.done}/{progress.total}…
          </p>
        </div>
      )}

      {phase === 'done' && result && (
        <div role={result.ok ? 'status' : 'alert'} className="rounded-2xl border border-outline-variant bg-surface-container-lowest py-16 px-6 text-center">
          {result.ok ? (
            <>
              <CheckCircle2 className="w-10 h-10 mx-auto mb-4 text-success" />
              <p className="text-title-lg text-on-surface mb-2">Import complete</p>
              <p className="text-body-md text-on-surface-variant mb-8">
                {result.created} {result.created === 1 ? 'product' : 'products'} created · {result.updated} updated
                {result.unchanged > 0 && <> · {result.unchanged} already up to date, not touched</>}
                {result.familiesSynced > 0 && (
                  <> · {result.familiesSynced} {result.familiesSynced === 1 ? 'product' : 'products'} added to {result.familiesSynced === 1 ? 'its' : 'their'} variant family</>
                )}
                <br />
                Channel auto-link is running in the background — results land in the Activity Log.
              </p>
            </>
          ) : (
            <>
              <AlertCircle className="w-10 h-10 mx-auto mb-4 text-error" />
              <p className="text-title-lg text-on-surface mb-2">Import failed</p>
              <p className="text-body-md text-error mb-8">{result.message}</p>
            </>
          )}
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={reset}
              className="px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-on-surface/8 transition-colors"
            >
              Import another file
            </button>
            <button
              type="button"
              onClick={() => navigate('/catalog')}
              className="px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
            >
              Go to Catalog
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// A counter of the summary, and the filter of the rows below: pressed, the
// table shows only that kind (its label is underlined).
function Stat({ label, value, tone, pressed, onClick, title }) {
  const tones = {
    success: 'text-on-success-container bg-success-container',
    tertiary: 'text-on-tertiary-container bg-tertiary-container/40',
    error: 'text-on-error-container bg-error-container',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      title={title}
      className="group flex items-center gap-1.5 text-body-sm text-on-surface-variant rounded-lg"
    >
      <span className={`inline-flex items-center justify-center min-w-7 px-1.5 h-7 rounded-lg text-label-md font-bold ${tones[tone] ?? 'bg-surface-container text-on-surface'}`}>
        {value}
      </span>
      <span className={pressed ? 'text-on-surface font-medium underline underline-offset-4' : 'group-hover:text-on-surface'}>{label}</span>
    </button>
  );
}

// `changes` (a product the PIM has): what the row would change on it — none =
// unchanged, the row is not imported.
const clip = (s, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);
function RowGroup({ row, hasErrors, isUpdate, changes, isExpanded, onToggle }) {
  const missingCount = row.missing.length;
  const unchanged = !hasErrors && isUpdate && changes.length === 0;
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer transition-colors ${
          hasErrors ? 'bg-error-container/20 hover:bg-error-container/30' : 'hover:bg-surface-container-low/40'
        }`}
      >
        <td className="px-5 py-3 text-body-sm text-on-surface-variant">{row.rowNumber}</td>
        <td className="px-5 py-3 text-body-sm font-mono text-on-surface">{row.sku ?? '—'}</td>
        <td className="px-5 py-3 text-body-md text-on-surface truncate max-w-xs" title={row.columns.model_name ?? undefined}>
          {row.columns.model_name ?? '—'}
        </td>
        <td className="px-5 py-3">
          {hasErrors ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-lg text-label-md bg-error-container text-on-error-container">
              {row.errors.length} error{row.errors.length === 1 ? '' : 's'}
            </span>
          ) : unchanged ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-lg text-label-md bg-surface-container text-on-surface-variant">
              Unchanged
            </span>
          ) : isUpdate ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-lg text-label-md bg-tertiary-container/40 text-on-tertiary-container">
              Update
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded-lg text-label-md bg-success-container text-on-success-container">
              New
            </span>
          )}
        </td>
        <td className="px-5 py-3 text-body-sm">
          {isUpdate && !hasErrors ? (
            // a product the PIM has: what the row changes on it
            changes.length === 0
              ? <span className="text-on-surface-variant">No change</span>
              : <span className="text-on-surface font-medium">{changes.length} {changes.length === 1 ? 'change' : 'changes'}</span>
          ) : missingCount === 0 ? (
            <span className="text-success font-medium">All fields filled</span>
          ) : (
            <span className="text-on-surface-variant">{missingCount} missing</span>
          )}
        </td>
        <td className="px-5 py-3 text-right">
          {/* No handler: the click bubbles to the row's onToggle. */}
          <button
            type="button"
            aria-expanded={isExpanded}
            aria-label={`Show details for row ${row.rowNumber}`}
            className="inline-flex align-middle rounded"
          >
            <ChevronDown
              className={`w-4 h-4 text-on-surface-variant inline-block transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            />
          </button>
        </td>
      </tr>
      {isExpanded && (
        <tr className={hasErrors ? 'bg-error-container/10' : 'bg-surface-container-low/30'}>
          <td colSpan={6} className="px-5 py-4">
            {row.errors.length > 0 && (
              <div className="mb-3">
                <div className="text-label-md font-semibold text-error mb-1">Errors (row will be skipped)</div>
                <ul className="list-disc list-inside text-body-sm text-error space-y-0.5">
                  {row.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
            {isUpdate && !hasErrors ? (
              changes.length === 0 ? (
                <p className="text-body-sm text-on-surface-variant">The product already has every value of this row, so it is not imported.</p>
              ) : (
                <div>
                  <div className="text-label-md font-semibold text-on-surface mb-1">Changes</div>
                  <ul className="text-body-sm text-on-surface-variant space-y-1 [overflow-wrap:anywhere]">
                    {changes.map((c) => (
                      <li key={c.key}>
                        <span className="font-medium text-on-surface">{c.label}:</span>{' '}
                        {c.from ? clip(c.from) : <span className="italic">empty</span>}
                        <span aria-hidden="true"> → </span><span className="sr-only"> becomes </span>
                        <span className="text-on-surface">{clip(c.to)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            ) : row.missing.length > 0 ? (
              <div>
                <div className="text-label-md font-semibold text-on-surface mb-1">Missing fields</div>
                <p className="text-body-sm text-on-surface-variant">{row.missing.join(' · ')}</p>
              </div>
            ) : (
              <p className="text-body-sm text-success">Every expected field has a value.</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
