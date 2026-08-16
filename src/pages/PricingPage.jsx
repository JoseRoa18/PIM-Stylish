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
// Icon DATA (vanilla lucide) for MorphIcon — it animates the strokes between
// the two shapes instead of swapping elements.
import { MorphIcon } from 'morphicons/react';
import { Copy, Check } from 'lucide';
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
import { downloadPromoTemplate, downloadPromoMarketData, parsePromoFile, MARKET_FIELDS } from '@/features/pricing/lib/promoImport';
import Dialog from '@/components/ui/Dialog';
import FileDropzone from '@/components/ui/FileDropzone';
import { runPriceAlignment, loadLatestAlignment, pushExpectedPrice, fixAlignment, ALIGN_TARGETS, ALIGN_TARGET_KEYS } from '@/features/pricing/api/priceAlignment';
import { DEFAULT_WIX_SITE } from '@/features/syndication/lib/wixSites';
import { fillWayfairPromoFile } from '@/features/pricing/lib/wayfairPromoFill';
import { fillBBBPromoFile } from '@/features/pricing/lib/bbbPromoFill';
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

// Tiles per site: SinksDirect sites are promo-aware (5 buckets), Stylish
// brand sites compare only the base price against MSRP (3 buckets — their
// own storefront sales are not drift).
function alignTiles(cfg) {
  const priceName = cfg.priceField.startsWith('map') ? 'MAP' : 'MSRP';
  return [
    ...(cfg.promoAware ? [{ key: 'promo_ok', label: 'At promo price', tone: 'ok' }] : []),
    { key: 'map_ok', label: `At regular ${priceName}`, tone: 'ok' },
    ...(cfg.promoAware ? [{ key: 'promo_missing', label: 'Missing promo price', tone: 'warn' }] : []),
    { key: 'misaligned', label: 'Misaligned', tone: 'error' },
    { key: 'no_map', label: `No ${priceName} in PIM`, tone: 'muted' },
  ];
}

const STATUS_TEXT = {
  promo_missing: 'still at the regular price',
  misaligned: 'unexpected price',
  no_map: 'no price in the PIM',
  missing: 'product missing on Wix',
};

// ---- Alignment overview (the % chart) ----
// Status segments in a fixed order; every segment is also named in the
// legend and in the row tooltip, so identity never rides on color alone.
// Colors alternate lightness (dark-light-dark-light in BOTH themes) so
// adjacent segments stay separable under color-vision deficiency —
// validated with the palette checker, worst adjacent ΔE ≈ 38.
const OVERVIEW_SEGMENTS = [
  { key: 'aligned', label: 'Aligned', cls: 'bg-success', of: (c) => (c.promo_ok ?? 0) + (c.map_ok ?? 0) },
  { key: 'promo_missing', label: 'Promo missing', cls: 'bg-warning-container', of: (c) => c.promo_missing ?? 0 },
  { key: 'misaligned', label: 'Misaligned / broken', cls: 'bg-error', of: (c) => (c.misaligned ?? 0) + (c.missing ?? 0) },
  { key: 'no_map', label: 'No price in PIM', cls: 'bg-outline-variant', of: (c) => c.no_map ?? 0 },
];

