import { useEffect, useMemo, useState } from 'react';
import {
  Tag,
  Plus,
  ChevronDown,
  Trash2,
  Send,
  Play,
  Square,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  X,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import {
  listPromotions,
  getPromotionPrices,
  parsePriceList,
  createPromotion,
  createPromotionFromFile,
  addFileToPromotion,
  markPromotionActive,
  deletePromotion,
  applyPromotion,
  endPromotion,
  pushPromotionToWix,
} from '@/features/pricing/api/promotions';
import { downloadPromoTemplate, parsePromoFile } from '@/features/pricing/lib/promoImport';
import { runPriceAlignment, loadLatestAlignment, pushExpectedPrice, fixAlignment } from '@/features/pricing/api/priceAlignment';
import { generateWayfairPromoFile } from '@/features/pricing/lib/wayfairPromoFill';
import { Link } from 'react-router-dom';

// Promotional dealer costs live in promo_costs keyed by channel-group slug.
// Each slug belongs to one market view (Canada or USA) — Wayfair Canada is
// billed in USD but it's still a Canadian channel.
const PROMO_COST_META = {
  rona_hd_cad: { label: 'Rona / Home Depot', unit: 'CAD', market: 'ca' },
  sod_cad: { label: 'Small Online Dealers', unit: 'CAD', market: 'ca' },
  wayfair_ca_usd: { label: 'Wayfair Canada', unit: 'USD', market: 'ca' },
  lowes_sod_bbb_usd: { label: 'Lowes / SOD / BB&B', unit: 'USD', market: 'us' },
  wayfair_usd: { label: 'Wayfair US', unit: 'USD', market: 'us' },
  menards_usd: { label: 'Menards', unit: 'USD', market: 'us' },
};
const costMeta = (slug) =>
  PROMO_COST_META[slug] ?? { label: slug, unit: slug.endsWith('_usd') ? 'USD' : 'CAD', market: slug.includes('usd') && !slug.includes('_ca_') ? 'us' : 'ca' };

const fmt = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);

const STATUS_META = {
  draft: { label: 'Draft', class: 'bg-surface-container text-on-surface-variant' },
  active: { label: 'Active', class: 'bg-primary-container text-on-primary-container' },
  ended: { label: 'Ended', class: 'bg-surface-container-high text-on-surface-variant' },
};

function monthLabel(period) {
  if (!period) return '';
  const [y, m] = String(period).split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, 1).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
}

