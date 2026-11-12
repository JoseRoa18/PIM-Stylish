import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Check, ChevronDown, Copy, ExternalLink, RefreshCw, Search, Upload } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { startTask } from '@/lib/taskProgress';
import { loadWhereToBuy, scanWhereToBuy, checkWhereToBuy, whereToBuyStatus, republishWhereToBuy } from '@/features/dashboard/api/whereToBuy';
import WhereToBuySuggestions from './WhereToBuySuggestions';
import WhereToBuyExcel from './WhereToBuyExcel';
import {
  WTB_SITES,
  WTB_RETAILERS,
  WTB_VIA,
  WTB_STATUSES,
  groupWhereToBuy,
  linksToAdd,
  summarizeWhereToBuy,
  linkBucket,
  linkStatus,
  isLinkProblem,
  isWrongProduct,
  isOtherFinish,
  pageReading,
  OUT_OF_STOCK,
} from '@/features/dashboard/lib/whereToBuy';

// Listing Health → Stylish → Where to Buy. One row per product of the site,
// one cell per retailer linked from its WHERE TO BUY section; the cell colour
// is the link's verdict (OK / Broken — user, 2026-10-19), or "Wrong product"
// when its page shows another product (2026-10-20), or "Out of stock" when
// the store shows it sold out (2026-10-26, a hollow ring). Expanding a row lists
// every link with the reason, who checked it and what the page showed (its
// model and price). The portals a page does not link are a KPI of their own
// ("Links to add"), not a problem. "Suggested links" lists the right
// addresses the PIM found and opened for wrong, broken and missing links;
// "Use" saves one into the product's list and publishes its pages.
//
// The status counters are the filters of the list (user, 2026-11-12): pressed,
// a counter lists the products that have such a link, most of them first, with
// those links standing out in the grid (the others fade) and alone in an
// opened row; pressed again, the usual list. It works with the retailer and
// SKU filters, and gives way to a "Links to add" portal (and the reverse).

const TONE = {
  ok: 'bg-success',
  muted: 'bg-outline',
  warning: 'bg-warning',
  error: 'bg-error',
  // Out of stock: a hollow ring, the link is fine but off the websites for now.
  stock: 'ring-2 ring-inset ring-on-surface-variant bg-transparent',
};
const CHIP_TONE = {
  ok: 'bg-success-container text-on-success-container',
  muted: 'bg-surface-container-high text-on-surface-variant',
  warning: 'bg-warning-container text-on-warning-container',
  error: 'bg-error-container text-on-error-container',
  stock: 'bg-tertiary-container text-on-tertiary-container',
};

const PAGE_SIZE = 50;

