import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ExternalLink, Loader2, Upload } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { loadProductWhereToBuy, saveProductWhereToBuy, publishWhereToBuy } from '../api/whereToBuy';
import { WTB_MARKETS, WTB_RETAILERS, wtbUrlProblem, cleanWtbUrl } from '../lib/whereToBuy';

// Product page → Where to Buy. The store links of the Stylish websites, owned
// by the PIM (user, 2026-10-19): ONE list for the product, and saving writes
// the WHERE TO BUY section of both Stylish pages (Canada and USA) from it.
// Each row shows what the Listing Health check last found on that address.

const inputCls = 'w-full px-3 py-1.5 rounded-lg border bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors';

const STATUS = {
  ok: { label: 'OK', cls: 'bg-success-container text-on-success-container' },
  broken: { label: 'Broken', cls: 'bg-error-container text-on-error-container' },
  pending: { label: 'Checking', cls: 'bg-surface-container-high text-on-surface-variant' },
  manual: { label: 'Check by hand', cls: 'bg-surface-container-high text-on-surface-variant' },
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

export default function WhereToBuyTab({ product }) {
  const { canEdit } = useAuth();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // 'save' | 'publish'
  const [result, setResult] = useState(null);

  async function reload() {
    try {
      const d = await loadProductWhereToBuy(product);
      setData(d);
      setDraft(d.links);
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

  async function handleSave() {
    setBusy('save');
    setResult(null);
    try {
      const r = await saveProductWhereToBuy(product, draft, data.links);
      setResult(r.published);
      await reload();
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
                      const status = saved ? STATUS[check?.verdict] ?? STATUS.pending : null;
                      const problem = problems[r.key];
                      const id = `wtb-${r.key}`;
                      // The reason and who checked it sit behind the status
                      // (hover / screen reader), so every row keeps one line.
                      const detail = saved ? [
                        check?.checked_at && (check.verdict === 'ok' || check.verdict === 'broken') ? `Checked by ${VIA[check.checked_via] ?? 'the PIM'} · ${fmt(check.checked_at)}` : null,
                        check?.verdict !== 'ok' ? check?.note : null,
                        check?.verdict === 'broken' ? 'Not shown on the Stylish websites until it works again (fix the link or wait for the next check).' : null,
                      ].filter(Boolean).join('\n') : '';
                      return (
                        <tr key={r.key} className="h-12 align-middle">
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
                              <span className={`inline-block px-1.5 py-0.5 rounded text-label-md font-semibold cursor-default ${status.cls}`} title={detail || undefined}>
                                {status.label}
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
          Point at a status to see when and how the link was checked, and why it is not OK. Only the stores with a link show on the websites.
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
