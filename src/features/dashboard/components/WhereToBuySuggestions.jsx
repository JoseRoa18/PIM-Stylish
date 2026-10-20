import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ExternalLink, Lightbulb, Loader2 } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import Dialog from '@/components/ui/Dialog';
import { loadWhereToBuySuggestions } from '@/features/dashboard/api/whereToBuy';
import { WTB_RETAILERS } from '@/features/dashboard/lib/whereToBuy';

// Listing Health → Where to Buy → the "Suggested links" button (user,
// 2026-10-20: "1 hazlo" / "2 hazlo"; a button, not a section of the panel).
// The right address of a link that opens the wrong product, a broken link or
// a missing one, found by the audit and OPENED before it shows here: its page
// shows the product's own SKU (or its own store id). The button opens the
// list; "Use" writes the address into the product's list and publishes the
// product's Stylish pages, as the product's Where to Buy tab does; a
// dismissed suggestion does not come back.

const WHY = {
  wrong_link: { label: 'Wrong product', cls: 'bg-warning-container text-on-warning-container', hint: 'The current link opens another product or option' },
  broken_link: { label: 'Broken', cls: 'bg-error-container text-on-error-container', hint: 'The current link does not open' },
  missing: { label: 'Link to add', cls: 'bg-surface-container-high text-on-surface-variant', hint: 'No link to this store yet' },
};
const STORE_ORDER = new Map(WTB_RETAILERS.map((r, i) => [r.key, i]));
const storeLabel = (k) => WTB_RETAILERS.find((r) => r.key === k)?.label ?? k;
const shortUrl = (u) => String(u ?? '').replace(/^https?:\/\/(www\.)?/, '');
const priceText = (s) => (s.price == null ? '' : `${s.currency === 'USD' ? '$' : s.currency === 'CAD' ? 'C$' : ''}${Number(s.price).toFixed(2)}`);
const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