const fmtWhen = (iso) => {
  if (!iso) return 'never';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// `detail` (the reason, who checked it and when) shows on hover and is read
// by screen readers, so each link keeps one line.
function StatusChip({ link, detail }) {
  const v = linkStatus(link);
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-label-md font-semibold whitespace-nowrap cursor-default ${CHIP_TONE[v.tone]}`} title={detail || v.hint || ''}>
      {v.label}
      {detail && <span className="sr-only">. {detail}</span>}
    </span>
  );
}

const STORE_ORDER = new Map(WTB_RETAILERS.map((r, i) => [r.key, i]));
const byStoreOrder = (a, b) => (STORE_ORDER.get(a.retailer) ?? 99) - (STORE_ORDER.get(b.retailer) ?? 99);

function Cell({ links, hit = null }) {
  if (!links?.length) return <span className="text-on-surface-variant/50">·</span>;
  // The worst link of the cell drives the colour (a retailer may appear twice).
  // Under a status filter it is the cell's link of that status, and a cell
  // without one fades.
  const own = hit ? links.find(hit) : null;
  const faded = hit && !own ? 'opacity-25' : '';
  const worst = own ?? links.reduce((acc, l) => (isLinkProblem(l) ? l : acc), links[0]);
  const v = linkStatus(worst);
  const title = links.map((l) => {
    const read = pageReading(l);
    return `${linkStatus(l).label}${l.note ? ` · ${l.note}` : ''}${read ? `\nOn the page: ${read.text}` : ''}${l.url ? `\n${l.url}` : ''}`;
  }).join('\n');
  const dot = <span className={`inline-block w-2.5 h-2.5 rounded-full ${worst.verdict === 'missing' ? 'ring-2 ring-inset ring-warning bg-transparent' : TONE[v.tone]}`} />;
  return worst.url ? (
    <a href={worst.url} target="_blank" rel="noreferrer" title={title} className={`inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-surface-container-high hover:opacity-100 focus-visible:opacity-100 ${faded}`} onClick={(e) => e.stopPropagation()}>
      {dot}
      <span className="sr-only">{v.label}</span>
    </a>
  ) : (
    <span title={title} className={`inline-flex items-center justify-center w-7 h-7 ${faded}`}>{dot}<span className="sr-only">{v.label}</span></span>
  );
}

export default function WhereToBuyPanel({ sites = WTB_SITES }) {
  const { canEdit } = useAuth();
  const [site, setSite] = useState(sites[0].key);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // 'scan' | 'check' | null
  const [progress, setProgress] = useState(null);
  const [search, setSearch] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(true);
  const [retailerFilter, setRetailerFilter] = useState('all');
  const [toAdd, setToAdd] = useState(null); // a portal of "Links to add": its products only
  const [status, setStatus] = useState(null); // a status counter (WTB_STATUSES key): the products with such a link
  const [allLinks, setAllLinks] = useState(false); // the opened row lists every link, not only the status's
  const [copied, setCopied] = useState(null);
  const [differs, setDiffers] = useState({}); // site → SKUs whose live section is not the PIM's list
  const [republish, setRepublish] = useState(null); // { done, total, errors }
  const [due, setDue] = useState(null); // links due for a check now (both sites), for the check's percentage
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(null);

  // A reload after an action reports on that action's card (`parent`, a
  // slice of it); the panel's own load (the tab opened, the site switched)
  // shows no card (user, 2026-10-31: cards only for exports and uploads).
  // Returns whether the links were read.
  const reload = async (s = site, parent = null) => {
    setLoading(true);
    setError(null);
    try {
      const [r, st] = await Promise.all([loadWhereToBuy(s, { task: parent?.part(0, 0.9) ?? null }), whereToBuyStatus().catch(() => null)]);
      setRows(r);
      setDiffers(st?.differs ?? {});
      setDue(st?.due ?? null);
      parent?.progress(1);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(site); setPage(1); setExpanded(null); setToAdd(null); }, [site]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => summarizeWhereToBuy(rows), [rows]);
  const groups = useMemo(() => groupWhereToBuy(rows), [rows]);
  const siteSkus = useMemo(() => new Set(rows.map((r) => r.sku)), [rows]);
  const toAddList = useMemo(() => linksToAdd(rows), [rows]);
  // Only retailers present on this site get a column.
  const columns = useMemo(() => {
    const seen = new Set(rows.filter((r) => r.section === 'where_to_buy' && r.url).map((r) => r.retailer));
    return WTB_RETAILERS.filter((r) => seen.has(r.key));
  }, [rows]);

  const statusLabel = WTB_STATUSES.find((f) => f.key === status)?.label ?? null;
  // The links the pressed counter counts — in the chosen retailer, when one is.
  const hit = useMemo(
    () => (status ? (l) => linkBucket(l) === status && (retailerFilter === 'all' || l.retailer === retailerFilter) : null),
    [status, retailerFilter],
  );
  // How many such links each product has (the list's last column, and its order).
  const hits = useMemo(() => new Map(hit ? groups.map((g) => [g.sku, g.links.filter(hit).length]) : []), [groups, hit]);

  const filtered = useMemo(() => {
    let list = groups;
    if (toAdd) list = list.filter((g) => g.missing.includes(toAdd));
    else if (hit) list = list.filter((g) => hits.get(g.sku) > 0).sort((a, b) => hits.get(b.sku) - hits.get(a.sku) || a.sku.localeCompare(b.sku));
    else if (onlyProblems) list = list.filter((g) => g.problems > 0);
    if (retailerFilter !== 'all' && !hit) list = list.filter((g) => g.links.some((l) => l.retailer === retailerFilter && (!onlyProblems || isLinkProblem(l))));
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((g) => g.sku.toLowerCase().includes(q));
    return list;
  }, [groups, onlyProblems, retailerFilter, search, toAdd, hit, hits]);
  const hitCount = hit ? filtered.reduce((n, g) => n + hits.get(g.sku), 0) : 0;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); setAllLinks(false); }, [onlyProblems, retailerFilter, search, toAdd, status]);
  const pickStatus = (key) => { setStatus(key); setToAdd(null); setExpanded(null); };

  const copySkus = async (retailer, skus) => {
    try { await navigator.clipboard.writeText(skus.join('\n')); setCopied(retailer); setTimeout(() => setCopied(null), 2000); } catch { /* clipboard blocked */ }
  };

  // Each action has its own card; its reload is the last 10% of it.
  const runRepublish = async (skus) => {
    setRepublish({ done: 0, total: skus.length, errors: 0 });
    setError(null);
    const task = startTask("Publish the PIM's links", { detail: `Publishing ${skus.length} ${skus.length === 1 ? 'product' : 'products'}…` });
    try {
      const r = await republishWhereToBuy(skus, (p) => setRepublish(p), { task: task.part(0, 0.9) });
      task.progress(0.9, 'Reloading the links…');
      const reloaded = await reload(site, task.part(0.9, 1));
      if (r.errors) task.fail(`${r.done - r.errors} of ${r.done} products published; ${r.errors} failed`);
      else if (!reloaded) task.fail('Published, but the links could not be reloaded');
      else task.finish(`${r.done} ${r.done === 1 ? 'product' : 'products'} published`);
    } catch (e) {
      task.fail(e);
      setError(e);
    } finally { setRepublish(null); }
  };

  const runScan = async () => {
    setBusy('scan');
    setError(null);
    const task = startTask('Where to Buy scan', { detail: 'Reading the WHERE TO BUY sections of both sites…' });
    try {
      await scanWhereToBuy();
      task.progress(0.9, 'Reloading the links…');
      if (await reload(site, task.part(0.9, 1))) task.finish('Scanned');
      else task.fail('Scanned, but the links could not be reloaded');
    } catch (e) {
      task.fail(e);
      setError(e);
    } finally { setBusy(null); }
  };
  const runCheck = async () => {
    setBusy('check');
    setError(null);
    setProgress({ checked: 0 });
    const task = startTask('Where to Buy check', { detail: 'Checking the links that are due…' });
    try {
      const r = await checkWhereToBuy({ onProgress: (p) => setProgress(p), task: task.part(0, 0.9), due });
      task.progress(0.9, 'Reloading the links…');
      if (await reload(site, task.part(0.9, 1))) task.finish(`${r.checked.toLocaleString()} links checked${r.done ? '' : ' · the automatic pass checks the rest'}`);
      else task.fail(`${r.checked.toLocaleString()} links checked, but the links could not be reloaded`);
    } catch (e) {
      task.fail(e);
      setError(e);
    } finally { setBusy(null); setProgress(null); }
  };

  const counts = summary.byStatus;
  const stat = (label, value) => (
    <div key={label} className="min-w-[5.5rem]">
      <p className="text-title-lg font-semibold tabular-nums text-on-surface">{value ?? 0}</p>
      <p className="text-label-md text-on-surface-variant">{label}</p>
    </div>
  );
  // A status counter: the filter of the list below. Its box only shows when it
  // is pressed or pointed at (padding cancelled by the margin, so the numbers
  // stay where they were); one at 0 has nothing to list.
  const statusStat = (f) => {
    const value = counts[f.key] ?? 0;
    const on = status === f.key;
    return (
      <button
        key={f.key}
        type="button"
        aria-pressed={on}
        disabled={!value && !on}
        onClick={() => pickStatus(on ? null : f.key)}
        title={on ? 'Back to the usual list' : value ? `List the ${value.toLocaleString()} "${f.label}" links below` : undefined}
        className={`min-w-[5.5rem] -mx-3 -my-2 px-3 py-2 rounded-xl border text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-default ${on ? 'border-primary bg-primary-container/30' : 'border-transparent enabled:hover:bg-surface-container-low enabled:hover:border-outline-variant'}`}
      >
        <span className={`block text-title-lg font-semibold tabular-nums ${value && f.tone ? f.tone : 'text-on-surface'}`}>{value}</span>
        <span className="block text-label-md text-on-surface-variant">{f.label}</span>
      </button>
    );
  };

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
              Scanned {fmtWhen(summary.lastScan)} · last check {fmtWhen(summary.lastCheck)} · links are checked every Monday, Wednesday and Friday from 1 AM (Cambridge time), new ones right away · stores that block the PIM are opened through Bright Data or ScraperAPI
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {sites.length > 1 && (
              <div className="inline-flex rounded-full bg-surface-container p-1" role="tablist" aria-label="Website">
                {sites.map((s) => (
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
            )}
            {rows.length > 0 && <WhereToBuySuggestions skus={siteSkus} onApplied={() => reload()} />}
            <WhereToBuyExcel onImported={() => reload()} />
            {canEdit && (
              <>
                <button
                  type="button"
                  onClick={runScan}
                  disabled={busy != null}
                  aria-busy={busy === 'scan'}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40"
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
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:bg-primary/90 disabled:opacity-40"
                  title="Check the links that are due now. The automatic checks run every Monday, Wednesday and Friday from 1 AM (Cambridge time); new links are checked right away."
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
          <div role="group" aria-label="List the links by their status" className="contents">
            {WTB_STATUSES.map(statusStat)}
          </div>
        </div>
        <p className="mt-3 text-body-sm text-on-surface-variant">
          Press a status to list its links below; press it again for the usual list.
          {counts.not_covered > 0 && ` Walmart USA is not covered yet: its ${counts.not_covered} broken or wrong links are not counted above (they stay off the websites).`}
        </p>
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
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40"
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
            <h3 className="text-title-md font-semibold text-on-surface">Links to add · {counts.missing ?? 0}</h3>
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
                    onClick={() => { setToAdd(active ? null : p.retailer); setStatus(null); }}
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
            ) : status ? (
              <span className="inline-flex items-center gap-2 text-body-sm text-on-surface">
                <span>Showing: <span className="font-semibold">{statusLabel}</span></span>
                <button type="button" onClick={() => pickStatus(null)} className="px-2 py-0.5 rounded-md text-primary hover:bg-surface-container">Clear</button>
              </span>
            ) : (
              <label className="inline-flex items-center gap-2 text-body-sm text-on-surface cursor-pointer">
                <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} className="accent-primary" />
                Only broken or wrong links
              </label>
            )}
            <span role="status" className="text-body-sm text-on-surface-variant ml-auto">
              {filtered.length} of {groups.length} products{status ? ` · ${hitCount.toLocaleString()} ${hitCount === 1 ? 'link' : 'links'}` : ''}
            </span>
            {status && filtered.length > 0 && (
              <button
                type="button"
                onClick={() => copySkus('status', filtered.map((g) => g.sku))}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors"
              >
                {copied === 'status' ? <Check className="w-3.5 h-3.5 text-success" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
                {copied === 'status' ? 'Copied' : `Copy ${filtered.length} ${filtered.length === 1 ? 'SKU' : 'SKUs'}`}
              </button>
            )}
          </div>
          <div className="relative overflow-x-auto">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="bg-surface-container-low text-label-md text-on-surface-variant">
                  <th className="sticky left-0 bg-surface-container-low text-left px-4 py-2 font-semibold">SKU</th>
                  {columns.map((c) => (
                    <th key={c.key} className="px-1 py-2 font-semibold text-center whitespace-nowrap" title={c.label}>{c.short}</th>
                  ))}
                  <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">{status ? statusLabel : 'Issues'}</th>
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
                      <tr className="border-t border-outline-variant hover:bg-surface-container-low cursor-pointer" onClick={() => { setExpanded(open ? null : g.sku); setAllLinks(false); }}>
                        <td className="sticky left-0 bg-surface-container-lowest px-4 py-1.5 font-semibold text-on-surface whitespace-nowrap">
                          <Link to={`/catalog/${g.sku}`} className="inline-block py-[3px] -my-[3px] hover:underline" onClick={(e) => e.stopPropagation()}>{g.sku}</Link>
                        </td>
                        {columns.map((c) => (
                          <td key={c.key} className="px-1 py-1.5 text-center"><Cell links={byRetailer.get(c.key)} hit={hit} /></td>
                        ))}
                        {status ? (
                          <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-on-surface">{hits.get(g.sku)}</td>
                        ) : (
                          <td className={`px-3 py-1.5 text-right tabular-nums ${g.problems ? 'text-error font-semibold' : 'text-on-surface-variant'}`}>{g.problems}</td>
                        )}
                        <td className="px-2 py-1.5 text-on-surface-variant">
                          {/* The row opens on click; this button lets the keyboard do it too
                              (its click reaches the row's onClick). Plain look, no press sink. */}
                          <button type="button" aria-expanded={open} aria-label={`Links of ${g.sku}`} className="block p-1 -m-1 cursor-pointer active:scale-none!">
                            <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-t border-outline-variant bg-surface-container-low/60">
                          <td colSpan={columns.length + 3} className="px-4 py-3">
                            <table className="w-full max-w-6xl table-fixed text-body-sm">
                              <caption className="sr-only">Where to Buy links of {g.sku}</caption>
                              <colgroup>
                                <col className="w-[8.5rem]" />
                                <col className="w-[12rem]" />
                                <col />
                                <col className="w-[13rem]" />
                                <col className="w-[13rem]" />
                              </colgroup>
                              <tbody className="divide-y divide-outline-variant/50">
                                {(hit && !allLinks ? g.links.filter(hit) : [...g.links]).sort(byStoreOrder).map((l) => {
                                  const checked = l.checked_via && (l.verdict === 'ok' || l.verdict === 'broken');
                                  const when = checked ? `${WTB_VIA[l.checked_via] ?? l.checked_via} · ${fmtWhen(l.checked_at)}` : '';
                                  const read = pageReading(l);
                                  const wrong = isWrongProduct(l);
                                  const detail = [
                                    l.verdict !== 'ok' ? l.note : null,
                                    wrong && l.page_model ? `The page shows ${l.page_model}, not ${g.sku}${l.sku_check === 'variant' ? ' (another option of the same product)' : ''}` : null,
                                    wrong && l.verdict !== 'broken' ? linkStatus(l).hint : null,
                                    isOtherFinish(l) && l.verdict !== 'broken' ? `The page opens on ${l.page_model ?? 'another finish'}, the listing's default option. ${linkStatus(l).hint}` : null,
                                    linkStatus(l) === OUT_OF_STOCK ? [l.verdict === 'ok' ? l.note : null, OUT_OF_STOCK.hint].filter(Boolean).join('. ') : null,
                                    when ? `Checked by ${when}` : null,
                                  ].filter(Boolean).join('\n');
                                  return (
                                    <tr key={l.id} className="h-9 align-middle">
                                      <td className="pr-3"><StatusChip link={l} detail={detail} /></td>
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
                                      <td className={`pr-3 text-label-md truncate ${wrong ? 'text-warning font-semibold' : 'text-on-surface-variant'}`} title={read ? `On the page (${fmtWhen(l.read_at)}): ${read.text}` : undefined}>
                                        {read ? read.text : ''}
                                      </td>
                                      <td className="text-label-md text-on-surface-variant truncate" title={detail || undefined}>
                                        {when || (l.verdict === 'pending' ? (l.note ? 'Trying again soon' : 'Waiting for its check') : '')}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                            {hit && (
                              <p className="mt-2 text-body-sm text-on-surface-variant">
                                {allLinks ? `Every link of ${g.sku}.` : `The ${hits.get(g.sku)} "${statusLabel}" ${hits.get(g.sku) === 1 ? 'link' : 'links'} of ${g.sku}${retailerFilter !== 'all' ? ' at this retailer' : ''}, of ${g.links.length}.`}{' '}
                                <button type="button" onClick={() => setAllLinks(!allLinks)} className="text-primary underline underline-offset-2">
                                  {allLinks ? `Only the "${statusLabel}" ones` : `Show all ${g.links.length}`}
                                </button>
                              </p>
                            )}
                            <p className="mt-2 text-body-sm text-on-surface-variant">
                              Change the links in the product&apos;s <Link to={`/catalog/${encodeURIComponent(g.sku)}?tab=where_to_buy`} className="text-primary underline underline-offset-2">Where to Buy tab</Link> — the PIM writes the product&apos;s pages from it.
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
                      {toAdd ? 'No product misses this link.' : status ? `No "${statusLabel}" links match.` : onlyProblems ? 'No broken or wrong links on this site.' : 'No products match.'}
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
