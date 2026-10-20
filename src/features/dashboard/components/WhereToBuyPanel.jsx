import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Check, ChevronDown, Copy, ExternalLink, RefreshCw, Search, Upload } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { loadWhereToBuy, scanWhereToBuy, checkWhereToBuy, whereToBuyStatus, republishWhereToBuy } from '@/features/dashboard/api/whereToBuy';
import {
  WTB_SITES,
  WTB_RETAILERS,
  WTB_VERDICTS,
  WTB_VIA,
  groupWhereToBuy,
  linksToAdd,
  summarizeWhereToBuy,
  isProblem,
} from '@/features/dashboard/lib/whereToBuy';

// Listing Health → Stylish → Where to Buy. One row per product of the site,
// one cell per retailer linked from its WHERE TO BUY section; the cell colour
// is the link's verdict (OK / Broken — user, 2026-10-19). Expanding a row
// lists every link with the reason and who checked it. The portals a page
// does not link are a KPI of their own ("Links to add"), not a problem.

const TONE = {
  ok: 'bg-success',
  muted: 'bg-outline',
  warning: 'bg-warning',
  error: 'bg-error',
};
const CHIP_TONE = {
  ok: 'bg-success-container text-on-success-container',
  muted: 'bg-surface-container-high text-on-surface-variant',
  warning: 'bg-warning-container text-on-warning-container',
  error: 'bg-error-container text-on-error-container',
};

const PAGE_SIZE = 50;

