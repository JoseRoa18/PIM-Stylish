import { useState } from 'react';
import {
  CloudDownload,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Link as LinkIcon,
} from 'lucide-react';
import { runWixImport } from '../api/wixSync';

export default function WixConnectorCard() {
  const [phase, setPhase] = useState('idle'); // idle | previewing | preview-ready | applying | done | error
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function handlePreview() {
    setPhase('previewing');
    setError(null);
    setResult(null);
    try {
      const data = await runWixImport({ dryRun: true });
      setPreview(data);
      setPhase('preview-ready');
    } catch (err) {
      setError(err.message);
      setPhase('error');
    }
  }

  async function handleApply() {
    setPhase('applying');
    setError(null);
    try {
      const data = await runWixImport({ dryRun: false });
      setResult(data);
      setPhase('done');
    } catch (err) {
      setError(err.message);
      setPhase('error');
    }
  }

  function handleReset() {
    setPhase('idle');
    setPreview(null);
    setResult(null);
    setError(null);
  }

  const busy = phase === 'previewing' || phase === 'applying';

  return (
    <section className="rounded-xl border border-outline-variant bg-surface-container-lowest p-6">
      <header className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-xl bg-primary-container text-on-primary-container flex items-center justify-center font-bold text-lg">
            W
          </div>
          <div>
            <h3 className="text-title-lg text-on-surface">Wix Stores</h3>
            <p className="text-body-sm text-on-surface-variant">
              Link PIM products to their Wix counterparts by SKU. Required before pushing edits to Wix.
            </p>
          </div>
        </div>
      </header>

      {phase === 'idle' && (
        <div className="space-y-4">
          <p className="text-body-md text-on-surface-variant">
            This finds Wix products with the same SKU as PIM products and stores the
            Wix product id on each row. It does <strong>not</strong> insert new products
            or modify any other field.
          </p>
          <button
            type="button"
            onClick={handlePreview}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
          >
            <CloudDownload className="w-4 h-4" />
            Preview Link with Wix
          </button>
        </div>
      )}

      {busy && (
        <div className="flex items-center gap-3 text-on-surface-variant">
          <RefreshCw className="w-5 h-5 animate-spin" />
          <span className="text-body-md">
            {phase === 'previewing' ? 'Fetching Wix catalog…' : 'Applying links…'}
          </span>
        </div>
      )}

      {phase === 'preview-ready' && preview && (
        <PreviewPanel preview={preview} onConfirm={handleApply} onCancel={handleReset} />
      )}

      {phase === 'done' && result && (
        <ResultPanel result={result} onReset={handleReset} />
      )}

      {phase === 'error' && (
        <div className="rounded-lg border border-error/40 bg-error-container/30 p-4">
          <div className="flex items-start gap-2 mb-2">
            <AlertCircle className="w-5 h-5 text-error flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-label-lg text-on-surface font-semibold">Linking failed</p>
              <p className="text-body-sm text-on-surface-variant mt-1 break-words">{error}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="mt-2 px-3 py-1.5 rounded-full bg-surface-container text-on-surface text-label-md hover:bg-surface-container-high transition-colors"
          >
            Try again
          </button>
        </div>
      )}
    </section>
  );
}

function PreviewPanel({ preview, onConfirm, onCancel }) {
  const { summary, samples, skippedNoSku } = preview;
  const canApply = summary.newLinks > 0 || summary.alreadyLinked > 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile icon={CloudDownload} label="Found in Wix" value={summary.wixTotal} />
        <StatTile icon={LinkIcon} label="New links" value={summary.newLinks} tone="positive" />
        <StatTile icon={CheckCircle2} label="Already linked" value={summary.alreadyLinked} />
        <StatTile icon={AlertCircle} label="Wix-only (skipped)" value={summary.wixOnly} />
      </div>

      {summary.skippedNoSku > 0 && (
        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
          <p className="text-label-md text-on-surface font-semibold mb-1">
            {summary.skippedNoSku} Wix product{summary.skippedNoSku === 1 ? '' : 's'} skipped (no SKU)
          </p>
          <ul className="text-body-sm text-on-surface-variant list-disc list-inside space-y-0.5 max-h-32 overflow-y-auto">
            {skippedNoSku.slice(0, 10).map((p) => (
              <li key={p.wix_product_id}>{p.name || `(unnamed, ${p.wix_product_id})`}</li>
            ))}
            {skippedNoSku.length > 10 && (
              <li className="italic">…and {skippedNoSku.length - 10} more</li>
            )}
          </ul>
        </div>
      )}

      {samples.newLinks?.length > 0 && (
        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
          <p className="text-label-md text-on-surface font-semibold mb-2">
            Will newly link (sample):
          </p>
          <ul className="text-body-sm text-on-surface-variant space-y-0.5">
            {samples.newLinks.map((r) => (
              <li key={r.sku} className="truncate">
                <span className="font-mono text-on-surface">{r.sku}</span>
                {r.name && <span className="ml-2">{r.name}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {samples.wixOnly?.length > 0 && (
        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
          <p className="text-label-md text-on-surface font-semibold mb-2">
            Wix products with no PIM match (sample):
          </p>
          <ul className="text-body-sm text-on-surface-variant space-y-0.5">
            {samples.wixOnly.map((r) => (
              <li key={r.wix_product_id} className="truncate">
                <span className="font-mono text-on-surface">{r.sku}</span>
                {r.name && <span className="ml-2">{r.name}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canApply}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <CheckCircle2 className="w-4 h-4" />
          Apply links
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-full bg-surface-container text-on-surface text-label-md font-semibold hover:bg-surface-container-high transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ResultPanel({ result, onReset }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg border border-tertiary/40 bg-tertiary-container/30 p-4">
        <CheckCircle2 className="w-5 h-5 text-tertiary flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-label-lg text-on-surface font-semibold">
            Linked {result.applied} product{result.applied === 1 ? '' : 's'} to Wix.
          </p>
          <p className="text-body-sm text-on-surface-variant mt-1">
            New links: {result.summary.newLinks} · Already linked: {result.summary.alreadyLinked} ·
            {' '}Wix-only: {result.summary.wixOnly}
            {result.summary.skippedNoSku > 0 && ` · No SKU: ${result.summary.skippedNoSku}`}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onReset}
        className="px-4 py-2 rounded-full bg-surface-container text-on-surface text-label-md font-semibold hover:bg-surface-container-high transition-colors"
      >
        Run again
      </button>
    </div>
  );
}

function StatTile({ icon: Icon, label, value, tone }) {
  const toneClasses =
    tone === 'positive'
      ? 'border-tertiary/40 bg-tertiary-container/20'
      : 'border-outline-variant bg-surface-container-low';
  return (
    <div className={`rounded-lg border ${toneClasses} p-3`}>
      <div className="flex items-center gap-2 text-on-surface-variant mb-1">
        <Icon className="w-4 h-4" />
        <span className="text-label-md">{label}</span>
      </div>
      <p className="text-display-sm text-on-surface font-semibold">{value}</p>
    </div>
  );
}
