import { useRef, useState } from 'react';
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
import { TEMPLATE_HEADERS } from '@/features/import/lib/importSchema';
import { fetchExistingProducts, importProducts } from '@/features/import/api/importProducts';

export default function ImportProducts() {
  const navigate = useNavigate();
  const fileRef = useRef(null);

  const [phase, setPhase] = useState('upload'); // upload | preview | importing | done
  const [fileName, setFileName] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [rows, setRows] = useState([]);
  const [unknownHeaders, setUnknownHeaders] = useState([]);
  const [existingMap, setExistingMap] = useState(new Map());
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState(null);
  const [expandedRow, setExpandedRow] = useState(null);

  const validRows = rows.filter((r) => r.errors.length === 0);
  const errorRows = rows.filter((r) => r.errors.length > 0);
  const newCount = validRows.filter((r) => !existingMap.has(r.sku)).length;
  const updateCount = validRows.length - newCount;

  function downloadTemplate() {
    const csv = '﻿' + TEMPLATE_HEADERS.map((h) => `"${h}"`).join(',') + '\r\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'stylish_pim_import_template.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function handleFile(file) {
    if (!file) return;
    setParseError(null);
    setFileName(file.name);
    try {
      const parsed = await parseSpreadsheetFile(file);
      if (parsed.rows.length === 0) {
        throw new Error('The file has headers but no data rows.');
      }
      const built = buildImportRows(parsed);
      const skus = built.rows.map((r) => r.sku).filter(Boolean);
      const existing = await fetchExistingProducts(skus);
      setRows(built.rows);
      setUnknownHeaders(built.unknownHeaders);
      setExistingMap(existing);
      setPhase('preview');
    } catch (err) {
      setParseError(err.message ?? 'Failed to parse the file.');
      setFileName(null);
    }
  }

  async function handleImport() {
    setPhase('importing');
    setProgress({ done: 0, total: validRows.length });
    try {
      const summary = await importProducts(validRows, existingMap, (done, total) =>
        setProgress({ done, total }),
      );
      setResult({ ok: true, ...summary });
      setPhase('done');
    } catch (err) {
      setResult({ ok: false, message: err.message });
      setPhase('done');
    }
  }

  function reset() {
    setPhase('upload');
    setRows([]);
    setUnknownHeaders([]);
    setExistingMap(new Map());
    setFileName(null);
    setParseError(null);
    setResult(null);
    setExpandedRow(null);
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Link
        to="/catalog"
        className="inline-flex items-center gap-1 text-body-sm text-on-surface-variant hover:text-primary mb-4 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Catalog
      </Link>

      <header className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-display-lg text-on-surface">Import Products</h1>
          <p className="text-body-md text-on-surface-variant mt-1">
            Upload a spreadsheet to create or update products in bulk. Images and documents are added separately on each product.
          </p>
        </div>
        <button
          type="button"
          onClick={downloadTemplate}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors"
        >
          <Download className="w-4 h-4" />
          Download blank template
        </button>
      </header>

      {phase === 'upload' && (
        <div
          className="rounded-2xl border-2 border-dashed border-outline-variant bg-surface-container-lowest py-20 px-6 text-center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            handleFile(e.dataTransfer.files?.[0]);
          }}
        >
          <FileSpreadsheet className="w-12 h-12 mx-auto mb-4 text-on-surface-variant opacity-40" strokeWidth={1.5} />
          <p className="text-body-lg text-on-surface mb-1">Drop your .xlsx or .csv here</p>
          <p className="text-body-sm text-on-surface-variant mb-6">
            First row must be the column headers. SKU (Model Number), Brand and Category are required per row.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.csv"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
          >
            <Upload className="w-4 h-4" />
            Choose file
          </button>
          {parseError && (
            <div className="mt-6 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-error-container text-on-error-container text-body-sm">
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
                  className="p-1 rounded-full text-on-surface-variant hover:bg-surface-container-low transition-colors"
                  title="Choose another file"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <Stat label="rows" value={rows.length} />
              <Stat label="new" value={newCount} tone="success" />
              <Stat label="updates" value={updateCount} tone="tertiary" />
              {errorRows.length > 0 && <Stat label="with errors" value={errorRows.length} tone="error" />}
            </div>
            <button
              type="button"
              onClick={handleImport}
              disabled={validRows.length === 0}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Upload className="w-4 h-4" />
              Import {validRows.length} {validRows.length === 1 ? 'product' : 'products'}
            </button>
          </div>

          {unknownHeaders.length > 0 && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-warning-container/50 border border-warning-container text-on-warning-container text-body-sm">
              <span className="font-medium">Ignored columns (not recognized): </span>
              {unknownHeaders.join(', ')}
            </div>
          )}

          {/* Rows table */}
          <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md font-medium text-on-surface-variant">
                  <th className="text-left px-5 py-3">Row</th>
                  <th className="text-left px-5 py-3">SKU</th>
                  <th className="text-left px-5 py-3">Name</th>
                  <th className="text-left px-5 py-3">Action</th>
                  <th className="text-left px-5 py-3">Completeness</th>
                  <th className="px-5 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {rows.map((r) => {
                  const hasErrors = r.errors.length > 0;
                  const isUpdate = r.sku && existingMap.has(r.sku);
                  const isExpanded = expandedRow === r.rowNumber;
                  return (
                    <RowGroup
                      key={r.rowNumber}
                      row={r}
                      hasErrors={hasErrors}
                      isUpdate={isUpdate}
                      isExpanded={isExpanded}
                      onToggle={() => setExpandedRow(isExpanded ? null : r.rowNumber)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {phase === 'importing' && (
        <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest py-20 px-6 text-center">
          <Loader2 className="w-8 h-8 mx-auto mb-4 animate-spin text-primary" />
          <p className="text-body-lg text-on-surface">
            Importing {progress.done}/{progress.total}…
          </p>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest py-16 px-6 text-center">
          {result.ok ? (
            <>
              <CheckCircle2 className="w-10 h-10 mx-auto mb-4 text-success" />
              <p className="text-title-lg text-on-surface mb-2">Import complete</p>
              <p className="text-body-md text-on-surface-variant mb-8">
                {result.created} {result.created === 1 ? 'product' : 'products'} created · {result.updated} updated
                {result.familiesSynced > 0 && (
                  <> · {result.familiesSynced} variant {result.familiesSynced === 1 ? 'family link' : 'family links'} re-synced</>
                )}
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
              className="px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors"
            >
              Import another file
            </button>
            <button
              type="button"
              onClick={() => navigate('/catalog')}
              className="px-5 py-2 rounded-full bg-primary text-on-primary text-body-md font-semibold hover:opacity-90 transition-opacity"
            >
              Go to Catalog
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }) {
  const tones = {
    success: 'text-on-success-container bg-success-container',
    tertiary: 'text-on-tertiary-container bg-tertiary-container/40',
    error: 'text-on-error-container bg-error-container',
  };
  return (
    <div className="flex items-center gap-1.5 text-body-sm text-on-surface-variant">
      <span className={`inline-flex items-center justify-center min-w-7 px-1.5 h-7 rounded-lg text-label-md font-bold ${tones[tone] ?? 'bg-surface-container text-on-surface'}`}>
        {value}
      </span>
      {label}
    </div>
  );
}

function RowGroup({ row, hasErrors, isUpdate, isExpanded, onToggle }) {
  const missingCount = row.missing.length;
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
        <td className="px-5 py-3 text-body-md text-on-surface truncate max-w-xs">
          {row.columns.model_name ?? '—'}
        </td>
        <td className="px-5 py-3">
          {hasErrors ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-label-md bg-error-container text-on-error-container">
              {row.errors.length} error{row.errors.length === 1 ? '' : 's'}
            </span>
          ) : isUpdate ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-label-md bg-tertiary-container/40 text-on-tertiary-container">
              Update
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-label-md bg-success-container text-on-success-container">
              New
            </span>
          )}
        </td>
        <td className="px-5 py-3 text-body-sm">
          {missingCount === 0 ? (
            <span className="text-success font-medium">All fields filled</span>
          ) : (
            <span className="text-on-surface-variant">{missingCount} missing</span>
          )}
        </td>
        <td className="px-5 py-3 text-right">
          <ChevronDown
            className={`w-4 h-4 text-on-surface-variant inline-block transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
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
            {row.missing.length > 0 ? (
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
