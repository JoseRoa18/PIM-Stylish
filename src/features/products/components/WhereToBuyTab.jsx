import { Fragment, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ExternalLink, Lightbulb, Loader2, Upload } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { loadProductWhereToBuy, saveProductWhereToBuy, publishWhereToBuy, dismissWhereToBuySuggestion } from '../api/whereToBuy';
import { WTB_MARKETS, WTB_RETAILERS, wtbUrlProblem, cleanWtbUrl } from '../lib/whereToBuy';
import { PAGE_STORE_KEYS, readingCounts } from '@/features/pricing/lib/pageStores';

// Product page → Where to Buy. The store links of the Stylish websites, owned
// by the PIM (user, 2026-10-19): ONE list for the product, and saving writes
// the WHERE TO BUY section of both Stylish pages (Canada and USA) from it.
// Each row shows what the Listing Health check last found on that address —
// and what the page showed: its product's model (a link that opens another
// product says so) and its price (2026-10-20). Under a link that opens the
// wrong product, a broken one or a missing one, the PIM may suggest the right
// address — found and opened by the audit, its page shows this product. "Use"
// puts it in the field; nothing changes until "Save and publish".

const inputCls = 'w-full px-3 py-1.5 rounded-lg border bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors';

const STATUS = {
  ok: { label: 'OK', cls: 'bg-success-container text-on-success-container' },
  broken: { label: 'Broken', cls: 'bg-error-container text-on-error-container' },
  wrong: { label: 'Wrong product', cls: 'bg-warning-container text-on-warning-container' },
  pending: { label: 'Checking', cls: 'bg-surface-container-high text-on-surface-variant' },
  manual: { label: 'Check by hand', cls: 'bg-surface-container-high text-on-surface-variant' },
};
const isWrong = (check) => check?.sku_check === 'other' || check?.sku_check === 'variant';
const priceText = (check) => {
  if (check?.price == null) return '';
  const symbol = check.currency === 'USD' ? '$' : check.currency === 'CAD' ? 'C$' : '';
  return `${symbol}${Number(check.price).toFixed(2)}`;
};
const PUBLISH_TEXT = {
  published: 'updated',
  up_to_date: 'already up to date',
  no_links: 'nothing to publish (no links)',
  not_linked: 'not linked to this product in the PIM',
  not_found: 'product not found on the site',
  later: 'queued — Wix asked to wait, updated within minutes',
};
const VIA = { direct: 'the PIM', brightdata: 'Bright Data', scraperapi: 'ScraperAPI', price2spy: 'Price2Spy' };
const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const shortUrl = (u) => String(u ?? '').replace(/^https?:\/\/(www\.)?/, '');
const SUGGESTION_WHY = {
  wrong_link: 'The current link opens another product',
  broken_link: 'The current link does not open',
  missing: 'No link to this store yet',
};