export default function PricingPage() {
  const { canEdit } = useAuth();
  const confirm = useConfirm();
  const [tab, setTab] = useState('promotions'); // 'promotions' | 'alignment'
  const [promotions, setPromotions] = useState(null);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);

  async function reload() {
    try {
      setPromotions(await listPromotions());
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { reload(); }, []);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-headline-md text-on-surface font-semibold">Pricing</h1>
        <p className="text-body-md text-on-surface-variant mt-1">
          Monthly promotions for all marketplaces. Promo prices come from the official
          lists — paste them per month; marketplace promo templates will generate from here.
        </p>
      </div>

      <div className="inline-flex rounded-full bg-surface-container p-1">
        {[['promotions', 'Promotions'], ['alignment', 'Price Alignment']].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-5 py-2 rounded-full text-label-lg font-medium transition-colors ${
              tab === key ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-xl bg-error-container/60 text-on-error-container px-4 py-3 text-body-sm">
          {error}
        </div>
      )}

      {tab === 'alignment' && <PriceAlignmentCard canEdit={canEdit} confirm={confirm} />}

      {tab === 'promotions' && canEdit && (
        <div>
          <button
            type="button"
            onClick={() => setShowNew((v) => !v)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-primary text-on-primary text-label-lg font-semibold hover:opacity-90 transition-opacity"
          >
            <Plus className="w-4 h-4" />
            New promotion
          </button>
        </div>
      )}

      {tab === 'promotions' && showNew && (
        <NewPromotionForm
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); reload(); }}
        />
      )}

      {tab !== 'promotions' ? null : promotions === null ? (
        <div className="rounded-2xl bg-surface p-8 text-center text-on-surface-variant text-body-md">
          <Loader2 className="w-5 h-5 animate-spin inline-block mr-2 align-middle" />
          Loading promotions…
        </div>
      ) : promotions.length === 0 && !showNew ? (
        <div className="rounded-2xl bg-surface px-6 py-12 text-center">
          <div className="inline-flex w-12 h-12 items-center justify-center rounded-xl bg-surface-container mb-3">
            <Tag className="w-6 h-6 text-on-surface-variant" strokeWidth={1.5} />
          </div>
          <p className="text-title-md text-on-surface font-medium">No promotions yet</p>
          <p className="text-body-md text-on-surface-variant mt-1 max-w-md mx-auto">
            Create the month's promotion and paste its price list — SKU and promo price, one per line.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {promotions.map((promo) => (
            <PromotionCard
              key={promo.id}
              promo={promo}
              canEdit={canEdit}
              confirm={confirm}
              onChanged={reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================== Price alignment ==============================

const ALIGN_TILES = [
  { key: 'promo_ok', label: 'At promo price', tone: 'ok' },
  { key: 'map_ok', label: 'At regular MAP', tone: 'ok' },
  { key: 'promo_missing', label: 'Missing promo price', tone: 'warn' },
  { key: 'misaligned', label: 'Misaligned', tone: 'error' },
  { key: 'no_map', label: 'No MAP in PIM', tone: 'muted' },
];

const STATUS_TEXT = {
  promo_missing: 'still at regular MAP',
  misaligned: 'unexpected price',
  no_map: 'no MAP in the PIM',
  missing: 'product missing on Wix',
};

function PriceAlignmentCard({ canEdit, confirm }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [fixing, setFixing] = useState(null); // sku | 'all'
  const [progress, setProgress] = useState(null);
  const [msg, setMsg] = useState(null);

  // The last saved report (cron or manual run) shows instantly on open.
  useEffect(() => {
    let active = true;
    loadLatestAlignment()
      .then((r) => { if (active) setResult(r); })
      .catch((err) => { if (active) setMsg({ tone: 'error', text: err.message }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function analyze() {
    setRunning(true);
    setMsg(null);
    try {
      setResult(await runPriceAlignment());
    } catch (err) {
      setMsg({ tone: 'error', text: err.message });
    } finally {
      setRunning(false);
    }
  }

  const fixable = result?.problems.filter((p) => p.expected != null) ?? [];

  // Wix's query index (what the analysis reads) lags writes by ~15-30s —
  // re-running immediately would show the just-fixed rows as still broken.
  async function reanalyzeAfterIndexLag(prefix) {
    setMsg({ tone: 'success', text: `${prefix} Waiting ~20s for Wix's index before re-checking…` });
    await new Promise((resolve) => setTimeout(resolve, 20000));
    await analyze();
    setMsg({ tone: 'success', text: `${prefix} Analysis refreshed.` });
  }

  async function fixOne(problem) {
    const ok = await confirm({
      title: `Push $${Number(problem.expected).toFixed(2)} to Wix for ${problem.sku}?`,
      message: `Updates ONLY the price on the live store (currently $${Number(problem.live).toFixed(2)}). Nothing else on the listing is touched.`,
      confirmLabel: 'Push price',
    });
    if (!ok) return;
    setFixing(problem.sku);
    setMsg(null);
    try {
      await pushExpectedPrice(problem.sku, problem.expected);
      await reanalyzeAfterIndexLag(`${problem.sku} → $${Number(problem.expected).toFixed(2)} pushed.`);
    } catch (err) {
      setMsg({ tone: 'error', text: err.message });
    } finally {
      setFixing(null);
    }
  }

  async function fixAll() {
    const list = fixable.map((p) => `${p.sku}: $${Number(p.live).toFixed(2)} → $${Number(p.expected).toFixed(2)}`).join('\n');
    const ok = await confirm({
      title: `Push ${fixable.length} corrected price${fixable.length === 1 ? '' : 's'} to Wix?`,
      message: `Only prices are updated — nothing else on the listings.\n\n${list}`,
      confirmLabel: `Push ${fixable.length}`,
    });
    if (!ok) return;
    setFixing('all');
    setMsg(null);
    setProgress(null);
    try {
      const r = await fixAlignment(fixable, setProgress);
      setProgress(null);
      if (r.failures.length) {
        setMsg({ tone: 'error', text: `${r.fixed} pushed · failed: ${r.failures.join('; ')}` });
      } else {
        await reanalyzeAfterIndexLag(`${r.fixed} price${r.fixed === 1 ? '' : 's'} pushed.`);
      }
    } catch (err) {
      setMsg({ tone: 'error', text: err.message });
    } finally {
      setFixing(null);
      setProgress(null);
    }
  }

  return (
    <div className="rounded-2xl bg-surface p-6 space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-title-md text-on-surface font-semibold">Price Alignment — SinksDirect (Wix)</h2>
          <p className="text-body-sm text-on-surface-variant mt-0.5">
            Compares every linked product's live store price against its expected price —
            the active promo price for promo members, the regular MAP for everyone else.
            Reports save automatically twice a day; run a fresh one anytime.
          </p>
        </div>
        <button
          type="button"
          onClick={analyze}
          disabled={running}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-lg font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {running ? 'Analyzing…' : 'Run fresh analysis'}
        </button>
      </div>

      {loading && (
        <p className="text-body-sm text-on-surface-variant"><Loader2 className="w-4 h-4 animate-spin inline mr-1.5 align-middle" />Loading last report…</p>
      )}
      {!loading && !result && !msg && (
        <p className="text-body-sm text-on-surface-variant">No saved report yet — run the first analysis.</p>
      )}
      {result?.legacy && (
        <p className="text-body-sm rounded-lg px-3 py-2 bg-surface-container text-on-surface-variant">
          The last saved report ({new Date(result.ranAt).toLocaleString()}) predates the
          expected-price upgrade and can't be classified — run a fresh analysis.
        </p>
      )}

      {msg && (
        <p className={`text-body-sm rounded-lg px-3 py-2 inline-flex items-center gap-2 ${msg.tone === 'error' ? 'bg-error-container/60 text-on-error-container' : 'bg-surface-container text-on-surface-variant'}`}>
          {msg.tone === 'error' ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          {msg.text}
        </p>
      )}
      {progress && <p className="text-body-sm text-on-surface-variant">Pushing… {progress.done}/{progress.total}</p>}

      {result && !result.legacy && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {ALIGN_TILES.map((t) => {
              const n = result.counts[t.key] ?? 0;
              const tone = n === 0 && t.tone !== 'ok' ? 'muted' : t.tone;
              const cls = tone === 'ok' ? 'bg-primary-container/40 text-on-surface'
                : tone === 'warn' ? 'bg-tertiary-container/50 text-on-surface'
                : tone === 'error' ? 'bg-error-container/50 text-on-surface'
                : 'bg-surface-container-low text-on-surface-variant';
              return (
                <div key={t.key} className={`rounded-xl px-4 py-3 ${cls}`}>
                  <div className="text-headline-sm font-semibold tabular-nums">{n}</div>
                  <div className="text-label-md text-on-surface-variant">{t.label}</div>
                </div>
              );
            })}
          </div>
          <p className="text-body-sm text-on-surface-variant">
            {result.total} linked products · report from {new Date(result.ranAt).toLocaleString()}
          </p>

          {result.problems.length === 0 ? (
            <p className="text-body-md text-on-surface inline-flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-primary" />
              Everything aligned — all {result.total} products are at their expected price.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <h3 className="text-title-sm text-on-surface font-medium">Problems ({result.problems.length})</h3>
                {canEdit && fixable.length > 0 && (
                  <button
                    type="button"
                    onClick={fixAll}
                    disabled={fixing !== null}
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline-variant bg-surface text-label-lg font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40"
                  >
                    {fixing === 'all' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    Fix all — push {fixable.length}
                  </button>
                )}
              </div>
              <div className="overflow-x-auto rounded-xl border border-outline-variant">
                <table className="w-full text-body-sm">
                  <thead>
                    <tr className="bg-surface-container-low text-on-surface-variant text-label-md">
                      <th className="text-left px-4 py-2.5 font-medium">SKU</th>
                      <th className="text-right px-4 py-2.5 font-medium">On Wix</th>
                      <th className="text-right px-4 py-2.5 font-medium">Expected</th>
                      <th className="text-left px-4 py-2.5 font-medium">Source</th>
                      <th className="text-right px-4 py-2.5 font-medium">Δ</th>
                      {canEdit && <th className="px-4 py-2.5" />}
                    </tr>
                  </thead>
                  <tbody>
                    {result.problems.map((p) => (
                      <tr key={p.sku} className="border-t border-outline-variant/40 odd:bg-surface-container-low/30">
                        <td className="px-4 py-2">
                          <Link to={`/catalog/${p.sku}`} className="font-mono text-on-surface hover:text-primary hover:underline">{p.sku}</Link>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-on-surface">{p.live != null ? `$${Number(p.live).toFixed(2)}` : '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold text-on-surface">{p.expected != null ? `$${Number(p.expected).toFixed(2)}` : '—'}</td>
                        <td className="px-4 py-2">
                          {p.expected != null ? (
                            <span className={`px-2 py-0.5 rounded-full text-label-md font-medium ${p.source === 'promo' ? 'bg-tertiary-container/60 text-on-tertiary-container' : 'bg-surface-container text-on-surface-variant'}`}>
                              {p.source === 'promo' ? 'Promo' : 'MAP'}
                            </span>
                          ) : (
                            <span className="text-on-surface-variant">{STATUS_TEXT[p.status]}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-on-surface-variant">
                          {p.live != null && p.expected != null ? `${p.live > p.expected ? '+' : '−'}$${Math.abs(p.live - p.expected).toFixed(2)}` : '—'}
                        </td>
                        {canEdit && (
                          <td className="px-4 py-2 text-right">
                            {p.expected != null && (
                              <button
                                type="button"
                                onClick={() => fixOne(p)}
                                disabled={fixing !== null}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-label-md font-medium text-primary hover:bg-primary-container/50 transition-colors disabled:opacity-40"
                              >
                                {fixing === p.sku ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                                Push
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================== New promotion ==============================

function NewPromotionForm({ onClose, onCreated }) {
  const now = new Date();
  const defaultPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [name, setName] = useState('');
  const [month, setMonth] = useState(defaultPeriod);
  const [mode, setMode] = useState('file'); // 'file' | 'paste'
  const [currency, setCurrency] = useState('cad');
  const [text, setText] = useState('');
  // One file per market — memberships differ, so each market has its own
  // template and slot. Either alone is enough to create the promotion.
  const [files, setFiles] = useState({ ca: null, us: null }); // {rows, summary}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const parsed = useMemo(() => parsePriceList(text), [text]);

  async function handleFile(market, file) {
    setError(null);
    if (!file) { setFiles((f) => ({ ...f, [market]: null })); return; }
    try {
      const res = await parsePromoFile(file);
      const cols = res.matchedColumns.filter((c) => c !== 'sku').length;
      const summary = `${file.name} — ${res.rows.length} SKUs · ${cols} price column${cols === 1 ? '' : 's'}` +
        (res.unknownHeaders.length ? ` · ignored: ${res.unknownHeaders.join(', ')}` : '');
      setFiles((f) => ({ ...f, [market]: { rows: res.rows, summary } }));
    } catch (err) {
      setError(err.message);
    }
  }

  const mergedFileRows = useMemo(() => {
    const bySku = new Map();
    for (const part of [files.ca, files.us]) {
      for (const r of part?.rows ?? []) {
        const prev = bySku.get(r.sku);
        bySku.set(r.sku, {
          sku: r.sku,
          promo_price_cad: r.promo_price_cad ?? prev?.promo_price_cad ?? null,
          promo_price_usd: r.promo_price_usd ?? prev?.promo_price_usd ?? null,
          promo_costs: { ...(prev?.promo_costs ?? {}), ...(r.promo_costs ?? {}) },
        });
      }
    }
    return [...bySku.values()];
  }, [files]);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: name.trim() || `${monthLabel(month)} promotion`,
        period: `${month}-01`,
      };
      const res = mode === 'file'
        ? await createPromotionFromFile({ ...payload, rows: mergedFileRows })
        : await createPromotion({ ...payload, currency, rows: parsed.rows });
      if (res.notInPim.length) {
        setError(`Created — ${res.added} SKUs added. Not in the PIM (skipped): ${res.notInPim.join(', ')}`);
      }
      onCreated();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const canCreate = mode === 'file' ? mergedFileRows.length > 0 : parsed.rows.length > 0;

  return (
    <div className="rounded-2xl bg-surface p-6 space-y-4 border border-outline-variant">
      <div className="flex items-center justify-between">
        <h2 className="text-title-md text-on-surface font-semibold">New promotion</h2>
        <button type="button" onClick={onClose} className="p-1.5 rounded-full hover:bg-surface-container text-on-surface-variant">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="grid sm:grid-cols-3 gap-4">
        <label className="block">
          <span className="text-label-lg text-on-surface-variant">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${monthLabel(month)} promotion`}
            className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-container-low border border-outline-variant text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </label>
        <label className="block">
          <span className="text-label-lg text-on-surface-variant">Month</span>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-container-low border border-outline-variant text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </label>
        <div className="block">
          <span className="text-label-lg text-on-surface-variant">Source</span>
          <div className="mt-1 inline-flex w-full rounded-lg bg-surface-container p-1">
            {[['file', 'Upload file'], ['paste', 'Paste list']].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setMode(key)}
                className={`flex-1 px-3 py-1.5 rounded-md text-label-lg font-medium transition-colors ${
                  mode === key ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {mode === 'file' ? (
        <div className="grid sm:grid-cols-2 gap-4">
          {[['ca', 'Canada file', 'Promo MAP CAD + costs Rona/HD · Small Online · Wayfair CA'], ['us', 'USA file', 'Promo MAP USD + costs Lowes/SOD/BB&B · Wayfair US · Menards']].map(([market, title, hint]) => (
            <div key={market} className="rounded-xl border border-outline-variant p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-label-lg font-semibold text-on-surface">{title}</span>
                <button
                  type="button"
                  onClick={() => downloadPromoTemplate(market)}
                  className="text-label-md font-medium text-primary hover:underline"
                >
                  Download template
                </button>
              </div>
              <p className="text-body-sm text-on-surface-variant">{hint}. Each market has its own product list — upload one or both.</p>
              <label className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline-variant bg-surface text-label-lg font-medium text-on-surface hover:bg-surface-container-low transition-colors cursor-pointer">
                <Plus className="w-3.5 h-3.5" />
                Choose file (.xlsx / .csv)
                <input
                  type="file"
                  accept=".xlsx,.csv"
                  className="hidden"
                  onChange={(e) => handleFile(market, e.target.files?.[0])}
                />
              </label>
              {files[market]?.summary && (
                <p className="text-body-sm text-on-surface bg-surface-container rounded-lg px-3 py-2">{files[market].summary}</p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <>
          <label className="block">
            <span className="text-label-lg text-on-surface-variant">List currency</span>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="mt-1 w-full sm:w-64 px-3 py-2 rounded-lg bg-surface-container-low border border-outline-variant text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="cad">CAD (Canada / SinksDirect)</option>
              <option value="usd">USD (USA marketplaces)</option>
            </select>
          </label>
          <label className="block">
            <span className="text-label-lg text-on-surface-variant">
              Price list — one per line: <span className="font-mono">SKU&nbsp;&nbsp;price</span>
            </span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder={'S-822H\t379\nK-131NR\t289\n…'}
              className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-container-low border border-outline-variant font-mono text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>
        </>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-body-sm text-on-surface-variant">
          {mode === 'paste' && `${parsed.rows.length} price${parsed.rows.length === 1 ? '' : 's'} parsed${parsed.skipped.length > 0 ? ` · ${parsed.skipped.length} line${parsed.skipped.length === 1 ? '' : 's'} skipped` : ''}`}
        </p>
        <button
          type="button"
          disabled={busy || !canCreate}
          onClick={handleCreate}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-lg font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Create promotion
        </button>
      </div>
      {error && <p className="text-body-sm text-on-error-container bg-error-container/60 rounded-lg px-3 py-2">{error}</p>}
    </div>
  );
}

// ============================== Promotion card ==============================

function PromotionCard({ promo, canEdit, confirm, onChanged }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [mapBySku, setMapBySku] = useState(null);
  const [busy, setBusy] = useState(null); // 'apply' | 'push' | 'end' | 'delete'
  const [msg, setMsg] = useState(null);
  const [progress, setProgress] = useState(null);

  const meta = STATUS_META[promo.status] ?? STATUS_META.draft;

  useEffect(() => {
    if (!open || rows !== null) return;
    (async () => {
      try {
        const prices = await getPromotionPrices(promo.id);
        setRows(prices);
        const skus = prices.map((r) => r.sku);
        const maps = {};
        for (let i = 0; i < skus.length; i += 100) {
          const { data } = await supabase
            .from('products')
            .select('sku, map_cad, map_usd')
            .in('sku', skus.slice(i, i + 100));
          for (const p of data ?? []) maps[p.sku] = p;
        }
        setMapBySku(maps);
      } catch (err) {
        setMsg({ tone: 'error', text: err.message });
      }
    })();
  }, [open, rows, promo.id]);

  const [market, setMarket] = useState('ca');

  // A promo price below its own promo COST is a real anomaly (negative
  // margin) — below MAP is just what promotions are, so no alarm for that.
  const belowCost = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      const costs = r.promo_costs ?? {};
      return Object.entries(costs).some(([slug, cost]) => {
        const m = costMeta(slug);
        const price = m.market === 'ca' && m.unit === 'CAD' ? r.promo_price_cad
          : m.market === 'us' ? r.promo_price_usd : null;
        return price != null && cost != null && price < cost;
      });
    });
  }, [rows]);

  async function run(kind, fn, confirmOpts) {
    if (confirmOpts) {
      const ok = await confirm(confirmOpts);
      if (!ok) return;
    }
    setBusy(kind);
    setMsg(null);
    setProgress(null);
    try {
      const res = await fn();
      if (res?.text) setMsg({ tone: 'success', text: res.text });
      onChanged();
    } catch (err) {
      setMsg({ tone: 'error', text: err.message });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  return (
    <div className="rounded-2xl bg-surface overflow-hidden border border-transparent hover:border-outline-variant transition-colors">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-5 py-4 flex items-center justify-between gap-4 text-left"
      >
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-primary-container text-on-primary-container flex items-center justify-center flex-shrink-0">
            <Tag className="w-4 h-4" strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-body-md text-on-surface font-medium">{promo.name}</span>
              <span className={`px-2 py-0.5 rounded-full text-label-md font-semibold ${meta.class}`}>{meta.label}</span>
            </div>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              {monthLabel(promo.period)} · {promo.sku_count} SKU{promo.sku_count === 1 ? '' : 's'}
            </p>
          </div>
        </div>
        <ChevronDown className={`w-4 h-4 text-on-surface-variant transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          <div className="mx-0 border-t border-outline-variant/60" />

          {canEdit && (
            <div className="flex items-center gap-2 flex-wrap">
              {promo.status === 'draft' && (
                <>
                  <ActionButton
                    icon={Play}
                    label="Apply to store pricing"
                    busy={busy === 'apply'}
                    onClick={() => run('apply', async () => {
                      const r = await applyPromotion(promo);
                      return { text: `${r.applied} products set on sale in the PIM. Now push to Wix to publish.` };
                    }, {
                      title: `Apply "${promo.name}"?`,
                      message: 'Sets the CAD promo price as the sale price on every SKU in the list (in the PIM only — pushing to Wix is the next step).',
                      confirmLabel: 'Apply',
                    })}
                  />
                  <ActionButton
                    icon={CheckCircle2}
                    label="Mark as active"
                    busy={busy === 'activate'}
                    onClick={() => run('activate', async () => {
                      await markPromotionActive(promo);
                      return { text: 'Marked as active — store pricing untouched.' };
                    }, {
                      title: `Mark "${promo.name}" as active?`,
                      message: 'For promotions already live on the marketplaces: only changes the status here — no product pricing is touched.',
                      confirmLabel: 'Mark active',
                    })}
                  />
                </>
              )}
              {(promo.status === 'active' || promo.status === 'ended') && (
                <ActionButton
                  icon={Send}
                  label="Push to Wix"
                  busy={busy === 'push'}
                  onClick={() => run('push', async () => {
                    const r = await pushPromotionToWix(promo, setProgress);
                    return { text: `Pushed ${r.pushed}/${r.total} to Wix${r.notLinked ? ` · ${r.notLinked} not linked` : ''}${r.failures.length ? ` · ${r.failures.length} failed` : ''}` };
                  }, {
                    title: `Push to Wix?`,
                    message: `Pushes the current pricing of every linked SKU in this promotion to the live store.`,
                    confirmLabel: 'Push',
                  })}
                />
              )}
              {promo.status === 'active' && (
                <ActionButton
                  icon={Square}
                  label="End promotion"
                  busy={busy === 'end'}
                  onClick={() => run('end', async () => {
                    const r = await endPromotion(promo);
                    return { text: `${r.cleared} products back to regular price in the PIM. Push to Wix to publish.` };
                  }, {
                    title: `End "${promo.name}"?`,
                    message: 'Clears the sale price on every SKU in the list (in the PIM). Push to Wix afterwards to update the store.',
                    confirmLabel: 'End promotion',
                    danger: true,
                  })}
                />
              )}
              <ActionButton
                icon={Send}
                label="Wayfair promo file"
                busy={busy === 'wayfair'}
                onClick={async () => {
                  setBusy('wayfair');
                  setMsg(null);
                  try {
                    const r = await generateWayfairPromoFile(promo);
                    const parts = [`Wayfair file ready — ${r.filled} of ${r.templateRows} template rows filled`];
                    if (r.listedButMissing.length) {
                      parts.push(`⚠ listed on Wayfair but MISSING from the event file (ask Wayfair to include them): ${r.listedButMissing.join(', ')}`);
                    }
                    if (r.notOnWayfair.length) {
                      parts.push(`not listed on Wayfair (nothing to do): ${r.notOnWayfair.join(', ')}`);
                    }
                    setMsg({ tone: 'success', text: parts.join(' · ') });
                  } catch (err) {
                    setMsg({ tone: 'error', text: err.message });
                  } finally {
                    setBusy(null);
                  }
                }}
              />
              {promo.status !== 'ended' && (
                <label className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline-variant bg-surface text-label-lg font-medium text-on-surface hover:bg-surface-container-low transition-colors cursor-pointer ${busy === 'import' ? 'opacity-40 pointer-events-none' : ''}`}>
                  {busy === 'import' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" strokeWidth={2} />}
                  Import file
                  <input
                    type="file"
                    accept=".xlsx,.csv"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      setBusy('import');
                      setMsg(null);
                      try {
                        const { rows: parsedRows } = await parsePromoFile(file);
                        const r = await addFileToPromotion(promo, parsedRows);
                        setMsg({ tone: 'success', text: `Imported ${r.added} SKUs from ${file.name}${r.notInPim.length ? ` · not in PIM: ${r.notInPim.join(', ')}` : ''}` });
                        setRows(null);
                        setMapBySku(null);
                        onChanged();
                      } catch (err) {
                        setMsg({ tone: 'error', text: err.message });
                      } finally {
                        setBusy(null);
                      }
                    }}
                  />
                </label>
              )}
              {promo.status !== 'active' && (
                <ActionButton
                  icon={Trash2}
                  label="Delete"
                  busy={busy === 'delete'}
                  onClick={() => run('delete', async () => {
                    await deletePromotion(promo.id);
                    return { text: 'Promotion deleted.' };
                  }, {
                    title: `Delete "${promo.name}"?`,
                    message: 'Removes the promotion and its price list. Product pricing is not touched.',
                    confirmLabel: 'Delete',
                    danger: true,
                  })}
                />
              )}
            </div>
          )}

          {progress && (
            <p className="text-body-sm text-on-surface-variant">
              Pushing… {progress.done}/{progress.total}
            </p>
          )}
          {msg && (
            <p className={`text-body-sm rounded-lg px-3 py-2 inline-flex items-center gap-2 ${msg.tone === 'error' ? 'bg-error-container/60 text-on-error-container' : 'bg-surface-container text-on-surface-variant'}`}>
              {msg.tone === 'error' ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
              {msg.text}
            </p>
          )}

          {belowCost.length > 0 && (
            <p className="text-body-sm rounded-lg px-3 py-2 bg-error-container/40 text-on-error-container inline-flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              {belowCost.length} promo price{belowCost.length === 1 ? ' is' : 's are'} below its promo cost: {belowCost.slice(0, 6).map((r) => r.sku).join(', ')}{belowCost.length > 6 ? '…' : ''}
            </p>
          )}

          {rows === null ? (
            <p className="text-body-sm text-on-surface-variant"><Loader2 className="w-4 h-4 animate-spin inline mr-1.5 align-middle" />Loading prices…</p>
          ) : (() => {
            const costKeys = [...new Set(rows.flatMap((r) => Object.keys(r.promo_costs ?? {})))]
              .filter((k) => costMeta(k).market === market)
              .sort();
            const priceKey = market === 'ca' ? 'promo_price_cad' : 'promo_price_usd';
            const mapKey = market === 'ca' ? 'map_cad' : 'map_usd';
            const marketRows = rows.filter((r) => r[priceKey] != null || costKeys.some((k) => r.promo_costs?.[k] != null));
            return (
              <div className="space-y-3">
                <div className="inline-flex rounded-full bg-surface-container p-1">
                  {[['ca', 'Canada'], ['us', 'USA']].map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setMarket(key)}
                      className={`px-4 py-1.5 rounded-full text-label-lg font-medium transition-colors ${
                        market === key ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {marketRows.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-outline-variant px-6 py-8 text-center">
                    <p className="text-body-md text-on-surface font-medium">No {market === 'ca' ? 'Canadian' : 'US'} promo prices yet</p>
                    <p className="text-body-sm text-on-surface-variant mt-1">
                      Paste the {market === 'ca' ? 'CAD' : 'USD'} promo lists to add this market to the promotion.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-outline-variant">
                    <table className="w-full text-body-sm">
                      <thead>
                        <tr className="bg-surface-container-low text-on-surface-variant text-label-md">
                          <th className="text-left px-4 py-2.5 font-medium">SKU</th>
                          <th className="text-right px-4 py-2.5 font-medium whitespace-nowrap">Promo MAP</th>
                          <th className="text-right px-4 py-2.5 font-medium whitespace-nowrap">Regular MAP</th>
                          {costKeys.map((k) => {
                            const m = costMeta(k);
                            return (
                              <th key={k} className="text-right px-4 py-2.5 font-medium whitespace-nowrap">
                                Cost · {m.label}
                                {m.unit !== (market === 'ca' ? 'CAD' : 'USD') && (
                                  <span className="ml-1 text-on-surface-variant/70">({m.unit})</span>
                                )}
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {marketRows.map((r) => {
                          const p = mapBySku?.[r.sku];
                          return (
                            <tr key={r.id} className="border-t border-outline-variant/40 odd:bg-surface-container-low/30">
                              <td className="px-4 py-2 font-mono text-on-surface">{r.sku}</td>
                              <td className="px-4 py-2 text-right font-semibold text-on-surface tabular-nums">{fmt(r[priceKey])}</td>
                              <td className="px-4 py-2 text-right text-on-surface-variant tabular-nums">{fmt(p?.[mapKey])}</td>
                              {costKeys.map((k) => (
                                <td key={k} className="px-4 py-2 text-right text-on-surface-variant tabular-nums">
                                  {fmt(r.promo_costs?.[k])}
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function ActionButton({ icon: Icon, label, busy, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline-variant bg-surface text-label-lg font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40"
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" strokeWidth={2} />}
      {label}
    </button>
  );
}