const fmtWhen = (iso) => {
  if (!iso) return 'never';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// `detail` (the reason, who checked it and when) shows on hover and is read
// by screen readers, so each link keeps one line.
function VerdictChip({ verdict, detail }) {
  const v = WTB_VERDICTS[verdict] ?? { label: verdict, tone: 'muted' };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-label-md font-semibold whitespace-nowrap cursor-default ${CHIP_TONE[v.tone]}`} title={detail || v.hint || ''}>
      {v.label}
      {detail && <span className="sr-only">. {detail}</span>}
    </span>
  );
}

const STORE_ORDER = new Map(WTB_RETAILERS.map((r, i) => [r.key, i]));
const byStoreOrder = (a, b) => (STORE_ORDER.get(a.retailer) ?? 99) - (STORE_ORDER.get(b.retailer) ?? 99);

function Cell({ links }) {
  if (!links?.length) return <span className="text-on-surface-variant/50">·</span>;
  // The worst verdict of the cell drives the colour (a retailer may appear twice).
  const worst = links.reduce((acc, l) => (isProblem(l.verdict) ? l : acc), links[0]);
  const v = WTB_VERDICTS[worst.verdict] ?? { tone: 'muted', label: worst.verdict };
  const title = links.map((l) => `${WTB_VERDICTS[l.verdict]?.label ?? l.verdict}${l.note ? ` · ${l.note}` : ''}${l.url ? `\n${l.url}` : ''}`).join('\n');
  const dot = <span className={`inline-block w-2.5 h-2.5 rounded-full ${worst.verdict === 'missing' ? 'ring-2 ring-inset ring-warning bg-transparent' : TONE[v.tone]}`} />;
  return worst.url ? (
    <a href={worst.url} target="_blank" rel="noreferrer" title={title} className="inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-surface-container-high" onClick={(e) => e.stopPropagation()}>
      {dot}
      <span className="sr-only">{v.label}</span>
    </a>
  ) : (
    <span title={title} className="inline-flex items-center justify-center w-7 h-7">{dot}<span className="sr-only">{v.label}</span></span>
  );
}

export default function WhereToBuyPanel() {
  const { canEdit } = useAuth();
  const [site, setSite] = useState(WTB_SITES[0].key);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // 'scan' | 'check' | null
  const [progress, setProgress] = useState(null);
  const [search, setSearch] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(true);
  const [retailerFilter, setRetailerFilter] = useState('all');
  const [toAdd, setToAdd] = useState(null); // a portal of "Links to add": its products only
  const [copied, setCopied] = useState(null);
  const [differs, setDiffers] = useState({}); // site → SKUs whose live section is not the PIM's list
  const [republish, setRepublish] = useState(null); // { done, total, errors }
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(null);

  const reload = async (s = site) => {
    setLoading(true);
    setError(null);
    try {
      const [r, st] = await Promise.all([loadWhereToBuy(s), whereToBuyStatus().catch(() => null)]);
      setRows(r);
      setDiffers(st?.differs ?? {});
    } catch (e) { setError(e); } finally { setLoading(false); }
  };
  useEffect(() => { reload(site); setPage(1); setExpanded(null); setToAdd(null); }, [site]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => summarizeWhereToBuy(rows), [rows]);
  const groups = useMemo(() => groupWhereToBuy(rows), [rows]);
  const toAddList = useMemo(() => linksToAdd(rows), [rows]);
  // Only retailers present on this site get a column.
  const columns = useMemo(() => {
    const seen = new Set(rows.filter((r) => r.section === 'where_to_buy' && r.url).map((r) => r.retailer));
    return WTB_RETAILERS.filter((r) => seen.has(r.key));
  }, [rows]);

  const filtered = useMemo(() => {
    let list = groups;
    if (toAdd) list = list.filter((g) => g.missing.includes(toAdd));
    else if (onlyProblems) list = list.filter((g) => g.problems > 0);
    if (retailerFilter !== 'all') list = list.filter((g) => g.links.some((l) => l.retailer === retailerFilter && (!onlyProblems || isProblem(l.verdict))));
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((g) => g.sku.toLowerCase().includes(q));
    return list;
  }, [groups, onlyProblems, retailerFilter, search, toAdd]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [onlyProblems, retailerFilter, search, toAdd]);

  const copySkus = async (retailer, skus) => {
    try { await navigator.clipboard.writeText(skus.join('\n')); setCopied(retailer); setTimeout(() => setCopied(null), 2000); } catch { /* clipboard blocked */ }
  };

  const runRepublish = async (skus) => {
    setRepublish({ done: 0, total: skus.length, errors: 0 });
    setError(null);
    try {
      await republishWhereToBuy(skus, (p) => setRepublish(p));
      await reload();
    } catch (e) { setError(e); } finally { setRepublish(null); }
  };

  const runScan = async () => {
    setBusy('scan');
    setError(null);
    try { await scanWhereToBuy(); await reload(); } catch (e) { setError(e); } finally { setBusy(null); }
  };
  const runCheck = async () => {
    setBusy('check');
    setError(null);
    setProgress({ checked: 0 });
    try {
      await checkWhereToBuy({ onProgress: (p) => setProgress(p) });
      await reload();
    } catch (e) { setError(e); } finally { setBusy(null); setProgress(null); }
  };

  const counts = summary.byVerdict;
  const stat = (label, value, tone) => (
    <div key={label} className="min-w-[5.5rem]">
      <p className={`text-title-lg font-semibold tabular-nums ${tone ?? 'text-on-surface'}`}>{value ?? 0}</p>
      <p className="text-label-md text-on-surface-variant">{label}</p>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-title-md font-semibold text-on-surface">Where to Buy links</h2>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              Every retailer link on the product pages, opened to confirm it reaches the product page.
            </p>
            <p className="text-body-sm text-on-surface-variant mt-1">
              Scanned {fmtWhen(summary.lastScan)} · last check {fmtWhen(summary.lastCheck)} · OK links are checked again every 3 days, broken ones every 2 days · stores that block the PIM are opened through Bright Data or ScraperAPI
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-full bg-surface-container p-1" role="tablist" aria-label="Stylish site">
              {WTB_SITES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  role="tab"
                  aria-selected={site === s.key}
                  onClick={() => setSite(s.key)}
                  className={`px-3.5 py-1.5 rounded-full text-label-lg transition-colors ${site === s.key ? 'bg-surface text-on-surface shadow-sm font-semibold' : 'text-on-surface-variant hover:text-on-surface'}`}
                >
                  {s.short}
                </button>
              ))}
            </div>
            {canEdit && (
              <>
                <button
                  type="button"
                  onClick={runScan}
                  disabled={busy != null}
                  aria-busy={busy === 'scan'}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline text-label-lg text-on-surface hover:bg-surface-container disabled:opacity-40"
                  title="Re-read the WHERE TO BUY sections of both sites"
                >
                  <RefreshCw className={`w-4 h-4 ${busy === 'scan' ? 'animate-spin' : ''}`} />
                  {busy === 'scan' ? 'Scanning pages' : 'Scan pages'}
                </button>
                <button
                  type="button"
                  onClick={runCheck}
                  disabled={busy != null}
                  aria-busy={busy === 'check'}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-primary text-on-primary text-label-lg hover:bg-primary/90 disabled:opacity-40"
                  title="Check the links that are due now instead of waiting for the automatic pass (every 10 minutes)"
                >
                  {busy === 'check' ? `Checking · ${progress?.checked ?? 0}` : 'Check links'}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-x-8 gap-y-4">
          {stat('Products', summary.products)}
          {stat('Links', summary.links)}
          {stat('OK', counts.ok, 'text-success')}
          {stat('Broken', counts.broken, counts.broken ? 'text-error' : undefined)}
          {stat('Not checked yet', counts.pending)}
          {stat('Check by hand', counts.manual)}
        </div>
      </div>

      {(differs[site]?.length ?? 0) > 0 && (
        <div className="rounded-2xl border border-warning/40 bg-warning-container/40 px-5 py-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-body-sm text-on-surface">
            <span className="font-semibold">{differs[site].length} page{differs[site].length === 1 ? '' : 's'} on {WTB_SITES.find((s) => s.key === site)?.label}</span> show other links than the PIM (changed by hand in Wix, or not published yet): {differs[site].slice(0, 8).join(', ')}{differs[site].length > 8 ? '…' : ''}
          </p>
          {canEdit && (
            <button
              type="button"
              onClick={() => runRepublish(differs[site])}
              disabled={republish != null || busy != null}
              aria-busy={republish != null}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline text-label-lg text-on-surface hover:bg-surface-container disabled:opacity-40"
            >
              <Upload className="w-4 h-4" aria-hidden="true" />
              {republish ? `Publishing ${republish.done} of ${republish.total}` : "Publish the PIM's links"}
            </button>
          )}
        </div>
      )}

      {toAddList.length > 0 && (
        <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-title-sm font-semibold text-on-surface">Links to add · {counts.missing ?? 0}</h3>
            <p className="text-body-sm text-on-surface-variant">Portals most products of the site link, missing on these pages. Pick one to list its products.</p>
          </div>
          <ul className="mt-3 flex flex-wrap gap-2">
            {toAddList.map((p) => {
              const active = toAdd === p.retailer;
              return (
                <li key={p.retailer} className={`inline-flex items-center rounded-lg border ${active ? 'border-primary bg-primary-container' : 'border-outline-variant'}`}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => setToAdd(active ? null : p.retailer)}
                    className={`px-3 py-1.5 text-label-lg ${active ? 'text-on-primary-container font-semibold' : 'text-on-surface hover:bg-surface-container'} rounded-l-lg`}
                  >
                    {p.label} <span className="tabular-nums text-warning font-semibold ml-1">{p.skus.length}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => copySkus(p.retailer, p.skus)}
                    aria-label={`Copy the ${p.skus.length} SKUs missing a ${p.label} link`}
                    title={`Copy the ${p.skus.length} SKUs`}
                    className="px-2 py-1.5 border-l border-outline-variant text-on-surface-variant hover:bg-surface-container rounded-r-lg"
                  >
                    {copied === p.retailer ? <Check className="w-4 h-4 text-success" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {copied && <p role="status" className="sr-only">SKUs copied</p>}
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error.message}
        </div>
      )}

      {loading ? (
        <div role="status" aria-label="Loading links" className="animate-pulse rounded-2xl border border-outline-variant bg-surface-container-lowest h-64" />
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-8 text-center">
          <p className="text-body-md text-on-surface">No links scanned yet for this site.</p>
          <p className="text-body-sm text-on-surface-variant mt-1">{canEdit ? 'Run "Scan pages" to read the sections.' : 'An editor has to run the first scan.'}</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-outline-variant">
            <label className="relative">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="SKU"
                aria-label="Filter by SKU"
                className="pl-8 pr-3 py-1.5 rounded-lg bg-surface-container text-body-sm text-on-surface w-40 focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </label>
            <select value={retailerFilter} onChange={(e) => setRetailerFilter(e.target.value)} aria-label="Retailer" className="px-3 py-1.5 rounded-lg bg-surface-container text-body-sm text-on-surface">
              <option value="all">All retailers</option>
              {columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            {toAdd ? (
              <span className="inline-flex items-center gap-2 text-body-sm text-on-surface">
                Missing a {WTB_RETAILERS.find((r) => r.key === toAdd)?.label ?? toAdd} link
                <button type="button" onClick={() => setToAdd(null)} className="px-2 py-0.5 rounded-md text-primary hover:bg-surface-container">Clear</button>
              </span>
            ) : (
              <label className="inline-flex items-center gap-2 text-body-sm text-on-surface cursor-pointer">
                <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} className="accent-primary" />
                Only broken links
              </label>
            )}
            <span className="text-body-sm text-on-surface-variant ml-auto">{filtered.length} of {groups.length} products</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="bg-surface-container-low text-label-md text-on-surface-variant">
                  <th className="sticky left-0 bg-surface-container-low text-left px-4 py-2 font-semibold">SKU</th>
                  {columns.map((c) => (
                    <th key={c.key} className="px-1 py-2 font-semibold text-center whitespace-nowrap" title={c.label}>{c.short}</th>
                  ))}
                  <th className="px-3 py-2 font-semibold text-right">Issues</th>
                  <th className="w-8"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((g) => {
                  const byRetailer = new Map();
                  for (const l of g.links) { if (!byRetailer.has(l.retailer)) byRetailer.set(l.retailer, []); byRetailer.get(l.retailer).push(l); }
                  const open = expanded === g.sku;
                  return (
                    <Fragment key={g.sku}>
                      <tr className="border-t border-outline-variant hover:bg-surface-container-low cursor-pointer" onClick={() => setExpanded(open ? null : g.sku)}>
                        <td className="sticky left-0 bg-surface-container-lowest px-4 py-1.5 font-semibold text-on-surface whitespace-nowrap">
                          <Link to={`/catalog/${g.sku}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{g.sku}</Link>
                        </td>
                        {columns.map((c) => (
                          <td key={c.key} className="px-1 py-1.5 text-center"><Cell links={byRetailer.get(c.key)} /></td>
                        ))}
                        <td className={`px-3 py-1.5 text-right tabular-nums ${g.problems ? 'text-error font-semibold' : 'text-on-surface-variant'}`}>{g.problems}</td>
                        <td className="px-2 py-1.5 text-on-surface-variant">
                          {/* The row opens on click; this button lets the keyboard do it too
                              (its click reaches the row's onClick). Plain look, no press sink. */}
                          <button type="button" aria-expanded={open} aria-label={`Links of ${g.sku}`} className="block cursor-pointer active:scale-none!">
                            <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-t border-outline-variant bg-surface-container-low/60">
                          <td colSpan={columns.length + 3} className="px-4 py-3">
                            <table className="w-full max-w-5xl table-fixed text-body-sm">
                              <caption className="sr-only">Where to Buy links of {g.sku}</caption>
                              <colgroup>
                                <col className="w-[8.5rem]" />
                                <col className="w-[12rem]" />
                                <col />
                                <col className="w-[14rem]" />
                              </colgroup>
                              <tbody className="divide-y divide-outline-variant/50">
                                {[...g.links].sort(byStoreOrder).map((l) => {
                                  const checked = l.checked_via && (l.verdict === 'ok' || l.verdict === 'broken');
                                  const when = checked ? `${WTB_VIA[l.checked_via] ?? l.checked_via} · ${fmtWhen(l.checked_at)}` : '';
                                  const detail = [l.verdict !== 'ok' ? l.note : null, when ? `Checked by ${when}` : null].filter(Boolean).join('\n');
                                  return (
                                    <tr key={l.id} className="h-9 align-middle">
                                      <td className="pr-3"><VerdictChip verdict={l.verdict} detail={detail} /></td>
                                      <th scope="row" className="pr-3 text-left font-semibold text-on-surface truncate">
                                        {WTB_RETAILERS.find((r) => r.key === l.retailer)?.label ?? l.retailer}
                                      </th>
                                      <td className="pr-3">
                                        {l.url ? (
                                          <a href={l.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 min-w-0 text-primary hover:underline" title={l.url}>
                                            <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                                            <span className="truncate">{l.url.replace(/^https?:\/\/(www\.)?/, '')}</span>
                                          </a>
                                        ) : (
                                          <span className="text-on-surface-variant">No link yet</span>
                                        )}
                                      </td>
                                      <td className="text-label-md text-on-surface-variant truncate" title={detail || undefined}>
                                        {when || (l.verdict === 'pending' ? (l.note ? 'Trying again soon' : 'Waiting for its check') : '')}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                            <p className="mt-2 text-body-sm text-on-surface-variant">
                              Change the links in the product&apos;s <Link to={`/catalog/${encodeURIComponent(g.sku)}?tab=where_to_buy`} className="text-primary underline underline-offset-2">Where to Buy tab</Link> — the PIM writes both Stylish pages from it.
                            </p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {pageRows.length === 0 && (
                  <tr className="border-t border-outline-variant">
                    <td colSpan={columns.length + 3} className="px-4 py-8 text-center text-on-surface-variant">
                      {toAdd ? 'No product misses this link.' : onlyProblems ? 'No broken links on this site.' : 'No products match.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-outline-variant text-body-sm text-on-surface-variant">
              <span>Page {page} of {pageCount}</span>
              <div className="flex gap-2">
                <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-3 py-1 rounded-lg hover:bg-surface-container disabled:opacity-40">Previous</button>
                <button type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)} className="px-3 py-1 rounded-lg hover:bg-surface-container disabled:opacity-40">Next</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
