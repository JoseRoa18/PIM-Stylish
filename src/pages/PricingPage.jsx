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
  markPromotionActive,
  deletePromotion,
  applyPromotion,
  endPromotion,
  pushPromotionToWix,
} from '@/features/pricing/api/promotions';
import { downloadPromoTemplate, parsePromoFile } from '@/features/pricing/lib/promoImport';

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
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-headline-md text-on-surface font-semibold">Pricing</h1>
          <p className="text-body-md text-on-surface-variant mt-1">
            Monthly promotions for all marketplaces. Promo prices come from the official
            lists — paste them per month; marketplace promo templates will generate from here.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => setShowNew((v) => !v)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-primary text-on-primary text-label-lg font-semibold hover:opacity-90 transition-opacity"
          >
            <Plus className="w-4 h-4" />
            New promotion
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-xl bg-error-container/60 text-on-error-container px-4 py-3 text-body-sm">
          {error}
        </div>
      )}

      {showNew && (
        <NewPromotionForm
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); reload(); }}
        />
      )}

      {promotions === null ? (
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

// ============================== New promotion ==============================

function NewPromotionForm({ onClose, onCreated }) {
  const now = new Date();
  const defaultPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [name, setName] = useState('');
  const [month, setMonth] = useState(defaultPeriod);
  const [mode, setMode] = useState('file'); // 'file' | 'paste'
  const [currency, setCurrency] = useState('cad');
  const [text, setText] = useState('');
  const [fileRows, setFileRows] = useState(null);
  const [fileSummary, setFileSummary] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const parsed = useMemo(() => parsePriceList(text), [text]);

  async function handleFile(file) {
    setError(null);
    setFileRows(null);
    setFileSummary(null);
    if (!file) return;
    try {
      const res = await parsePromoFile(file);
      setFileRows(res.rows);
      const cols = res.matchedColumns.filter((c) => c !== 'sku').length;
      setFileSummary(
        `${res.rows.length} SKUs · ${cols} price column${cols === 1 ? '' : 's'} detected` +
        (res.unknownHeaders.length ? ` · ignored columns: ${res.unknownHeaders.join(', ')}` : ''),
      );
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: name.trim() || `${monthLabel(month)} promotion`,
        period: `${month}-01`,
      };
      const res = mode === 'file'
        ? await createPromotionFromFile({ ...payload, rows: fileRows ?? [] })
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

  const canCreate = mode === 'file' ? (fileRows?.length ?? 0) > 0 : parsed.rows.length > 0;

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
        <div className="space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline-variant bg-surface text-label-lg font-medium text-on-surface hover:bg-surface-container-low transition-colors cursor-pointer">
              <Plus className="w-3.5 h-3.5" />
              Choose file (.xlsx / .csv)
              <input
                type="file"
                accept=".xlsx,.csv"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
            </label>
            <button
              type="button"
              onClick={downloadPromoTemplate}
              className="text-label-lg font-medium text-primary hover:underline"
            >
              Download template
            </button>
          </div>
          <p className="text-body-sm text-on-surface-variant">
            One file with every promo column — SKU, Promo MAP CAD/USD, and the promo costs
            per channel. Leave blank the cells that don't apply.
          </p>
          {fileSummary && <p className="text-body-sm text-on-surface bg-surface-container rounded-lg px-3 py-2">{fileSummary}</p>}
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
