import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, AlertCircle, CheckCircle2, ListChecks, Send, RefreshCw, Search } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { CATEGORY_OPTIONS } from '@/features/products/lib/categories';
import { latestSnapshot } from '../lib/channels';
import { previewWalmartItems, submitWalmartItems, walmartFeedStatus } from '../api/walmartAdd';

// Walmart USA in lots (user, 2026-10-30: "queremos todos, pero podemos
// empezar por lotes"). Almost every Stylish product already has a listing in
// Walmart's catalog (from Walmart Canada, without offers), and a new item on
// its UPC fails (ERR_PDI_0001), so a lot goes as OFFERS BY MATCH: each product
// joins the listing that has its UPC, at MAP Blue USD (walmart-add-items,
// setup "match"). Sending a lot switches Walmart USA on for its products; their
// stock follows by the hourly sync (WalmartUsStockCard). The content stays
// Walmart's until the brand is approved on Walmart's Brand Portal.
// Products with USA stock come first; a lot is at most LOT_MAX products.
const PAGE = 1000;
const LOT_MAX = 100;
const CATEGORY = new Map(CATEGORY_OPTIONS.map((c) => [c.value, c.label]));

async function readAll(table, columns, build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(supabase.from(table).select(columns)).range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// Walmart's answer for one SKU of a feed, in a few words.
const itemOutcome = (it) => (it.ingestionStatus === 'SUCCESS'
  ? { ok: true, text: 'Added' }
  : { ok: false, text: (it.ingestionErrors?.ingestionError ?? []).map((e) => e.description).filter(Boolean).join(' · ') || it.ingestionStatus || 'Not processed' });

export default function WalmartBulkAdditionCard() {
  const { canEdit } = useAuth();
  const confirm = useConfirm();
  const [products, setProducts] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(null);
  const [onWalmart, setOnWalmart] = useState(new Set());
  const [selected, setSelected] = useState(new Set());
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [stockOnly, setStockOnly] = useState(true);
  const [busy, setBusy] = useState(null); // 'check' | 'send' | 'status'
  const [check, setCheck] = useState(null); // the last preview
  const [sent, setSent] = useState(null); // the last submit
  const [outcome, setOutcome] = useState(new Map()); // sku → { ok, text }
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [rows, stock, snap] = await Promise.all([
          readAll('products', 'sku, model_name, category, brand, map_usd', (q) => q.neq('workflow_status', 'archived').order('sku')),
          readAll('product_inventory', 'sku, available', (q) => q.eq('market', 'us').order('sku')),
          latestSnapshot('walmart_us'),
        ]);
        if (!active) return;
        const stockOf = new Map(stock.map((s) => [s.sku, Number(s.available ?? 0)]));
        setOnWalmart(new Set((snap?.results ?? []).map((r) => r.sku)));
        setProducts(rows.map((p) => ({ ...p, stock: stockOf.has(p.sku) ? stockOf.get(p.sku) : null })));
      } catch (e) {
        if (active) setLoadError(e.message);
      }
    })();
    return () => { active = false; };
  }, []);

  const candidates = useMemo(() => (products ?? [])
    .filter((p) => !onWalmart.has(p.sku))
    .sort((a, b) => (b.stock ?? -1) - (a.stock ?? -1) || a.sku.localeCompare(b.sku)), [products, onWalmart]);
  const categories = useMemo(() => [...new Set(candidates.map((p) => p.category))].sort((a, b) => (CATEGORY.get(a) ?? a).localeCompare(CATEGORY.get(b) ?? b)), [candidates]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return candidates.filter((p) => (category === 'all' || p.category === category)
      && (!stockOnly || (p.stock ?? 0) > 0)
      && (!q || p.sku.toLowerCase().includes(q) || (p.model_name ?? '').toLowerCase().includes(q)));
  }, [candidates, category, stockOnly, search]);
  const checked = useMemo(() => new Map((check?.products ?? []).map((r) => [r.sku, r])), [check]);
  const picked = [...selected];
  const ready = picked.filter((s) => checked.get(s)?.ready);
  const checkedAll = picked.length > 0 && picked.every((s) => checked.has(s) || (check?.skipped ?? []).some((x) => x.sku === s));

  function toggle(sku) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(sku)) n.delete(sku); else if (n.size < LOT_MAX) n.add(sku);
      return n;
    });
  }
  function toggleAll() {
    setSelected((s) => {
      if (shown.length && shown.every((p) => s.has(p.sku))) return new Set([...s].filter((x) => !shown.some((p) => p.sku === x)));
      const n = new Set(s);
      for (const p of shown) { if (n.size >= LOT_MAX) break; n.add(p.sku); }
      return n;
    });
  }

  async function runCheck() {
    if (!picked.length) return;
    setBusy('check'); setError(null);
    try { setCheck(await previewWalmartItems(picked, { setup: 'match', enableChannel: true })); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  async function runSend() {
    if (!ready.length) return;
    const ok = await confirm({
      title: `Send ${ready.length} product${ready.length === 1 ? '' : 's'} to Walmart USA?`,
      message: `Each one becomes our offer on the Walmart listing that has its UPC, at its MAP Blue USD price, and Walmart USA is switched on for it in the PIM. Its stock follows with the hourly stock sync (0 until then). Walmart takes minutes to hours to process the lot; it cannot be undone from the PIM.${picked.length > ready.length ? ` ${picked.length - ready.length} selected product(s) are not ready and stay out.` : ''}`,
      confirmLabel: 'Send lot',
    });
    if (!ok) return;
    setBusy('send'); setError(null);
    try {
      const data = await submitWalmartItems(ready, { sandbox: false, confirm: 'CREATE', setup: 'match', enableChannel: true });
      setSent(data);
      const next = new Map(outcome);
      for (const it of data.items ?? []) next.set(it.sku, itemOutcome(it));
      for (const sku of data.submitted ?? []) if (!next.has(sku)) next.set(sku, { ok: null, text: 'Sent — waiting for Walmart' });
      setOutcome(next);
      setSelected(new Set());
      setCheck(null);
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  async function refreshStatus() {
    if (!sent?.feedId) return;
    setBusy('status'); setError(null);
    try {
      const data = await walmartFeedStatus(sent.feedId, { sandbox: false });
      setSent((s) => ({ ...s, feedStatus: data.feedStatus, itemsReceived: data.itemsReceived, itemsSucceeded: data.itemsSucceeded, itemsFailed: data.itemsFailed, itemsProcessing: data.itemsProcessing }));
      setOutcome((o) => { const n = new Map(o); for (const it of data.items ?? []) n.set(it.sku, itemOutcome(it)); return n; });
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  const btn = 'inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50';
  const fmtMoney = (v) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-6 py-5 border-b border-outline-variant flex items-start justify-between gap-3 flex-wrap">
        <div className="max-w-3xl">
          <h2 className="text-title-lg text-on-surface leading-tight">Add products in lots</h2>
          <p className="text-body-sm text-on-surface-variant mt-0.5">
            Products not on Walmart USA yet, those with USA stock first. Pick a lot (up to {LOT_MAX}), check it and send it: each product becomes our offer on the Walmart listing that has its UPC, at MAP Blue USD, and its stock follows with the hourly sync.
          </p>
        </div>
        <label className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" aria-hidden="true" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="SKU or name" aria-label="Search products by SKU or name" className="pl-9 pr-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-sm w-56" />
        </label>
      </div>

      <div className="px-6 py-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="inline-flex items-center gap-2 text-body-sm text-on-surface">
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="px-2 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm">
              <option value="all">All</option>
              {categories.map((c) => <option key={c} value={c}>{CATEGORY.get(c) ?? c}</option>)}
            </select>
          </label>
          <label className="inline-flex items-center gap-2 text-body-sm text-on-surface">
            <input type="checkbox" checked={stockOnly} onChange={(e) => setStockOnly(e.target.checked)} className="accent-primary" />
            Only with USA stock
          </label>
          <span className="text-body-sm text-on-surface-variant">{shown.length} shown · {candidates.length} not on Walmart USA</span>
        </div>

        {canEdit && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-body-sm text-on-surface-variant">{picked.length} in the lot{picked.length >= LOT_MAX ? ` (the most a lot takes)` : ''}{check ? ` · ${ready.length} ready` : ''}</span>
            <button type="button" onClick={runCheck} disabled={!!busy || !picked.length} className={btn} title="Checks UPC, price and shipping weight of every product of the lot. Nothing is sent.">
              {busy === 'check' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <ListChecks className="w-4 h-4" aria-hidden="true" />}
              Check lot
            </button>
            <button
              type="button"
              onClick={runSend}
              disabled={!!busy || !checkedAll || !ready.length}
              title={checkedAll ? undefined : 'Check the lot first'}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 transition-opacity disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed"
            >
              {busy === 'send' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Send className="w-4 h-4" aria-hidden="true" />}
              Send lot{checkedAll && ready.length ? ` (${ready.length})` : ''}
            </button>
            {sent?.feedId && (
              <button type="button" onClick={refreshStatus} disabled={!!busy} className={btn}>
                {busy === 'status' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-4 h-4" aria-hidden="true" />}
                Check Walmart's answer
              </button>
            )}
          </div>
        )}

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-error-container text-on-error-container">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" /><span className="break-words">{error}</span>
          </div>
        )}
        {sent?.feedId && (
          <p role="status" className="text-body-sm text-on-surface-variant">
            Lot sent: {sent.submitted?.length ?? 0} product{(sent.submitted?.length ?? 0) === 1 ? '' : 's'}{sent.feedStatus ? ` · Walmart: ${sent.feedStatus}` : ''}
            {sent.itemsReceived != null ? ` · added ${sent.itemsSucceeded ?? 0} · failed ${sent.itemsFailed ?? 0} · processing ${sent.itemsProcessing ?? 0}` : ''}
            {' '}— they show on Walmart USA's list above at its next refresh.
          </p>
        )}
        {check?.skipped?.length > 0 && (
          <p className="text-body-sm text-on-surface-variant">{check.skipped.map((s) => `${s.sku}: ${s.reason}`).join(' · ')}</p>
        )}

        {loadError ? (
          <p role="alert" className="text-body-sm text-error">{loadError}</p>
        ) : products === null ? (
          <p role="status" className="text-body-sm text-on-surface-variant">Loading products…</p>
        ) : candidates.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant">Every product is already on Walmart USA.</p>
        ) : (
          <div className="rounded-lg border border-outline-variant overflow-x-auto">
            <table className="w-full text-body-sm">
              <thead className="bg-surface-container-low text-label-sm text-on-surface-variant">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left w-8"><input type="checkbox" checked={shown.length > 0 && shown.every((p) => selected.has(p.sku))} onChange={toggleAll} aria-label={`Select the shown products (up to ${LOT_MAX})`} className="accent-primary" /></th>
                  <th scope="col" className="px-3 py-2 text-left">SKU</th>
                  <th scope="col" className="px-3 py-2 text-left">Product</th>
                  <th scope="col" className="px-3 py-2 text-left">Category</th>
                  <th scope="col" className="px-3 py-2 text-right">USA stock</th>
                  <th scope="col" className="px-3 py-2 text-right">MAP USD</th>
                  <th scope="col" className="px-3 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/60">
                {shown.map((p) => {
                  const r = checked.get(p.sku);
                  const out = outcome.get(p.sku);
                  return (
                    <tr key={p.sku} className={selected.has(p.sku) ? 'bg-primary-container/15' : ''}>
                      <td className="px-3 py-1.5"><input type="checkbox" checked={selected.has(p.sku)} onChange={() => toggle(p.sku)} disabled={!selected.has(p.sku) && selected.size >= LOT_MAX} aria-label={`Add ${p.sku} to the lot`} className="accent-primary" /></td>
                      <td className="px-3 py-1.5 font-mono"><Link to={`/catalog/${encodeURIComponent(p.sku)}?tab=marketplaces`} className="text-primary hover:underline">{p.sku}</Link></td>
                      <td className="px-3 py-1.5 text-on-surface">{p.model_name}</td>
                      <td className="px-3 py-1.5 text-on-surface-variant">{CATEGORY.get(p.category) ?? p.category}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{p.stock == null ? <span className="text-on-surface-variant">Not tracked</span> : p.stock}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(p.map_usd)}</td>
                      <td className="px-3 py-1.5">
                        {out ? (
                          <span className={`inline-flex items-center gap-1 ${out.ok === true ? 'text-success' : out.ok === false ? 'text-error' : 'text-on-surface-variant'}`}>
                            {out.ok === true ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> : out.ok === false ? <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" /> : <Loader2 className="w-3.5 h-3.5" aria-hidden="true" />}
                            {out.text}
                          </span>
                        ) : !r ? <span className="text-on-surface-variant">—</span>
                          : r.ready ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> Ready</span>
                          : <span className="inline-flex items-center gap-1 text-error"><AlertCircle className="w-3.5 h-3.5" aria-hidden="true" /> Missing {r.missing.join(', ')}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length === 0 && <p className="px-3 py-3 text-body-sm text-on-surface-variant">No product matches.</p>}
          </div>
        )}
      </div>
    </section>
  );
}