function AlignmentOverview({ overview, site, onSelect }) {
  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-3">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <h3 className="text-label-lg font-medium text-on-surface">Alignment by channel</h3>
        <div className="flex items-center gap-3 flex-wrap">
          {OVERVIEW_SEGMENTS.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5 text-label-md text-on-surface-variant">
              <span className={`w-2 h-2 rounded-full border border-outline-variant/60 ${s.cls}`} />
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        {ALIGN_TARGET_KEYS.map((key) => {
          const t = ALIGN_TARGETS[key];
          const report = overview?.[key];
          const counts = report && !report.legacy ? report.counts : null;
          const parts = counts ? OVERVIEW_SEGMENTS.map((s) => ({ ...s, n: s.of(counts) })) : [];
          const total = parts.reduce((a, p) => a + p.n, 0);
          // % over what's comparable — a SKU with no price in the PIM says
          // nothing about the channel being right or wrong.
          const comparable = total - (counts?.no_map ?? 0);
          const aligned = parts.find((p) => p.key === 'aligned')?.n ?? 0;
          const pct = comparable > 0 ? Math.round((aligned / comparable) * 100) : null;
          const tooltip = counts
            ? `${t.label} — ${parts.filter((p) => p.n > 0).map((p) => `${p.label}: ${p.n}`).join(' · ')}`
            : `${t.label} — no saved report yet`;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(key)}
              aria-pressed={site === key}
              title={tooltip}
              className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left transition-colors ${
                site === key ? 'bg-primary-container/25' : 'hover:bg-surface-container-low'
              }`}
            >
              <span className={`w-40 flex-shrink-0 truncate text-label-lg ${site === key ? 'text-on-surface font-semibold' : 'text-on-surface'}`}>
                {t.short}
                <span className="block text-label-md text-on-surface-variant font-normal">{t.priceShort}</span>
              </span>
              <span className="flex-1 flex h-2.5 rounded-full overflow-hidden bg-surface-container gap-[2px]" aria-hidden>
                {total > 0
                  ? parts.filter((p) => p.n > 0).map((p) => (
                      <span key={p.key} className={`${p.cls} h-full`} style={{ width: `${(p.n / total) * 100}%` }} />
                    ))
                  : <span className="h-full w-full bg-surface-container" />}
              </span>
              <span className="w-24 flex-shrink-0 text-right tabular-nums text-label-lg text-on-surface">
                {pct != null ? `${pct}%` : '—'}
                <span className="block text-label-md text-on-surface-variant font-normal">
                  {counts ? `${aligned}/${comparable}` : 'no report'}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PriceAlignmentCard({ canEdit, confirm }) {
  const [site, setSite] = useState(DEFAULT_WIX_SITE);
  const cfg = ALIGN_TARGETS[site];
  const money = (v) => `${cfg.symbol}${Number(v).toFixed(2)}`;
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [fixing, setFixing] = useState(null); // sku | 'all'
  const [progress, setProgress] = useState(null);
  const [msg, setMsg] = useState(null);
  // Latest report of EVERY channel, for the alignment overview bars.
  const [overview, setOverview] = useState(null);

  useEffect(() => {
    let active = true;
    Promise.all(ALIGN_TARGET_KEYS.map((k) => loadLatestAlignment(k).catch(() => null)))
      .then((reports) => {
        if (!active) return;
        setOverview(Object.fromEntries(ALIGN_TARGET_KEYS.map((k, i) => [k, reports[i]])));
      });
    return () => { active = false; };
  }, []);

  // The last saved report for the site (cron or manual run) shows instantly.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setResult(null);
    setMsg(null);
    loadLatestAlignment(site)
      .then((r) => { if (active) setResult(r); })
      .catch((err) => { if (active) setMsg({ tone: 'error', text: err.message }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [site]);

  async function analyze() {
    setRunning(true);
    setMsg(null);
    try {
      const fresh = await runPriceAlignment(site);
      setResult(fresh);
      setOverview((prev) => (prev ? { ...prev, [site]: fresh } : prev));
    } catch (err) {
      setMsg({ tone: 'error', text: err.message });
    } finally {
      setRunning(false);
    }
  }

  const fixable = cfg.canFix ? (result?.problems.filter((p) => p.expected != null) ?? []) : [];

  // Wix's query index (what the analysis reads) lags writes by ~15-30s —
  // re-running immediately would show the just-fixed rows as still broken.
  async function reanalyzeAfterIndexLag(prefix) {
    setMsg({ tone: 'success', text: `${prefix} Waiting ~20s for Wix's index before re-checking…` });
    await new Promise((resolve) => setTimeout(resolve, 20000));
    await analyze();
    setMsg({ tone: 'success', text: `${prefix} Analysis refreshed.` });
  }

  async function fixOne(problem) {
    const isBBPromo = cfg.kind === 'bestbuy' && problem.source === 'promo';
    const ok = await confirm({
      title: `Push ${money(problem.expected)} to ${cfg.label} for ${problem.sku}?`,
      message: isBBPromo
        ? `Keeps the offer's regular price at MAP and schedules the promo discount of ${money(problem.expected)} for the promo month (currently selling at ${money(problem.live)}). Nothing else on the offer is touched.`
        : `Updates ONLY the price on the live store (currently ${money(problem.live)}). Nothing else on the listing is touched.`,
      confirmLabel: 'Push price',
    });
    if (!ok) return;
    setFixing(problem.sku);
    setMsg(null);
    try {
      await pushExpectedPrice(problem.sku, problem.expected, site, problem);
      await reanalyzeAfterIndexLag(`${problem.sku} → ${money(problem.expected)} pushed.`);
    } catch (err) {
      setMsg({ tone: 'error', text: err.message });
    } finally {
      setFixing(null);
    }
  }

  async function fixAll() {
    const list = fixable.map((p) => `${p.sku}: ${money(p.live)} → ${money(p.expected)}${cfg.kind === 'bestbuy' && p.source === 'promo' ? ' (scheduled promo discount)' : ''}`).join('\n');
    const ok = await confirm({
      title: `Push ${fixable.length} corrected price${fixable.length === 1 ? '' : 's'} to ${cfg.label}?`,
      message: `Only prices are updated — nothing else on the listings.${cfg.kind === 'bestbuy' ? ' Promo members are pushed as a scheduled discount for the promo month (the regular price stays at MAP), so the promo ends on its own.' : ''}\n\n${list}`,
      confirmLabel: `Push ${fixable.length}`,
    });
    if (!ok) return;
    setFixing('all');
    setMsg(null);
    setProgress(null);
    try {
      const r = await fixAlignment(fixable, setProgress, site);
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
      {/* Alignment overview — one 100%-stacked status bar per channel; the
          rows double as the channel selector. */}
      <AlignmentOverview overview={overview} site={site} onSelect={setSite} />

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-title-md text-on-surface font-semibold">Price Alignment — {cfg.label}</h2>
          <p className="text-body-sm text-on-surface-variant mt-0.5">
            {cfg.kind === 'bestbuy'
              ? `Compares every Best Buy offer against its expected price — the active promo price
                 for promo members, the regular ${cfg.priceShort} for everyone else. Fixes update ONLY
                 prices: stale MAPs correct the offer price, missing promos become a scheduled
                 discount for the promo month.`
              : cfg.kind === 'walmart'
                ? `Compares every Walmart item against its expected price — the active promo price
                   for promo members, the regular ${cfg.priceShort} for everyone else. Analysis only:
                   the Walmart connection is read-only, so corrections go through Seller Center.`
                : cfg.promoAware
                ? `Compares every linked product's live store price against its expected price —
                   the active promo price for promo members, the regular ${cfg.priceShort} for everyone else.`
                : `Compares every linked product's base price against its ${cfg.priceShort} — this store
                   runs its own storefront sales, so percent-off discounts are not counted as drift.`}
            {' '}Reports save automatically twice a day; run a fresh one anytime.
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
          <div className={`grid grid-cols-2 gap-3 ${cfg.promoAware ? 'sm:grid-cols-5' : 'sm:grid-cols-3'}`}>
            {alignTiles(cfg).map((t) => {
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
              {/* Inner scroll + sticky header (bg on each th — that's the
                  element that sticks). data-lenis-prevent per the AppShell
                  Lenis gotcha. */}
              <div className="overflow-auto max-h-[65vh] rounded-xl border border-outline-variant" data-lenis-prevent>
                <table className="w-full text-body-sm">
                  <thead>
                    <tr className="text-on-surface-variant text-label-md">
                      <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-left px-4 py-2.5 font-medium">SKU</th>
                      <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-right px-4 py-2.5 font-medium">On {cfg.short}</th>
                      <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-right px-4 py-2.5 font-medium">Expected</th>
                      <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-left px-4 py-2.5 font-medium">Source</th>
                      <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-right px-4 py-2.5 font-medium">Δ</th>
                      {canEdit && <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant px-4 py-2.5" />}
                    </tr>
                  </thead>
                  <tbody>
                    {result.problems.map((p) => (
                      <tr key={p.sku} className="border-t border-outline-variant/40 odd:bg-surface-container-low/30">
                        <td className="px-4 py-2">
                          <Link to={`/catalog/${p.sku}`} className="font-mono text-on-surface hover:text-primary hover:underline">{p.sku}</Link>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-on-surface">{p.live != null ? money(p.live) : '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold text-on-surface">{p.expected != null ? money(p.expected) : '—'}</td>
                        <td className="px-4 py-2">
                          {p.expected != null ? (
                            <span className={`px-2 py-0.5 rounded-full text-label-md font-medium ${p.source === 'promo' ? 'bg-tertiary-container/60 text-on-tertiary-container' : 'bg-surface-container text-on-surface-variant'}`}>
                              {p.source === 'promo' ? 'Promo' : (cfg.priceField.startsWith('map') ? 'MAP' : 'MSRP')}
                            </span>
                          ) : (
                            <span className="text-on-surface-variant">{STATUS_TEXT[p.status]}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-on-surface-variant">
                          {p.live != null && p.expected != null ? `${p.live > p.expected ? '+' : '−'}${money(Math.abs(p.live - p.expected))}` : '—'}
                        </td>
                        {canEdit && (
                          <td className="px-4 py-2 text-right">
                            {cfg.canFix && p.expected != null && (
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
  const [importModal, setImportModal] = useState(false);
  const [fillModal, setFillModal] = useState(false);

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
                label="Fill marketplace file"
                busy={busy === 'fill'}
                onClick={() => setFillModal(true)}
              />
              {promo.status !== 'ended' && (
                <ActionButton
                  icon={Plus}
                  label="Import file"
                  busy={busy === 'import'}
                  onClick={() => setImportModal(true)}
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

          {fillModal && (
            <FillMarketplaceFileDialog
              promo={promo}
              onClose={() => setFillModal(false)}
              onDone={(m) => { setFillModal(false); setMsg(m); }}
            />
          )}

          {importModal && (
            <ImportPromoDialog
              promo={promo}
              rows={rows}
              onClose={() => setImportModal(false)}
              onImported={(text) => {
                setImportModal(false);
                setMsg({ tone: 'success', text });
                setRows(null);
                setMapBySku(null);
                onChanged();
              }}
            />
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
                <div className="flex items-center justify-between gap-3 flex-wrap">
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
                  {/* Marketplace portals (BB&B/Overstock…) ask for the promo's
                      part numbers to hand back their promo file — one click
                      instead of picking SKUs out of the table by hand. */}
                  {marketRows.length > 0 && (
                    <CopySkusButton skus={marketRows.map((r) => r.sku)} />
                  )}
                </div>

                {marketRows.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-outline-variant px-6 py-8 text-center">
                    <p className="text-body-md text-on-surface font-medium">No {market === 'ca' ? 'Canadian' : 'US'} promo prices yet</p>
                    <p className="text-body-sm text-on-surface-variant mt-1">
                      Paste the {market === 'ca' ? 'CAD' : 'USD'} promo lists to add this market to the promotion.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-auto max-h-[65vh] rounded-xl border border-outline-variant" data-lenis-prevent>
                    {/* The list scrolls INSIDE the card (data-lenis-prevent —
                        see the AppShell Lenis gotcha) so the header can stay
                        sticky; the background lives on each th because that's
                        the element that actually sticks. */}
                    <table className="w-full text-body-sm">
                      <thead>
                        <tr className="text-on-surface-variant text-label-md">
                          <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-left px-4 py-2.5 font-medium">SKU</th>
                          <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-right px-4 py-2.5 font-medium whitespace-nowrap">Promo MAP</th>
                          <th className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-right px-4 py-2.5 font-medium whitespace-nowrap">Regular MAP</th>
                          {costKeys.map((k) => {
                            const m = costMeta(k);
                            return (
                              <th key={k} className="sticky top-0 z-10 bg-surface-container-low border-b border-outline-variant text-right px-4 py-2.5 font-medium whitespace-nowrap">
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

// One-click copy of a market's promo member SKUs (newline-separated — what
// marketplace portals expect when pasting part numbers into a list box).
function CopySkusButton({ skus }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(skus.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked outside secure contexts; fall back to a
      // prompt the user can copy from manually.
      window.prompt('Copy the SKUs below:', skus.join(' '));
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors"
      title="Copy this market's promo SKUs, one per line"
    >
      <MorphIcon
        icon={copied ? Check : Copy}
        size={14}
        reducedMotion="user"
        className={copied ? 'text-success' : ''}
      />
      {copied ? `Copied ${skus.length} SKUs` : `Copy SKUs (${skus.length})`}
    </button>
  );
}

// ============================== Fill marketplace file ==============================

// Every marketplace whose promo submission is a FILE downloaded from its own
// portal and filled by the PIM. One entry per marketplace: the filler does
// the matching, the summary turns its report into the card message.
const FILE_FILLERS = {
  wayfair: {
    label: 'Wayfair',
    monogram: 'WA',
    monogramCls: 'bg-brand-wayfair/15 text-brand-wayfair',
    hint: 'Partner Home promotions file — existing rows are filled, missing promo members are appended (only those Wayfair actually lists).',
    accept: '.xlsx,.xlsm',
    fill: fillWayfairPromoFile,
    summarize: (r) => {
      const parts = [`Wayfair file ready — ${r.filled} existing rows filled`];
      if (r.appended.length) parts.push(`${r.appended.length} rows added (${r.appended.slice(0, 8).join(', ')}${r.appended.length > 8 ? '…' : ''})`);
      if (r.notOnWayfair.length) parts.push(`skipped, not listed on Wayfair: ${r.notOnWayfair.join(', ')}`);
      return parts.join(' · ');
    },
  },
  bbb: {
    label: 'BB&B / Overstock',
    monogram: 'BO',
    monogramCls: 'bg-surface-container-high text-on-surface-variant',
    hint: 'Portal promo file, CSV (use Copy SKUs first to request it) — PROMO_MAP and PROMO_COST are filled on matching part numbers; rows are never added.',
    accept: '.csv,.xlsx,.xlsm',
    fill: fillBBBPromoFile,
    summarize: (r) => {
      const parts = [`BB&B / Overstock file ready — ${r.filled} of ${r.fileRows} rows filled`];
      if (r.notInFile.length) parts.push(`promo members not in the file: ${r.notInFile.slice(0, 8).join(', ')}${r.notInFile.length > 8 ? '…' : ''}`);
      if (r.notInPromo.length) parts.push(`file rows not in this promo: ${r.notInPromo.slice(0, 8).join(', ')}${r.notInPromo.length > 8 ? '…' : ''}`);
      if (r.missingData.length) parts.push(`skipped, incomplete promo data: ${r.missingData.join(', ')}`);
      if (r.mapViolations.length) parts.push(`⚠ promo MAP not 1% below site price: ${r.mapViolations.join(', ')}`);
      return parts.join(' · ');
    },
  },
};

function FillMarketplaceFileDialog({ promo, onClose, onDone }) {
  const [marketplace, setMarketplace] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const def = marketplace ? FILE_FILLERS[marketplace] : null;

  async function handleUpload(file) {
    if (!file || !def) return;
    setBusy(true);
    setError(null);
    try {
      const r = await def.fill(file, promo);
      onDone({ tone: 'success', text: def.summarize(r) });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      onClose={onClose}
      title="Fill marketplace file"
      subtitle="Upload the file downloaded from the marketplace's portal — the PIM fills the promo columns and hands it back."
      maxWidth="max-w-lg"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {Object.entries(FILE_FILLERS).map(([key, f]) => (
            <button
              key={key}
              type="button"
              onClick={() => { setMarketplace(key); setError(null); }}
              aria-pressed={marketplace === key}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                marketplace === key
                  ? 'border-primary bg-primary-container/25'
                  : 'border-outline-variant bg-surface hover:bg-surface-container-low'
              }`}
            >
              <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-label-lg font-bold flex-shrink-0 ${f.monogramCls}`}>
                {f.monogram}
              </span>
              <span className="text-label-lg font-medium text-on-surface">{f.label}</span>
            </button>
          ))}
        </div>

        {def && (
          <>
            <p className="text-body-sm text-on-surface-variant">{def.hint}</p>
            <FileDropzone
              onFile={handleUpload}
              accept={def.accept}
              disabled={busy}
              className="flex items-center justify-center gap-2 px-4 py-6 rounded-xl border-2 border-dashed border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {busy ? 'Filling…' : `Drop the ${def.label} file here — or click to browse`}
            </FileDropzone>
          </>
        )}

        {error && (
          <p className="text-body-sm rounded-lg px-3 py-2 bg-error-container/60 text-on-error-container">{error}</p>
        )}
      </div>
    </Dialog>
  );
}

// ============================== Import dialog ==============================

// Guided import: pick the market first; if that market already has data in
// the promotion, the download is the CURRENT data (update path); otherwise
// it's the blank template (new upload path). Then upload the filled file.
function ImportPromoDialog({ promo, rows, onClose, onImported }) {
  const [market, setMarket] = useState(null); // null | 'ca' | 'us'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const marketCount = (m) => {
    const priceField = m === 'us' ? 'promo_price_usd' : 'promo_price_cad';
    return (rows ?? []).filter((r) =>
      r[priceField] != null ||
      MARKET_FIELDS[m].some((f) => f.startsWith('cost:') && r.promo_costs?.[f.slice(5)] != null),
    ).length;
  };
  const counts = { ca: marketCount('ca'), us: marketCount('us') };
  const loaded = market ? counts[market] > 0 : false;
  const marketLabel = market === 'us' ? 'USA' : 'Canada';

  async function handleUpload(file) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = await parsePromoFile(file);
      const marketCols = parsed.matchedColumns.filter((c) => MARKET_FIELDS[market].includes(c));
      if (!marketCols.length) {
        const other = market === 'us' ? 'Canada' : 'USA';
        throw new Error(`This file has no ${marketLabel} price columns — it looks like a ${other} file. Download the ${marketLabel} template from this dialog.`);
      }
      const r = await addFileToPromotion(promo, parsed.rows);
      onImported(
        `${marketLabel}: imported ${r.added} SKUs from ${file.name}` +
        (r.notInPim.length ? ` · not in PIM: ${r.notInPim.join(', ')}` : ''),
      );
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      onClose={onClose}
      title="Import promotion file"
      subtitle={promo.name}
      maxWidth="max-w-lg"
    >
      <div className="space-y-4">
        <div>
          <p className="text-label-lg text-on-surface-variant mb-2">Which market?</p>
          <div className="grid grid-cols-2 gap-3">
            {[['ca', 'Canada'], ['us', 'USA']].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => { setMarket(key); setError(null); }}
                className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                  market === key
                    ? 'border-primary bg-primary-container/40'
                    : 'border-outline-variant bg-surface hover:bg-surface-container-low'
                }`}
              >
                <div className="text-body-md font-semibold text-on-surface">{label}</div>
                <div className="text-body-sm text-on-surface-variant mt-0.5">
                  {counts[key] > 0 ? `${counts[key]} SKUs loaded` : 'Not loaded yet'}
                </div>
              </button>
            ))}
          </div>
        </div>

        {market && (
          <div className="rounded-xl bg-surface-container-low/60 p-4 space-y-3">
            {loaded ? (
              <p className="text-body-sm text-on-surface-variant">
                <span className="font-semibold text-on-surface">{marketLabel} is already loaded</span> ({counts[market]} SKUs).
                Download the current data, edit it, and upload it back to update.
              </p>
            ) : (
              <p className="text-body-sm text-on-surface-variant">
                <span className="font-semibold text-on-surface">{marketLabel} isn't loaded yet.</span>{' '}
                Download the blank template, fill it, and upload it here.
              </p>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => (loaded ? downloadPromoMarketData(promo, rows ?? [], market) : downloadPromoTemplate(market))}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline-variant bg-surface text-label-lg font-medium text-on-surface hover:bg-surface-container transition-colors"
              >
                {loaded ? 'Download current data' : 'Download blank template'}
              </button>
              <FileDropzone
                onFile={handleUpload}
                accept=".xlsx,.csv"
                disabled={busy}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full bg-primary text-on-primary text-label-lg font-semibold hover:opacity-90 transition-opacity"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {loaded ? 'Upload updated file' : 'Upload filled file'}
              </FileDropzone>
            </div>
          </div>
        )}

        {error && (
          <p className="text-body-sm rounded-lg px-3 py-2 bg-error-container/60 text-on-error-container">{error}</p>
        )}
      </div>
    </Dialog>
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
