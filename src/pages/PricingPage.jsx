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
  deletePromotion,
  applyPromotion,
  endPromotion,
  pushPromotionToWix,
} from '@/features/pricing/api/promotions';

// Promotional dealer costs live in promo_costs keyed by channel-group slug.
// Known slugs get a friendly column header; unknown ones fall back to the slug.
const PROMO_COST_LABELS = {
  sod_cad: 'Promo Cost — Small Online (CAD)',
  rona_hd_cad: 'Promo Cost — Rona/HD (CAD)',
  wayfair_ca_usd: 'Promo Cost — Wayfair Canada (USD)',
  lowes_sod_bbb_usd: 'Promo Cost — Lowes/SOD/BB&B (USD)',
  wayfair_usd: 'Promo Cost — Wayfair US (USD)',
  menards_usd: 'Promo Cost — Menards (USD)',
};

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
  const [currency, setCurrency] = useState('cad');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const parsed = useMemo(() => parsePriceList(text), [text]);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const res = await createPromotion({
        name: name.trim() || `${monthLabel(month)} promotion`,
        period: `${month}-01`,
        currency,
        rows: parsed.rows,
      });
      if (res.notInPim.length) {
        setError(`Created — ${res.added} SKUs added. Not in the PIM (skipped): ${res.notInPim.join(', ')}`);
      }
      onCreated();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

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
        <label className="block">
          <span className="text-label-lg text-on-surface-variant">List currency</span>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-container-low border border-outline-variant text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="cad">CAD (Canada / SinksDirect)</option>
            <option value="usd">USD (USA marketplaces)</option>
          </select>
        </label>
      </div>
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
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-body-sm text-on-surface-variant">
          {parsed.rows.length} price{parsed.rows.length === 1 ? '' : 's'} parsed
          {parsed.skipped.length > 0 && ` · ${parsed.skipped.length} line${parsed.skipped.length === 1 ? '' : 's'} skipped`}
        </p>
        <button
          type="button"
          disabled={busy || parsed.rows.length === 0}
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

  const belowMap = useMemo(() => {
    if (!rows || !mapBySku) return [];
    return rows.filter((r) => {
      const p = mapBySku[r.sku];
      if (!p) return false;
      const cadBelow = r.promo_price_cad != null && p.map_cad != null && r.promo_price_cad < p.map_cad;
      const usdBelow = r.promo_price_usd != null && p.map_usd != null && r.promo_price_usd < p.map_usd;
      return cadBelow || usdBelow;
    });
  }, [rows, mapBySku]);

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

          {belowMap.length > 0 && (
            <p className="text-body-sm rounded-lg px-3 py-2 bg-error-container/40 text-on-error-container inline-flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              {belowMap.length} promo price{belowMap.length === 1 ? ' is' : 's are'} below MAP: {belowMap.slice(0, 6).map((r) => r.sku).join(', ')}{belowMap.length > 6 ? '…' : ''}
            </p>
          )}

          {rows === null ? (
            <p className="text-body-sm text-on-surface-variant"><Loader2 className="w-4 h-4 animate-spin inline mr-1.5 align-middle" />Loading prices…</p>
          ) : (() => {
            const costKeys = [...new Set(rows.flatMap((r) => Object.keys(r.promo_costs ?? {})))].sort();
            return (
              <div className="overflow-x-auto rounded-xl border border-outline-variant">
                <table className="w-full text-body-sm">
                  <thead>
                    <tr className="bg-surface-container-low text-on-surface-variant text-label-md">
                      <th className="text-left px-4 py-2 font-medium">SKU</th>
                      <th className="text-right px-4 py-2 font-medium">Promo CAD</th>
                      <th className="text-right px-4 py-2 font-medium">MAP CAD</th>
                      <th className="text-right px-4 py-2 font-medium">Promo USD</th>
                      <th className="text-right px-4 py-2 font-medium">MAP USD</th>
                      {costKeys.map((k) => (
                        <th key={k} className="text-right px-4 py-2 font-medium whitespace-nowrap">{PROMO_COST_LABELS[k] ?? k}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const p = mapBySku?.[r.sku];
                      const cadBelow = r.promo_price_cad != null && p?.map_cad != null && r.promo_price_cad < p.map_cad;
                      return (
                        <tr key={r.id} className="border-t border-outline-variant/50">
                          <td className="px-4 py-1.5 font-mono text-on-surface">{r.sku}</td>
                          <td className={`px-4 py-1.5 text-right ${cadBelow ? 'text-error font-semibold' : 'text-on-surface'}`}>
                            {r.promo_price_cad != null ? `$${r.promo_price_cad}` : '—'}
                          </td>
                          <td className="px-4 py-1.5 text-right text-on-surface-variant">{p?.map_cad != null ? `$${p.map_cad}` : '—'}</td>
                          <td className="px-4 py-1.5 text-right text-on-surface">{r.promo_price_usd != null ? `$${r.promo_price_usd}` : '—'}</td>
                          <td className="px-4 py-1.5 text-right text-on-surface-variant">{p?.map_usd != null ? `$${p.map_usd}` : '—'}</td>
                          {costKeys.map((k) => (
                            <td key={k} className="px-4 py-1.5 text-right text-on-surface">
                              {r.promo_costs?.[k] != null ? `$${r.promo_costs[k]}` : '—'}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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