export default function WhereToBuySuggestions({ skus, onApplied }) {
  const { canEdit } = useAuth();
  const confirm = useConfirm();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(null);
  const [store, setStore] = useState('all');
  const [busy, setBusy] = useState(null); // a suggestion id, or 'all'
  const [progress, setProgress] = useState(null);
  const [message, setMessage] = useState(null);

  const reload = async () => {
    try { setData(await loadWhereToBuySuggestions()); setError(null); } catch (e) { setError(e); }
  };
  useEffect(() => { reload(); }, []);

  // One suggestion per product and store (the newest opened), for the
  // products of the site on show.
  const list = useMemo(() => {
    const seen = new Set();
    return [...(data?.ready ?? [])]
      .sort((a, b) => (b.checked_at ?? '').localeCompare(a.checked_at ?? ''))
      .filter((s) => (!skus || skus.has(s.sku)) && !seen.has(`${s.sku}|${s.retailer}`) && seen.add(`${s.sku}|${s.retailer}`))
      .sort((a, b) => a.sku.localeCompare(b.sku) || (STORE_ORDER.get(a.retailer) ?? 99) - (STORE_ORDER.get(b.retailer) ?? 99));
  }, [data, skus]);
  const stores = useMemo(() => {
    const by = new Map();
    for (const s of list) by.set(s.retailer, (by.get(s.retailer) ?? 0) + 1);
    return [...by.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n, label: storeLabel(key) }));
  }, [list]);
  const shown = store === 'all' ? list : list.filter((s) => s.retailer === store);

  if (!data || (!list.length && !data.checking)) return null;

  const applySuggestions = async (items, key) => {
    setBusy(key);
    setError(null);
    setMessage(null);
    setProgress(items.length > 1 ? { done: 0, total: new Set(items.map((s) => s.sku)).size, errors: 0 } : null);
    try {
      const { applyWhereToBuySuggestions } = await import('@/features/products/api/whereToBuy');
      const r = await applyWhereToBuySuggestions(items, (p) => setProgress(p));
      setMessage(r.errors
        ? `${r.done - r.errors} of ${r.done} products updated. Not updated: ${r.failures.slice(0, 3).join('; ')}${r.failures.length > 3 ? '…' : ''}`
        : `${r.done} product${r.done === 1 ? '' : 's'} updated — the links are saved and the Stylish pages published.`);
      await reload();
      onApplied?.();
    } catch (e) { setError(e); } finally { setBusy(null); setProgress(null); }
  };
  const useAll = async () => {
    const ok = await confirm({
      title: `Use ${shown.length} suggested link${shown.length === 1 ? '' : 's'}?`,
      message: `Each product's list gets the suggested address for that store (it replaces the current link) and its Stylish pages are published, one product after the other${store === 'all' ? '' : ` — ${storeLabel(store)} only`}.`,
      confirmLabel: 'Use all',
    });
    if (ok) await applySuggestions(shown, 'all');
  };
  const dismiss = async (s) => {
    setBusy(s.id);
    setError(null);
    try {
      const { dismissWhereToBuySuggestion } = await import('@/features/products/api/whereToBuy');
      await dismissWhereToBuySuggestion(s);
      await reload();
    } catch (e) { setError(e); } finally { setBusy(null); }
  };
  // A batch of uses keeps going until it is done; the dialog closes after.
  const close = () => { if (busy !== 'all') { setOpen(false); setMessage(null); } };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title={data.checking ? `${list.length} ready to use · ${data.checking} more being checked` : `${list.length} ready to use`}
        className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline text-label-lg text-on-surface hover:bg-surface-container"
      >
        <Lightbulb className="w-4 h-4 text-primary" aria-hidden="true" />
        Suggested links
        <span className="min-w-[1.5rem] px-1.5 rounded-full bg-primary text-on-primary text-label-md font-semibold tabular-nums">{list.length}</span>
      </button>

      {open && (
        <Dialog
          onClose={close}
          title={`Suggested links · ${list.length}`}
          subtitle={`The right address for a wrong, broken or missing link, found by the PIM and opened first: its page shows the product. Use saves it in the product's list and publishes its Stylish pages.${data.checking ? ` ${data.checking} more are being checked.` : ''}`}
          maxWidth="max-w-6xl"
          footer={(
            <>
              <button type="button" onClick={close} disabled={busy === 'all'} className="px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low disabled:opacity-40">
                Close
              </button>
              {canEdit && shown.length > 1 && (
                <button
                  type="button"
                  onClick={useAll}
                  disabled={busy != null}
                  aria-busy={busy === 'all'}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-body-md hover:bg-primary/90 disabled:opacity-40"
                >
                  {busy === 'all' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                  {busy === 'all' && progress ? `Publishing ${progress.done} of ${progress.total}` : `Use all ${shown.length}`}
                </button>
              )}
            </>
          )}
        >
          {stores.length > 1 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Store">
              {[{ key: 'all', label: 'All stores', n: list.length }, ...stores].map((s) => (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={store === s.key}
                  onClick={() => setStore(s.key)}
                  className={`px-3 py-1 rounded-lg border text-label-lg ${store === s.key ? 'border-primary bg-primary-container text-on-primary-container font-semibold' : 'border-outline-variant text-on-surface hover:bg-surface-container'}`}
                >
                  {s.label} <span className="tabular-nums ml-1">{s.n}</span>
                </button>
              ))}
            </div>
          )}

          {error && (
            <div role="alert" className="mt-3 rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
              {error.message}
            </div>
          )}
          {message && <p role="status" className="mt-3 rounded-xl bg-surface-container px-4 py-3 text-body-sm text-on-surface">{message}</p>}

          {list.length > 0 ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[46rem] table-fixed text-body-sm">
                <caption className="sr-only">Suggested Where to Buy links</caption>
                <colgroup>
                  <col className="w-[8rem]" />
                  <col className="w-[10rem]" />
                  <col className="w-[7.5rem]" />
                  <col />
                  <col className="w-[11rem]" />
                  <col className="w-[9.5rem]" />
                </colgroup>
                <thead>
                  <tr className="text-label-md text-on-surface-variant text-left">
                    <th className="py-1.5 pr-3 font-semibold">SKU</th>
                    <th className="py-1.5 pr-3 font-semibold">Store</th>
                    <th className="py-1.5 pr-3 font-semibold">Now</th>
                    <th className="py-1.5 pr-3 font-semibold">Suggested link</th>
                    <th className="py-1.5 pr-3 font-semibold">The page shows</th>
                    <th className="py-1.5"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant/60">
                  {shown.map((s) => {
                    const why = WHY[s.reason] ?? WHY.missing;
                    return (
                      <tr key={s.id} className="h-10 align-middle">
                        <th scope="row" className="pr-3 text-left font-semibold text-on-surface whitespace-nowrap">
                          <Link to={`/catalog/${encodeURIComponent(s.sku)}?tab=where_to_buy`} className="hover:underline">{s.sku}</Link>
                        </th>
                        <td className="pr-3 truncate text-on-surface" title={storeLabel(s.retailer)}>{storeLabel(s.retailer)}</td>
                        <td className="pr-3">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-label-md font-semibold whitespace-nowrap cursor-default ${why.cls}`} title={[why.hint, s.current_url].filter(Boolean).join('\n')}>
                            {why.label}
                            <span className="sr-only">. {why.hint}</span>
                          </span>
                        </td>
                        <td className="pr-3">
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1.5 min-w-0 text-primary hover:underline"
                            title={[s.url, s.detail, s.status_note, s.checked_at ? `Opened ${fmt(s.checked_at)}` : null].filter(Boolean).join('\n')}
                          >
                            <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                            <span className="truncate">{shortUrl(s.url)}</span>
                          </a>
                        </td>
                        <td className="pr-3 text-label-md text-on-surface-variant truncate" title={s.status_note ?? undefined}>
                          {[s.page_model ?? s.sku, priceText(s), s.in_stock === false ? 'sold out' : null].filter(Boolean).join(' · ')}
                        </td>
                        <td className="text-right whitespace-nowrap">
                          {canEdit && (
                            <>
                              <button
                                type="button"
                                onClick={() => applySuggestions([s], s.id)}
                                disabled={busy != null}
                                aria-busy={busy === s.id}
                                aria-label={`Use the suggested ${storeLabel(s.retailer)} link of ${s.sku}`}
                                className="px-2.5 py-1 rounded-md bg-primary text-on-primary text-label-md font-semibold hover:bg-primary/90 disabled:opacity-40"
                              >
                                {busy === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" aria-hidden="true" /> : 'Use'}
                              </button>
                              <button
                                type="button"
                                onClick={() => dismiss(s)}
                                disabled={busy != null}
                                aria-label={`Dismiss the suggested ${storeLabel(s.retailer)} link of ${s.sku}`}
                                className="ml-1 px-2 py-1 rounded-md text-label-md font-semibold text-on-surface-variant hover:bg-surface-container disabled:opacity-40"
                              >
                                Dismiss
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-3 text-body-sm text-on-surface-variant">None ready yet — the PIM opens each one before it shows here.</p>
          )}
        </Dialog>
      )}
    </>
  );
}
