import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, Download, Loader2, Upload } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import Dialog from '@/components/ui/Dialog';
import FileDropzone from '@/components/ui/FileDropzone';

// Listing Health → Where to Buy → "Export" and "Import links" (user,
// 2026-10-21): the links in an Excel with the PIM's look — what the audit
// found on each (Broken, Wrong product, Link to add…) — and the same file back
// to change many links at once: its "New Link" column is read, the changes
// are shown first, and "Save and publish" writes them into the products'
// lists and both Stylish pages. The Excel code loads on click.

const load = () => import('@/features/dashboard/api/whereToBuyExcel');
const SHOWN = 300; // changes listed in the dialog
const ACTION = {
  add: { label: 'Add', cls: 'bg-success-container text-on-success-container' },
  replace: { label: 'Replace', cls: 'bg-warning-container text-on-warning-container' },
  remove: { label: 'Remove', cls: 'bg-error-container text-on-error-container' },
};
const shortUrl = (u) => String(u ?? '').replace(/^https?:\/\/(www\.)?/, '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const PUBLISH_TEXT = { published: 'published', up_to_date: 'already up to date', later: 'queued (Wix asked to wait — written within minutes)', no_links: 'left with no links', not_linked: 'not linked to a Wix product', not_found: 'not found on Wix', error: 'failed' };

export default function WhereToBuyExcel({ onImported }) {
  const { canEdit } = useAuth();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(null); // 'read' | 'apply'
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  const runExport = async () => {
    setExporting(true);
    setExportError(null);
    try { await (await load()).downloadWhereToBuyExcel(); } catch (e) { setExportError(e.message); } finally { setExporting(false); }
  };

  const reset = () => { setFile(null); setPlan(null); setError(null); setResult(null); setProgress(null); };
  const close = () => { if (busy !== 'apply') { setOpen(false); reset(); } };

  const read = async (f) => {
    reset();
    setFile(f);
    setBusy('read');
    try { setPlan(await (await load()).readWhereToBuyImport(f)); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const apply = async () => {
    setBusy('apply');
    setError(null);
    try {
      const r = await (await load()).applyWhereToBuyImport(plan, (p) => setProgress(p));
      setResult(r);
      onImported?.();
    } catch (e) { setError(e.message); } finally { setBusy(null); setProgress(null); }
  };

  const count = (a) => plan?.changes.filter((c) => c.action === a).length ?? 0;
  const products = plan ? new Set(plan.changes.map((c) => c.sku)).size : 0;

  return (
    <>
      <button
        type="button"
        onClick={runExport}
        disabled={exporting}
        aria-busy={exporting}
        className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline text-label-lg text-on-surface hover:bg-surface-container disabled:opacity-40"
        title="Download every link with what the check found (Broken, Wrong product, Link to add…) as an Excel"
      >
        {exporting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />}
        {exporting ? 'Exporting' : 'Export'}
      </button>
      {canEdit && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline text-label-lg text-on-surface hover:bg-surface-container"
          title="Upload the Excel with new links in its New Link column"
        >
          <Upload className="w-4 h-4" aria-hidden="true" />
          Import links
        </button>
      )}
      {exportError && <p role="alert" className="basis-full text-body-sm text-error">{exportError}</p>}

      {open && (
        <Dialog
          onClose={close}
          title="Import Where to Buy links"
          subtitle="Upload the Where to Buy Excel after writing the new addresses in its green New Link column (REMOVE takes a link off). The changes are shown first; Save and publish writes them into each product's list and both Stylish pages."
          maxWidth="max-w-5xl"
          footer={(
            <>
              <button type="button" onClick={close} disabled={busy === 'apply'} className="px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low disabled:opacity-40">
                {result ? 'Close' : 'Cancel'}
              </button>
              {plan && !result && (
                <button type="button" onClick={reset} disabled={busy != null} className="px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low disabled:opacity-40">
                  Choose another file
                </button>
              )}
              {plan && !result && plan.changes.length > 0 && (
                <button
                  type="button"
                  onClick={apply}
                  disabled={busy != null}
                  aria-busy={busy === 'apply'}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-body-md hover:bg-primary/90 disabled:opacity-40"
                >
                  {busy === 'apply' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                  {busy === 'apply'
                    ? (progress ? `Publishing ${progress.done} of ${plural(progress.total, 'product')}` : 'Saving')
                    : `Save and publish ${plural(products, 'product')}`}
                </button>
              )}
            </>
          )}
        >
          {!plan && (
            <FileDropzone
              onFile={read}
              accept=".xlsx"
              disabled={busy != null}
              className="flex flex-col items-center justify-center gap-1 px-4 py-8 rounded-xl border-2 border-dashed border-outline-variant text-center hover:bg-surface-container-low transition-colors"
            >
              <span className="inline-flex items-center gap-2 text-body-md font-medium text-on-surface">
                {busy === 'read' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Upload className="w-4 h-4" aria-hidden="true" />}
                {busy === 'read' ? `Reading ${file?.name ?? 'the file'}…` : 'Drop the Where to Buy Excel here'}
              </span>
              {busy !== 'read' && <span className="text-body-sm text-on-surface-variant">or click to browse · start from Export, so the columns are the PIM&apos;s</span>}
            </FileDropzone>
          )}

          {error && (
            <div role="alert" className="mt-3 rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
              {error}
            </div>
          )}

          {result && (
            <div role="status" className="rounded-xl bg-surface-container px-4 py-3 text-body-sm text-on-surface space-y-1">
              <p className="font-semibold">
                {plural(result.products, 'product')} updated: {result.added} added, {result.replaced} replaced, {result.removed} removed.
              </p>
              <p className="text-on-surface-variant">
                Stylish pages: {Object.entries(result.statuses).map(([s, n]) => `${n} ${PUBLISH_TEXT[s] ?? s}`).join(' · ') || 'none to write'}. The new links are opened within minutes; a broken one leaves the pages by itself.
              </p>
              {result.failures.length > 0 && <p className="text-error">Not published: {result.failures.join('; ')} — the links are saved; publish them again from the products&apos; Where to Buy tab.</p>}
            </div>
          )}

          {plan && !result && (
            <div className="space-y-4">
              <p className="text-body-sm text-on-surface-variant">
                <span className="font-semibold text-on-surface">{file?.name}</span> · {plural(plan.rowsRead, 'row')} with a New Link
              </p>
              <div className="flex flex-wrap gap-2" role="list" aria-label="What the file changes">
                {[
                  [ACTION.add, count('add'), 'to add'],
                  [ACTION.replace, count('replace'), 'to replace'],
                  [ACTION.remove, count('remove'), 'to remove'],
                ].map(([a, n, text]) => (
                  <span key={text} role="listitem" className={`px-2.5 py-1 rounded-lg text-label-lg font-semibold tabular-nums ${a.cls}`}>{n} {text}</span>
                ))}
                <span role="listitem" className="px-2.5 py-1 rounded-lg text-label-lg tabular-nums bg-surface-container-high text-on-surface-variant">{plan.unchanged} already as the file says</span>
                {plan.problems.length > 0 && <span role="listitem" className="px-2.5 py-1 rounded-lg text-label-lg font-semibold tabular-nums bg-warning-container text-on-warning-container">{plural(plan.problems.length, 'row')} not used</span>}
              </div>

              {plan.changes.length === 0 && (
                <p className="text-body-sm text-on-surface-variant">Nothing to change: write the new addresses in the New Link column, then upload the file again.</p>
              )}

              {plan.changes.length > 0 && (
                <div className="overflow-x-auto max-h-[22rem] overflow-y-auto rounded-xl border border-outline-variant">
                  <table className="w-full min-w-[44rem] table-fixed text-body-sm">
                    <caption className="sr-only">Changes in the file</caption>
                    <colgroup>
                      <col className="w-[8.5rem]" />
                      <col className="w-[10rem]" />
                      <col className="w-[6rem]" />
                      <col />
                    </colgroup>
                    <thead className="sticky top-0 bg-surface-container-low">
                      <tr className="text-label-md text-on-surface-variant text-left">
                        <th scope="col" className="py-2 px-3 font-semibold">SKU</th>
                        <th scope="col" className="py-2 pr-3 font-semibold">Store</th>
                        <th scope="col" className="py-2 pr-3 font-semibold">Change</th>
                        <th scope="col" className="py-2 pr-3 font-semibold">Address</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/60">
                      {plan.changes.slice(0, SHOWN).map((c) => (
                        <tr key={`${c.sku}|${c.retailer}`} className="align-middle">
                          <th scope="row" className="py-1.5 px-3 text-left font-semibold text-on-surface whitespace-nowrap">
                            <Link to={`/catalog/${encodeURIComponent(c.sku)}?tab=where_to_buy`} className="hover:underline" target="_blank" rel="noreferrer">{c.sku}</Link>
                          </th>
                          <td className="py-1.5 pr-3 truncate text-on-surface" title={c.store}>{c.store}</td>
                          <td className="py-1.5 pr-3">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-label-md font-semibold ${ACTION[c.action].cls}`}>{ACTION[c.action].label}</span>
                          </td>
                          <td className="py-1.5 pr-3 min-w-0" title={[c.from && `Now: ${c.from}`, c.to && `New: ${c.to}`, c.where].filter(Boolean).join('\n')}>
                            <span className="flex items-center gap-1.5 min-w-0">
                              {c.from && <span className={`truncate ${c.action === 'replace' ? 'text-on-surface-variant line-through' : 'text-on-surface'}`}>{shortUrl(c.from)}</span>}
                              {c.action === 'replace' && (
                                <>
                                  <ArrowRight className="w-3.5 h-3.5 flex-shrink-0 text-on-surface-variant" aria-hidden="true" />
                                  <span className="sr-only">replaced by</span>
                                </>
                              )}
                              {c.to && <span className="truncate text-on-surface">{shortUrl(c.to)}</span>}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {plan.changes.length > SHOWN && <p className="px-3 py-2 text-body-sm text-on-surface-variant">…and {plan.changes.length - SHOWN} more.</p>}
                </div>
              )}

              {plan.problems.length > 0 && (
                <div>
                  <h3 className="text-label-lg font-semibold text-on-surface">Rows not used</h3>
                  {/* focusable: the keyboard can scroll a long list */}
                  <ul tabIndex={0} aria-label="Rows not used" className="mt-1.5 max-h-40 overflow-y-auto rounded-xl border border-outline-variant divide-y divide-outline-variant/60 text-body-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                    {plan.problems.map((p, i) => (
                      <li key={i} className="px-3 py-1.5 flex flex-wrap gap-x-3">
                        <span className="text-on-surface-variant whitespace-nowrap">{p.where}</span>
                        <span className="font-semibold text-on-surface">{[p.sku, p.store].filter(Boolean).join(' · ') || '—'}</span>
                        <span className="text-on-surface">{p.problem}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