export default function WhereToBuyTab({ product }) {
  const { canEdit } = useAuth();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // 'save' | 'publish'
  const [result, setResult] = useState(null);

  // `keepDraft`: the fields keep what the person typed (after a dismiss).
  async function reload({ keepDraft = false } = {}) {
    try {
      const d = await loadProductWhereToBuy(product);
      setData(d);
      if (!keepDraft) setDraft(d.links);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { reload(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [product.sku]);

  const problems = useMemo(() => Object.fromEntries(
    Object.entries(draft).filter(([, url]) => url?.trim()).map(([k, url]) => [k, wtbUrlProblem(k, url.trim())]).filter(([, p]) => p),
  ), [draft]);
  const dirty = data && WTB_RETAILERS.some((r) => (draft[r.key]?.trim() ? cleanWtbUrl(draft[r.key]) : '') !== (data.links[r.key] ?? ''));
  const count = data ? Object.keys(data.links).length : 0;
  // The stores whose field holds a suggested address (kept as the link's source).
  const suggestedNow = data ? Object.entries(data.suggestions ?? {}).filter(([k, list]) => list.some((s) => s.url === draft[k])).map(([k]) => k) : [];

  async function handleSave() {
    setBusy('save');
    setResult(null);
    try {
      const r = await saveProductWhereToBuy(product, draft, data.links, { suggested: suggestedNow });
      setResult(r.published);
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }
  async function handleDismiss(suggestion) {
    setBusy(`dismiss-${suggestion.id}`);
    try {
      await dismissWhereToBuySuggestion(suggestion);
      setDraft((d) => (d[suggestion.retailer] === suggestion.url ? { ...d, [suggestion.retailer]: data.links[suggestion.retailer] ?? '' } : d));
      await reload({ keepDraft: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }
  async function handlePublish() {
    setBusy('publish');
    setResult(null);
    try {
      setResult(await publishWhereToBuy(product));
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  if (data && !data.sites.length) {
    return (
      <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest px-8 py-6">
        <h2 className="text-title-lg text-on-surface">Where to Buy</h2>
        <p className="text-body-md text-on-surface-variant mt-1">{product.brand} products are not on the Stylish websites, so they have no Where to Buy section.</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-8 py-5 border-b border-outline-variant flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-title-lg text-on-surface leading-tight">Where to Buy</h2>
          <p className="text-body-sm text-on-surface-variant mt-0.5">
            The store links of {product.sku} on the Stylish websites. Saving writes the WHERE TO BUY section of {data?.sites.map((s) => s.label).join(' and ') ?? 'both pages'} from this list; the rest of the page stays as it is.
          </p>
        </div>
        {canEdit && data && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePublish}
              disabled={busy != null || dirty || !count}
              title="Write this list to the Stylish pages again (for example after someone changed the section in Wix)"
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline text-label-lg text-on-surface hover:bg-surface-container disabled:opacity-40"
            >
              {busy === 'publish' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Upload className="w-4 h-4" aria-hidden="true" />}
              Publish again
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy != null || !dirty || Object.keys(problems).length > 0}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-primary text-on-primary text-label-lg hover:bg-primary/90 disabled:opacity-40"
            >
              {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              Save and publish
            </button>
          </div>
        )}
      </header>

      {error && (
        <div role="alert" className="mx-8 mt-4 rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}
      {result && (
        <div role="status" className="mx-8 mt-4 rounded-xl bg-surface-container px-4 py-3 text-body-sm text-on-surface space-y-0.5">
          {result.map((r) => (
            <p key={r.site} className={r.status === 'error' ? 'text-error' : ''}>
              {r.label}: {r.status === 'error' ? `not updated — ${r.error}` : PUBLISH_TEXT[r.status] ?? r.status}
            </p>
          ))}
          {result.some((r) => r.status === 'published') && <p className="text-on-surface-variant">New addresses are checked within a few minutes.</p>}
        </div>
      )}

      {!data ? (
        <div role="status" aria-label="Loading links" className="m-8 h-40 rounded-xl bg-surface-container animate-pulse" />
      ) : (
        <div className="grid gap-x-10 gap-y-6 px-6 sm:px-8 py-6 xl:grid-cols-2">
          {WTB_MARKETS.map((m) => {
            const stores = WTB_RETAILERS.filter((r) => r.market === m.key);
            const withLink = stores.filter((r) => data.links[r.key]).length;
            return (
              <div key={m.key} className="min-w-0">
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <h3 className="text-title-sm font-semibold text-on-surface">{m.heading}</h3>
                  <span className="text-label-md text-on-surface-variant">{withLink} of {stores.length} stores</span>
                </div>
                <table className="w-full table-fixed text-body-sm">
                  <caption className="sr-only">{m.heading} links of {product.sku}</caption>
                  <colgroup>
                    <col className="w-[9.5rem]" />
                    <col />
                    <col className="w-[6.75rem]" />
                    <col className="w-9" />
                  </colgroup>
                  <tbody className="divide-y divide-outline-variant/60">
                    {stores.map((r) => {
                      const saved = data.links[r.key] ?? '';
                      const check = data.checks[r.key];
                      const wrong = isWrong(check) && check.verdict !== 'broken';
                      const status = saved ? (wrong ? STATUS.wrong : STATUS[check?.verdict] ?? STATUS.pending) : null;
                      const problem = problems[r.key];
                      const id = `wtb-${r.key}`;
                      // The price shows only when the page is this product's
                      // (another product's price would mislead).
                      const price = saved && check?.verdict !== 'broken' && readingCounts(check) ? priceText(check) : '';
                      // The reason, who checked it and what the page showed sit
                      // behind the status (hover / screen reader), so every row
                      // keeps one line.
                      const detail = saved ? [
                        check?.checked_at && (check.verdict === 'ok' || check.verdict === 'broken') ? `Checked by ${VIA[check.checked_via] ?? 'the PIM'} · ${fmt(check.checked_at)}` : null,
                        check?.verdict !== 'ok' ? check?.note : null,
                        wrong && check.sku_check === 'variant' ? `The page shows ${check.page_model ?? 'another option'}, another option of the same product. The link stays on the websites — edit it so it opens ${product.sku}.` : null,
                        wrong && check.sku_check === 'other' ? `The page shows ${check.page_model ?? 'another product'}, not ${product.sku}. If the next check (two days later) finds the same, the link is Broken and leaves the websites.` : null,
                        check?.read_at && !isWrong(check) && check.page_model && check.sku_check === 'unknown' ? `The page shows model ${check.page_model} (not a PIM SKU) — check that it is ${product.sku}.` : null,
                        check?.page_note ? `On the page: ${check.page_note}.` : null,
                        price ? `Price on the page: ${price}${check.was_price != null ? ` (was ${check.currency === 'USD' ? '$' : 'C$'}${Number(check.was_price).toFixed(2)})` : ''}${check.in_stock === false ? ', sold out' : ''} · read ${fmt(check.read_at)}${PAGE_STORE_KEYS.has(r.key) ? ' — Pricing → Price Alignment compares it with the MAP' : ''}` : null,
                        check?.verdict === 'broken' ? 'Not shown on the Stylish websites until it works again (fix the link or wait for the next check).' : null,
                      ].filter(Boolean).join('\n') : '';
                      // The PIM's suggestion for this store (the newest checked one),
                      // unless it is already the saved link.
                      const suggestion = (data.suggestions?.[r.key] ?? []).find((s) => s.url !== saved) ?? null;
                      const using = suggestion && draft[r.key] === suggestion.url;
                      return (
                        <Fragment key={r.key}>
                        <tr className="h-12 align-middle">
                          <th scope="row" className="pr-3 text-left font-semibold text-on-surface">
                            <label htmlFor={id} className="block truncate" title={r.label}>{r.label}</label>
                          </th>
                          <td className="pr-3">
                            {canEdit ? (
                              <input
                                id={id}
                                type="url"
                                value={draft[r.key] ?? ''}
                                onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}
                                placeholder="No link yet"
                                title={problem ?? (draft[r.key] || undefined)}
                                aria-invalid={problem ? 'true' : undefined}
                                aria-describedby={problem ? `${id}-problem` : undefined}
                                className={`${inputCls} ${problem ? 'border-error' : saved ? 'border-outline-variant' : 'border-dashed border-outline-variant bg-transparent'}`}
                              />
                            ) : (
                              <span className="block truncate text-on-surface" title={saved}>{saved || <span className="text-on-surface-variant">—</span>}</span>
                            )}
                            {problem && <span id={`${id}-problem`} className="sr-only">{problem}</span>}
                          </td>
                          <td>
                            {problem ? (
                              <span className="inline-block px-1.5 py-0.5 rounded text-label-md font-semibold bg-error-container text-on-error-container" title={problem}>Wrong store</span>
                            ) : status ? (
                              <span className="flex flex-col items-start cursor-default" title={detail || undefined}>
                                <span className={`inline-block px-1.5 py-0.5 rounded text-label-md font-semibold whitespace-nowrap ${status.cls}`}>{status.label}</span>
                                {/* The price the page showed, under the status (its date and
                                    was-price are in the status' detail). */}
                                {price && <span className={`mt-0.5 text-label-md tabular-nums ${check.in_stock === false ? 'text-on-surface-variant line-through' : 'text-on-surface-variant'}`} aria-hidden="true">{price}</span>}
                                {detail && <span className="sr-only">. {detail}</span>}
                              </span>
                            ) : null}
                          </td>
                          <td className="text-right">
                            {saved && (
                              <a href={saved} target="_blank" rel="noreferrer" aria-label={`Open the ${r.label} page`} className="inline-flex p-1.5 rounded-md text-on-surface-variant hover:bg-surface-container hover:text-on-surface">
                                <ExternalLink className="w-4 h-4" aria-hidden="true" />
                              </a>
                            )}
                          </td>
                        </tr>
                        {suggestion && (
                          <tr className="border-t-0!">
                            <td colSpan={4} className="pb-2">
                              <div className={`sm:ml-[9.5rem] rounded-lg px-3 py-2 text-label-md flex flex-wrap items-center gap-x-3 gap-y-1 ${using ? 'bg-success-container/60 text-on-success-container' : 'bg-surface-container text-on-surface'}`}>
                                <Lightbulb className={`w-3.5 h-3.5 flex-shrink-0 ${using ? '' : 'text-primary'}`} aria-hidden="true" />
                                <span className="font-semibold whitespace-nowrap">{using ? 'Suggested link in the field' : 'Suggested link'}</span>
                                <a
                                  href={suggestion.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={`min-w-0 max-w-full truncate underline underline-offset-2 ${using ? '' : 'text-primary'}`}
                                  title={[suggestion.url, SUGGESTION_WHY[suggestion.reason], suggestion.detail, suggestion.status_note, suggestion.checked_at ? `Opened ${fmt(suggestion.checked_at)}` : null].filter(Boolean).join('\n')}
                                >
                                  {shortUrl(suggestion.url)}
                                </a>
                                <span className="whitespace-nowrap">
                                  shows {suggestion.page_model ?? product.sku}{suggestion.price != null ? ` · ${priceText(suggestion)}` : ''}{suggestion.in_stock === false ? ' · sold out' : ''}
                                </span>
                                {canEdit && (
                                  <span className="ml-auto flex items-center gap-1">
                                    {using ? (
                                      <>
                                        <span className="whitespace-nowrap">Press Save and publish to use it</span>
                                        <button type="button" onClick={() => setDraft((d) => ({ ...d, [r.key]: saved }))} className="px-2 py-0.5 rounded-md font-semibold hover:bg-surface/60">Undo</button>
                                      </>
                                    ) : (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => setDraft((d) => ({ ...d, [r.key]: suggestion.url }))}
                                          aria-label={`Use the suggested ${r.label} link`}
                                          className="px-2.5 py-0.5 rounded-md bg-primary text-on-primary font-semibold hover:bg-primary/90"
                                        >
                                          Use
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleDismiss(suggestion)}
                                          disabled={busy != null}
                                          aria-label={`Dismiss the suggested ${r.label} link`}
                                          className="px-2 py-0.5 rounded-md font-semibold hover:bg-surface/60 disabled:opacity-40"
                                        >
                                          Dismiss
                                        </button>
                                      </>
                                    )}
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
      {data && (
        <p className="px-6 sm:px-8 pb-5 -mt-2 text-label-md text-on-surface-variant">
          Point at a status to see when and how the link was checked, why it is not OK and which product the page shows; the price under it is the one the page showed at that check. Only the stores with a working link show on the websites. A suggested link was found and opened by the PIM: its page shows this product.
        </p>
      )}
      {data?.sites.some((s) => !s.linked) && (
        <p className="px-6 sm:px-8 pb-5 text-label-md text-on-surface-variant">
          Not linked in the PIM to its page on {data.sites.filter((s) => !s.linked).map((s) => s.label).join(' and ')} — that page cannot be updated from here (Marketplaces tab → link the product).
        </p>
      )}
    </section>
  );
}
