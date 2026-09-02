import { useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, ShieldCheck, PlusCircle, RefreshCw } from 'lucide-react';
import { ThinkingOrb } from 'thinking-orbs';
import { submitWayfairAdditions, checkWayfairAdditionStatus } from '../api/wayfairSync';
import { useAuth } from '@/features/auth/AuthContext';

// Per-product "new listing" panel (Marketplaces tab): validate the PIM data
// against Wayfair's Product Addition questions, then create the listing.
// Validate never changes anything; Create only unlocks after a clean validation.
export default function WayfairAdditionCard({ product, supplier = 'USA' }) {
  const { canEdit } = useAuth();
  const [sandbox, setSandbox] = useState(true);
  const [busy, setBusy] = useState(null); // 'validate' | 'create' | 'status' | null
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState(null);

  const row = result?.products?.[0];
  const skipped = result?.skipped?.[0];
  const clean = !!row && !row.errors?.length && !row.missingRequired?.length && !row.unmapped?.length;

  async function run(validateOnly) {
    if (!validateOnly && !sandbox && !window.confirm(`Create ${product.sku} as a NEW Wayfair ${supplier} listing?`)) return;
    setBusy(validateOnly ? 'validate' : 'create');
    setResult(null);
    setStatus(null);
    try {
      const data = await submitWayfairAdditions([product.sku], { supplier, validateOnly, sandbox });
      setResult(data);
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setBusy(null);
    }
  }

  async function refreshStatus() {
    if (!result?.requestId) return;
    setBusy('status');
    try {
      setStatus(await checkWayfairAdditionStatus(result.requestId, { supplier, sandbox }));
    } catch (err) {
      setStatus({ error: err.message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-8 py-5 border-b border-outline-variant flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-brand-wayfair/15 text-brand-wayfair flex items-center justify-center text-label-lg font-bold flex-shrink-0">
            WF
          </div>
          <div>
            <h2 className="text-title-lg text-on-surface leading-tight">Wayfair {supplier} · New listing</h2>
            <p className="text-body-sm text-on-surface-variant mt-0.5">Product Addition · builds the listing from PIM data</p>
          </div>
        </div>
        {canEdit && (
          <label className="inline-flex items-center gap-2 text-label-sm text-on-surface-variant cursor-pointer" title="Sandbox validates only — nothing is created on Wayfair">
            <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} className="accent-primary" />
            Sandbox (test)
          </label>
        )}
      </div>

      <div className="px-8 py-5 space-y-3">
        {canEdit && (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => run(true)}
              disabled={!!busy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
            >
              {busy === 'validate' ? <ThinkingOrb state="solving" size={20} className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
              Validate
            </button>
            <button
              type="button"
              onClick={() => run(false)}
              disabled={!!busy || !clean}
              title={clean ? undefined : 'Validate first — fix every issue before creating'}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 transition-opacity disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed"
            >
              {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlusCircle className="w-4 h-4" />}
              {sandbox ? 'Create (sandbox)' : 'Create listing'}
            </button>
            {result?.requestId && !result.validateOnly && (
              <button
                type="button"
                onClick={refreshStatus}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full border border-outline-variant text-label-md hover:bg-surface-container-low transition-colors disabled:opacity-50"
              >
                {busy === 'status' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Check status
              </button>
            )}
          </div>
        )}

        {result?.error && (
          <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-error-container text-on-error-container animate-banner-in">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span className="break-words">{result.error}</span>
          </div>
        )}

        {skipped && !row && (
          <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-surface-container-low text-on-surface-variant">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span className="break-words">{skipped.reason}</span>
          </div>
        )}

        {row && (
          <div className="rounded-lg border border-outline-variant divide-y divide-outline-variant text-body-sm">
            <div className="flex items-start gap-2 px-3 py-2">
              {clean ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" /> : <AlertCircle className="w-4 h-4 mt-0.5 text-error flex-shrink-0" />}
              <span className="min-w-0 break-words">
                <span className="text-on-surface-variant">{result.env} · </span>
                {row.className} (class {row.classId}) · {row.attributes} attributes · {row.images} images · {row.documents} documents
                {row.status ? ` · ${row.status}` : ''}
                {result.requestId && !result.validateOnly ? ` · request ${result.requestId}` : ''}
              </span>
            </div>
            <IssueList label="Missing in PIM (required)" items={row.missingRequired} tone="error" />
            <IssueList label="Not accepted by Wayfair" items={row.unmapped?.map((u) => `${u.title}: "${u.value}"`)} tone="error" titles={row.unmapped?.map((u) => (u.options?.length ? `Valid: ${u.options.join(' · ')}` : ''))} />
            <IssueList label="Wayfair errors" items={row.errors?.map((e) => `${e.attributeId}: ${e.flaw}`)} tone="error" />
            <IssueList label="Wayfair warnings" items={row.warnings?.map((e) => `${e.attributeId}: ${e.flaw}`)} tone="muted" />
            <IssueList label="Notes" items={row.notes} tone="muted" />
          </div>
        )}

        {status && (
          <div className="rounded-lg border border-outline-variant text-body-sm px-3 py-2">
            {status.error ? (
              <span className="text-error">{status.error}</span>
            ) : (
              (status.products ?? []).map((p) => (
                <div key={p.sku} className="break-words">
                  <span className="text-on-surface-variant">{p.sku}: </span>
                  validation {p.validationStatus ?? '—'} · submission {p.submissionStatus ?? '—'}
                  {p.errors?.length ? ` · ${p.errors.length} errors` : ''}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function IssueList({ label, items, tone, titles }) {
  if (!items?.length) return null;
  const cls = tone === 'error' ? 'text-error' : 'text-on-surface-variant';
  return (
    <div className="px-3 py-2">
      <div className="text-label-sm text-on-surface-variant">{label}</div>
      <ul className={`mt-0.5 space-y-0.5 ${cls}`}>
        {items.map((it, i) => (
          <li key={i} className="break-words" title={titles?.[i] || undefined}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
