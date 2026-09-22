import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, AlertCircle, CheckCircle2, ListChecks, ShieldCheck, PlusCircle, RefreshCw, Search } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { latestSnapshot } from '../lib/channels';
import { previewWalmartItems, submitWalmartItems, walmartFeedStatus } from '../api/walmartAdd';

// Bulk item setup for Walmart USA: pick the products that are not on Walmart
// yet, check their mapping and validate it against Walmart's spec (nothing sent),
// and — with an explicit confirmation — create them in the real catalog.
// Sinks only until the other categories' rules are agreed.
const SINK_CATEGORIES = ['kitchen_sink', 'bathroom_sink', 'bar_prep_sink', 'outdoor_sink', 'laundry_sink'];
const PAGE = 1000;

export default function WalmartBulkAdditionCard() {
  const { canEdit } = useAuth();
  const confirm = useConfirm();
  const [products, setProducts] = useState(null); // null = loading
  const [onWalmart, setOnWalmart] = useState(new Set());
  const [selected, setSelected] = useState(new Set());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(null); // 'preview' | 'validate' | 'create' | 'status'
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const rows = [];
      for (let from = 0; ; from += PAGE) {
        const { data } = await supabase
          .from('products')
          .select('sku, model_name, category, brand, workflow_status')
          .in('category', SINK_CATEGORIES)
          .neq('workflow_status', 'archived')
          .order('sku')
          .range(from, from + PAGE - 1);
        rows.push(...(data ?? []));
        if (!data || data.length < PAGE) break;
      }
      const snap = await latestSnapshot('walmart_us');
      if (!active) return;
      setOnWalmart(new Set((snap?.results ?? []).map((r) => r.sku)));
      setProducts(rows);
    })();
    return () => { active = false; };
  }, []);

  const candidates = useMemo(() => (products ?? []).filter((p) => !onWalmart.has(p.sku)), [products, onWalmart]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? candidates.filter((p) => p.sku.toLowerCase().includes(q) || (p.model_name ?? '').toLowerCase().includes(q)) : candidates;
  }, [candidates, search]);
  const bySku = useMemo(() => new Map((result?.products ?? []).map((r) => [r.sku, r])), [result]);
  const picked = [...selected];
  const readyCount = picked.filter((s) => bySku.get(s)?.ready).length;
  // Create unlocks only after a clean Validate of the whole selection.
  const canCreate = result?.preview && result?.validation?.valid === true && picked.length > 0 && readyCount === picked.length;

  function toggle(sku) {
    setSelected((s) => { const n = new Set(s); n.has(sku) ? n.delete(sku) : n.add(sku); return n; });
  }
  function toggleAll() {
    setSelected((s) => (shown.every((p) => s.has(p.sku)) ? new Set([...s].filter((x) => !shown.some((p) => p.sku === x))) : new Set([...s, ...shown.map((p) => p.sku)])));
  }

  async function run(mode) {
    if (!picked.length) return;
    if (mode === 'create') {
      const ok = await confirm({
        title: `Create ${picked.length} item${picked.length === 1 ? '' : 's'} on Walmart USA?`,
        message: 'This posts the items to the real Walmart catalog. Walmart processes them in minutes to hours; it cannot be undone from the PIM.',
        confirmLabel: 'Create listings',
      });
      if (!ok) return;
    }
    setBusy(mode);
    setStatus(null);
    try {
      const data = mode === 'preview' || mode === 'validate'
        ? await previewWalmartItems(picked, { validate: mode === 'validate' })
        : await submitWalmartItems(picked, { sandbox: mode === 'sandbox', confirm: mode === 'create' ? 'CREATE' : undefined });
      setResult(data);
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setBusy(null);
    }
  }

  async function refreshStatus() {
    if (!result?.feedId) return;
    setBusy('status');
    try { setStatus(await walmartFeedStatus(result.feedId, { sandbox: result.env === 'sandbox' })); }
    catch (err) { setStatus({ error: err.message }); }
    finally { setBusy(null); }
  }

  const btn = 'inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50';

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-6 py-5 border-b border-outline-variant flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-title-lg text-on-surface leading-tight">New listings</h2>
          <p className="text-body-sm text-on-surface-variant mt-0.5">
            Sinks not on Walmart USA yet. Check the mapping and validate against Walmart's spec before creating.
          </p>
        </div>
        <label className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="SKU or name" className="pl-9 pr-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-sm w-56" />
        </label>
      </div>

      <div className="px-6 py-4 space-y-3">
        {canEdit && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-body-sm text-on-surface-variant">{picked.length} selected{result?.preview ? ` · ${readyCount} ready` : ''}</span>
            <button type="button" onClick={() => run('preview')} disabled={!!busy || !picked.length} className={btn}>
              {busy === 'preview' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ListChecks className="w-4 h-4" />}
              Check mapping
            </button>
            <button type="button" onClick={() => run('validate')} disabled={!!busy || !picked.length} className={btn} title="Checks the selected products against Walmart's official item spec. Nothing is sent.">
              {busy === 'validate' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              Validate
            </button>
            <button
              type="button"
              onClick={() => run('create')}
              disabled={!!busy || !canCreate}
              title={canCreate ? undefined : 'Validate first — every selected product must be ready and pass the spec check'}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 transition-opacity disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed"
            >
              {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlusCircle className="w-4 h-4" />}
              Create listings
            </button>
            {result?.feedId && (
              <button type="button" onClick={refreshStatus} disabled={!!busy} className={btn}>
                {busy === 'status' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Check feed
              </button>
            )}
          </div>
        )}

        {result?.error && (
          <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-error-container text-on-error-container">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /><span className="break-words">{result.error}</span>
          </div>
        )}
        {result?.validation && (
          <p className={`text-body-sm ${result.validation.valid ? 'text-success' : 'text-error'}`}>
            {result.validation.valid ? `Spec check passed for ${result.validation.checked} product${result.validation.checked === 1 ? '' : 's'}` : `Spec errors on ${Object.keys(result.validation.errors ?? {}).length} product(s) — hover the red rows`}
          </p>
        )}
        {result?.feedId && (
          <p className="text-body-sm text-on-surface-variant">
            {result.env} feed {result.feedId}{result.feedStatus ? ` · ${result.feedStatus}` : ''}
            {result.itemsReceived != null ? ` · received ${result.itemsReceived} · succeeded ${result.itemsSucceeded ?? 0} · failed ${result.itemsFailed ?? 0} · processing ${result.itemsProcessing ?? 0}` : ''}
          </p>
        )}
        {status && (
          <div className="text-body-sm space-y-1">
            {status.error ? <span className="text-error">{status.error}</span> : (
              <>
                <div className="text-on-surface-variant">Feed {status.feedStatus ?? '—'} · received {status.itemsReceived ?? 0} · succeeded {status.itemsSucceeded ?? 0} · failed {status.itemsFailed ?? 0} · processing {status.itemsProcessing ?? 0}</div>
                {(status.items ?? []).filter((it) => it.ingestionStatus !== 'SUCCESS').map((it, i) => (
                  <div key={i} className="text-error">{it.sku}: {(it.ingestionErrors?.ingestionError ?? []).map((e) => e.description).join(' · ') || it.ingestionStatus}</div>
                ))}
              </>
            )}
          </div>
        )}

        {products === null ? (
          <p className="text-body-sm text-on-surface-variant">Loading products…</p>
        ) : candidates.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant">Every sink is already on Walmart USA.</p>
        ) : (
          <div className="rounded-lg border border-outline-variant overflow-hidden">
            <table className="w-full text-body-sm">
              <thead className="bg-surface-container-low text-label-sm text-on-surface-variant">
                <tr>
                  <th className="px-3 py-2 text-left w-8"><input type="checkbox" checked={shown.length > 0 && shown.every((p) => selected.has(p.sku))} onChange={toggleAll} className="accent-primary" /></th>
                  <th className="px-3 py-2 text-left">SKU</th>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-left">Brand</th>
                  <th className="px-3 py-2 text-left">Mapping</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/60">
                {shown.map((p) => {
                  const r = bySku.get(p.sku);
                  return (
                    <tr key={p.sku} className={selected.has(p.sku) ? 'bg-primary-container/15' : ''}>
                      <td className="px-3 py-1.5"><input type="checkbox" checked={selected.has(p.sku)} onChange={() => toggle(p.sku)} className="accent-primary" /></td>
                      <td className="px-3 py-1.5 font-mono"><Link to={`/catalog/${encodeURIComponent(p.sku)}?tab=marketplaces`} className="text-primary hover:underline">{p.sku}</Link></td>
                      <td className="px-3 py-1.5 text-on-surface">{p.model_name}</td>
                      <td className="px-3 py-1.5 text-on-surface-variant">{p.brand}</td>
                      <td className="px-3 py-1.5">
                        {!r ? <span className="text-on-surface-variant">—</span>
                          : r.specErrors?.length ? <span className="inline-flex items-center gap-1 text-error" title={r.specErrors.map((e) => `${e.path || '/'}: ${e.message}`).join(String.fromCharCode(10))}><AlertCircle className="w-3.5 h-3.5" /> {r.specErrors.length} spec error{r.specErrors.length === 1 ? '' : 's'}</span>
                          : r.ready ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="w-3.5 h-3.5" /> {r.fields} fields{r.warnings?.length ? ` · ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}` : ''}</span>
                          : <span className="inline-flex items-center gap-1 text-error" title={r.missing.join(', ')}><AlertCircle className="w-3.5 h-3.5" /> missing {r.missing.join(', ')}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length === 0 && <p className="px-3 py-3 text-body-sm text-on-surface-variant">No product matches.</p>}
          </div>
        )}
        {result?.skipped?.length > 0 && (
          <p className="text-body-sm text-on-surface-variant">{result.skipped.map((s) => `${s.sku}: ${s.reason}`).join(' · ')}</p>
        )}
      </div>
    </section>
  );
}
