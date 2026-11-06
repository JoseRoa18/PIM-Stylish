import { useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, Clock, ShieldCheck, PlusCircle, RefreshCw, ListChecks } from 'lucide-react';
import { ThinkingOrb } from 'thinking-orbs';
import { submitWayfairAdditions, checkWayfairAdditionStatus } from '../api/wayfairSync';
import { describeFlaws, describeNotes, resultHeadline, resultSummary, statusHeadline } from '../lib/wayfairMessages';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { startTask } from '@/lib/taskProgress';

// Per-product "new listing" panel (Marketplaces tab): validate the PIM data
// against Wayfair's Product Addition questions, then create the listing.
// Validate never changes anything; Create only unlocks after a clean validation.
// New listings go to Wayfair CANADA (supplier 31948); Wayfair mirrors them to
// USA. The Canadian app has no sandbox: Validate runs against production and
// creates nothing.
const SUPPLIER_LABEL = { CAN: 'Canada', USA: 'USA' };
export default function WayfairAdditionCard({ product, supplier = 'CAN' }) {
  const { canEdit } = useAuth();
  const confirm = useConfirm();
  const hasSandbox = supplier !== 'CAN';
  const [sandbox, setSandbox] = useState(hasSandbox);
  const [busy, setBusy] = useState(null); // 'validate' | 'create' | 'status' | 'mapping' | null
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState(null);

  const row = result?.products?.[0];
  const skipped = result?.skipped?.[0];
  // A preview only lists the mapping; it never unlocks Create.
  const clean = !!row && !result?.preview && !row.errors?.length && !row.missingRequired?.length && !row.unmapped?.length;
  // Once it went to Wayfair, the same answer does not send it again.
  const canCreate = clean && result?.validateOnly !== false;
  const headline = row && result ? resultHeadline(row, result) : null;

  // mode: 'validate' | 'create' | 'mapping' (build only — every attribute the
  // PIM would send, with Wayfair's title; works for listed products too)
  async function run(mode) {
    const validateOnly = mode !== 'create';
    if (mode === 'create' && !sandbox) {
      const ok = await confirm({
        title: `Create ${product.sku} on Wayfair ${SUPPLIER_LABEL[supplier] ?? supplier}?`,
        message: `This creates a new listing in Wayfair's real catalog${supplier === 'CAN' ? ', and Wayfair mirrors it to USA' : ''}.`,
        confirmLabel: 'Create listing',
      });
      if (!ok) return;
    }
    setBusy(mode);
    setResult(null);
    setStatus(null);
    // One call: the stripe moves until Wayfair answers.
    const task = startTask(`Wayfair ${SUPPLIER_LABEL[supplier] ?? supplier} · ${product.sku}`, {
      detail: mode === 'create' ? `Creating the listing${sandbox ? ' (sandbox)' : ''}…` : mode === 'mapping' ? 'Building the mapped attributes…' : "Validating against Wayfair's questions…",
    });
    try {
      const data = await submitWayfairAdditions([product.sku], { supplier, validateOnly, sandbox, preview: mode === 'mapping' });
      task.finish(mode === 'create' ? 'Sent to Wayfair' : mode === 'mapping' ? 'Mapping ready' : 'Validated');
      setResult(data);
    } catch (err) {
      task.fail(err);
      setResult({ error: err.message });
    } finally {
      setBusy(null);
    }
  }

  async function refreshStatus() {
    if (!result?.requestId) return;
    setBusy('status');
    const task = startTask(`Wayfair ${SUPPLIER_LABEL[supplier] ?? supplier} · ${product.sku}`, { detail: 'Reading what Wayfair did…' });
    try {
      const data = await checkWayfairAdditionStatus(result.requestId, { supplier, sandbox });
      task.finish(`Wayfair: ${data?.status ?? 'read'}`);
      setStatus(data);
    } catch (err) {
      task.fail(err);
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
            <h2 className="text-title-lg text-on-surface leading-tight">Wayfair {SUPPLIER_LABEL[supplier] ?? supplier} · New listing</h2>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              {supplier === 'CAN' ? 'Created in Canada; Wayfair mirrors it to USA. Validate creates nothing.' : 'Product Addition · builds the listing from PIM data'}
            </p>
          </div>
        </div>
        {canEdit && hasSandbox && (
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
              onClick={() => run('validate')}
              disabled={!!busy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
            >
              {busy === 'validate' ? <ThinkingOrb state="solving" size={20} className="w-4 h-4" aria-hidden="true" /> : <ShieldCheck className="w-4 h-4" />}
              Validate
            </button>
            <button
              type="button"
              onClick={() => run('create')}
              disabled={!!busy || !canCreate}
              title={canCreate ? undefined : 'Validate first — fix every issue before creating'}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 transition-opacity disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed"
            >
              {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlusCircle className="w-4 h-4" />}
              {sandbox ? 'Create (sandbox)' : 'Create listing'}
            </button>
            <button
              type="button"
              onClick={() => run('mapping')}
              disabled={!!busy}
              title="Every attribute the PIM maps for this product, with Wayfair's title and the value it would send. Nothing is sent."
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
            >
              {busy === 'mapping' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ListChecks className="w-4 h-4" />}
              Mapped attributes
            </button>
            {result?.requestId && !result.preview && (
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
          <div role="alert" className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-error-container text-on-error-container animate-banner-in">
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
              <HeadlineIcon tone={headline.tone} />
              <span className="min-w-0 break-words">
                <span className="text-on-surface font-medium">{headline.title}</span>
                {headline.detail ? ` ${headline.detail}` : ''}
                <span className="block text-on-surface-variant">{resultSummary(row, result)}</span>
              </span>
            </div>
            <IssueList label="Fill these in the PIM" items={row.missingRequired} tone="error" />
            <IssueList label="Wayfair does not accept these values" items={row.unmapped?.map((u) => `${u.title}: "${u.value}"`)} tone="error" titles={row.unmapped?.map((u) => (u.options?.length ? `Valid: ${u.options.join(' · ')}` : ''))} />
            <IssueList label="Problems Wayfair found" items={describeFlaws(row.errors)} tone="error" />
            <IssueList label="Wayfair suggests (it does not block the listing)" items={describeFlaws(row.warnings)} tone="muted" />
            <IssueList label="Good to know" items={describeNotes(row.notes)} tone="muted" />
            <MappedTable rows={row.mapped} />
          </div>
        )}

        {status && (
          <div role="status" className="rounded-lg border border-outline-variant text-body-sm px-3 py-2">
            {status.error ? (
              <span className="text-error">{status.error}</span>
            ) : (
              <>
                {!status.products?.length && <span className="text-on-surface-variant">Wayfair has no result yet. Check again in a minute.</span>}
                {(status.products ?? []).map((p) => {
                  const line = statusHeadline(p, result?.validateOnly === false);
                  return (
                    <div key={p.sku} className="break-words space-y-2">
                      <div className="flex items-start gap-2" title={`Wayfair: validation ${p.validationStatus ?? '—'}, submission ${p.submissionStatus ?? '—'}`}>
                        <HeadlineIcon tone={line.tone} />
                        <span className="min-w-0">
                          <span className="text-on-surface font-medium">{line.title}</span> {line.detail}
                        </span>
                      </div>
                      <IssueList label="Problems Wayfair found" items={describeFlaws(p.errors)} tone="error" flush />
                      <IssueList label="Wayfair suggests (it does not block the listing)" items={describeFlaws(p.warnings)} tone="muted" flush />
                    </div>
                  );
                })}
                {result?.requestId && <p className="mt-2 text-label-sm text-on-surface-variant break-all">Wayfair reference: {result.requestId}</p>}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// Every attribute the PIM maps for the product (the rows of the Wayfair
// request), grouped by section; blank rows never appear here — see the
// "Missing in PIM" list for those.
const GROUP_ORDER = ['Listing', 'Copy', 'Specifications', 'Media', 'Pricing', 'Shipping & compliance'];
function MappedTable({ rows }) {
  if (!rows?.length) return null;
  const groups = GROUP_ORDER.filter((g) => rows.some((r) => r.group === g));
  return (
    <details className="px-3 py-2">
      <summary className="cursor-pointer text-label-sm text-primary hover:underline">Show all {rows.length} mapped attributes</summary>
      <div className="mt-2 space-y-3">
        {groups.map((g) => (
          <div key={g}>
            <div className="text-label-sm text-on-surface-variant mb-1">{g} · {rows.filter((r) => r.group === g).length}</div>
            <table className="w-full text-body-sm">
              <tbody className="divide-y divide-outline-variant/60">
                {rows.filter((r) => r.group === g).map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="py-1 pr-3 w-[40%] text-on-surface-variant break-words" title={r.id}>{r.title}</td>
                    <td className="py-1 text-on-surface break-words">{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </details>
  );
}

function HeadlineIcon({ tone }) {
  if (tone === 'error') return <AlertCircle className="w-4 h-4 mt-0.5 text-error flex-shrink-0" aria-hidden="true" />;
  if (tone === 'waiting') return <Clock className="w-4 h-4 mt-0.5 text-on-surface-variant flex-shrink-0" aria-hidden="true" />;
  if (tone === 'info') return <ListChecks className="w-4 h-4 mt-0.5 text-on-surface-variant flex-shrink-0" aria-hidden="true" />;
  return <CheckCircle2 className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" aria-hidden="true" />;
}

function IssueList({ label, items, tone, titles, flush = false }) {
  if (!items?.length) return null;
  const cls = tone === 'error' ? 'text-error' : 'text-on-surface-variant';
  return (
    <div className={flush ? '' : 'px-3 py-2'}>
      <div className="text-label-sm text-on-surface-variant">{label}</div>
      <ul className={`mt-0.5 space-y-0.5 ${cls}`}>
        {items.map((it, i) => (
          <li key={i} className="break-words" title={titles?.[i] || undefined}>
            {it}
            {titles?.[i] && <span className="sr-only"> ({titles[i]})</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
