import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, Check, ChevronDown, Copy, RefreshCw, Search } from 'lucide-react';
import { usePimCompleteness } from '../hooks/usePimCompleteness';
import { CATEGORY_LABEL, GROUPS, summarizeByCategory, summarizeByCheck } from '@/features/products/lib/completeness';
import { BRANDS } from '@/features/products/lib/brands';
import { formatTimeAgo } from '@/lib/format';
import { categorizeScore } from '../lib/listingHealth';
import SCORE_BADGE_STYLES from '@/lib/scoreBadgeStyles';

const VIEWS = [['category', 'By category'], ['field', 'By field']];
const barTone = (pct) => (pct >= 90 ? 'bg-tertiary' : pct >= 60 ? 'bg-warning' : 'bg-error');
const matches = (q) => (p) => !q || p.sku.toLowerCase().includes(q) || (p.model_name ?? '').toLowerCase().includes(q);

// The PIM tab of Listing Health: how complete is the catalog's OWN data, by
// category or by field, live. No channel state here — only fields, images,
// documents. The brand filter (user request 2026-10-05) narrows everything
// on the tab, totals included.
export default function PimCompletenessPanel() {
  const { data, loading, error, reload } = usePimCompleteness();
  const [brand, setBrand] = useState('all');
  const [view, setView] = useState('category');
  const [openCat, setOpenCat] = useState(null);
  const [openField, setOpenField] = useState(null);
  const [search, setSearch] = useState('');
  const [onlyIncomplete, setOnlyIncomplete] = useState(true);
  const [expandedSku, setExpandedSku] = useState(null);

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => brand === 'all' || r.brand === brand), [data, brand]);
  const categories = useMemo(() => summarizeByCategory(rows), [rows]);
  const fields = useMemo(() => summarizeByCheck(rows), [rows]);
  const totals = useMemo(() => {
    const total = rows.length;
    const complete = rows.filter((r) => r.result.complete).length;
    return {
      total,
      complete,
      pct: total ? Math.round((complete / total) * 100) : 0,
      avg: total ? Math.round(rows.reduce((s, r) => s + r.result.score, 0) / total) : 0,
    };
  }, [rows]);

  const q = search.trim().toLowerCase();
  const cat = categories.find((c) => c.category === openCat) ?? null;
  const catProducts = useMemo(
    () => (cat ? cat.products.filter((p) => (!onlyIncomplete || !p.result.complete) && matches(q)(p)) : []),
    [cat, q, onlyIncomplete],
  );
  const field = fields.find((f) => f.key === openField) ?? null;
  const fieldProducts = useMemo(() => (field ? field.products.filter(matches(q)) : []), [field, q]);

  if (loading && !data) {
    return (
      <div role="status" aria-label="Computing PIM completeness" className="animate-pulse space-y-4">
        <div className="h-24 rounded-2xl bg-surface-container" />
        <div className="h-72 rounded-2xl bg-surface-container" />
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" className="rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
        <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
        {error.message}
      </div>
    );
  }
  if (!data) return null;

  const scope = brand === 'all' ? '' : `${brand} `;

  return (
    <div className="space-y-6">
      {/* Overview: same card language as the marketplace tabs */}
      <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-title-lg text-on-surface">PIM data completeness</h2>
            <p className="text-body-sm text-on-surface-variant mt-1">
              Live from the PIM, no channel state · updated {formatTimeAgo(data.computedAt)}
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Segmented
              label="Brand"
              value={brand}
              onChange={(b) => { setBrand(b); setExpandedSku(null); }}
              options={[['all', 'All brands'], ...BRANDS.map((b) => [b, b])]}
            />
            <button
              type="button"
              onClick={reload}
              disabled={loading}
              aria-busy={loading}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-60"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              Recalculate
            </button>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-6">
          <Stat label="At 100%" value={totals.complete} sub={`of ${totals.total} ${scope}products`} tone={totals.pct >= 90 ? 'good' : totals.pct >= 60 ? 'warn' : 'bad'} />
          <Stat label="Average completeness" value={`${totals.avg}%`} sub="across the fields that apply" />
          <Stat label="Catalog share" value={`${totals.pct}%`} sub={`${scope}products with nothing missing`} />
        </div>
        <div className="mt-5 h-2 rounded-full bg-surface-container-high overflow-hidden" role="img" aria-label={`${totals.pct}% of ${scope}products complete`}>
          <div className={`h-full rounded-full ${barTone(totals.pct)}`} style={{ width: `${totals.pct}%` }} />
        </div>
      </section>

      {/* Per-category or per-field table */}
      <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
        <header className="px-6 py-4 border-b border-outline-variant flex items-start justify-between gap-4 flex-wrap">
          {/* flex-1 + basis: the text wraps, so the switch stays put on the right */}
          <div className="flex-1 basis-80 min-w-0">
            <h3 className="text-title-md text-on-surface">{view === 'field' ? 'By field' : 'By category'}</h3>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              {view === 'field'
                ? 'Open a field to see every product missing it. A field counts as missing when it is empty or wrong (a bad or repeated UPC, a shipping weight under the product’s, millimetres that don’t match the inches).'
                : 'Open a category to see each product and what it is missing.'}
            </p>
          </div>
          <Segmented label="Group by" value={view} onChange={(v) => { setView(v); setExpandedSku(null); }} options={VIEWS} />
        </header>
        <div className="overflow-x-auto">
          {view === 'field' ? (
            <FieldTable fields={fields} openField={openField} onToggle={(key) => setOpenField(openField === key ? null : key)} />
          ) : (
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
                  <th className="text-left px-6 py-3 font-medium">Category</th>
                  <th className="text-right px-6 py-3 font-medium">Products</th>
                  <th className="text-right px-6 py-3 font-medium">At 100%</th>
                  <th className="px-6 py-3 font-medium text-left w-56">Complete</th>
                  <th className="text-right px-6 py-3 font-medium">Avg</th>
                  <th className="text-left px-6 py-3 font-medium">Most common gaps</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {categories.map((c) => {
                  const active = c.category === openCat;
                  return (
                    <tr
                      key={c.category}
                      onClick={() => { setOpenCat(active ? null : c.category); setExpandedSku(null); }}
                      className={`cursor-pointer transition-colors ${active ? 'bg-surface-container-low/60' : 'hover:bg-surface-container-low/40'}`}
                    >
                      <td className="px-6 py-3">
                        {/* A button so the row opens from the keyboard too (its click
                            reaches the row's onClick); plain look, no press sink. */}
                        <button type="button" aria-expanded={active} className="w-full flex items-center gap-2 text-left cursor-pointer active:scale-none!">
                          <ChevronDown className={`w-4 h-4 text-on-surface-variant flex-shrink-0 transition-transform ${active ? 'rotate-180' : ''}`} aria-hidden="true" />
                          <span className="text-body-md text-on-surface font-medium">{c.label}</span>
                        </button>
                      </td>
                      <td className="px-6 py-3 text-right text-body-md text-on-surface tabular-nums">{c.total}</td>
                      <td className="px-6 py-3 text-right text-body-md text-on-surface tabular-nums">{c.complete}</td>
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex-1 h-2 rounded-full bg-surface-container-high overflow-hidden">
                            <div className={`h-full rounded-full ${barTone(c.pct)}`} style={{ width: `${c.pct}%` }} />
                          </div>
                          <span className="text-label-md text-on-surface tabular-nums w-10 text-right">{c.pct}%</span>
                        </div>
                      </td>
                      <td className="px-6 py-3 text-right">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-label-md font-semibold ${SCORE_BADGE_STYLES[categorizeScore(c.avg)]}`}>{c.avg}</span>
                      </td>
                      <td className="px-6 py-3 text-body-sm text-on-surface-variant">
                        {c.gaps.length === 0 ? 'None' : c.gaps.slice(0, 3).map((g) => `${g.label} (${g.count})`).join(' · ')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Products missing the selected field */}
      {view === 'field' && field && (
        <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden animate-banner-in">
          <header className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h3 className="text-title-md text-on-surface">{field.label}</h3>
              <p className="text-body-sm text-on-surface-variant mt-0.5">
                {field.products.length} of {field.applies} {scope}products missing · {field.group} › {field.section}
                {fieldProducts.length !== field.products.length ? ` · ${fieldProducts.length} shown` : ''}
              </p>
            </div>
            {field.products.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <SearchBox value={search} onChange={setSearch} />
                <CopySkus skus={fieldProducts.map((p) => p.sku)} />
              </div>
            )}
          </header>
          {fieldProducts.length === 0 ? (
            <div className="px-6 py-12 text-center text-body-sm text-on-surface-variant">
              {field.products.length === 0
                ? <>Every {scope}product it applies to has it.</>
                : <>No product missing {field.label} matches "{search.trim()}".</>}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
                    <th className="text-left px-6 py-3 font-medium">Product</th>
                    <th className="text-left px-6 py-3 font-medium">Category</th>
                    <th className="text-left px-6 py-3 font-medium">Brand</th>
                    <th className="text-left px-6 py-3 font-medium">Issue</th>
                    <th className="px-6 py-3"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant">
                  {fieldProducts.map((p) => (
                    <tr key={p.sku}>
                      <td className="px-6 py-3">
                        <div className="text-body-md text-on-surface font-medium truncate max-w-md">{p.model_name || p.sku}</div>
                        <div className="text-body-sm text-on-surface-variant font-mono mt-0.5">{p.sku}</div>
                      </td>
                      <td className="px-6 py-3 text-body-md text-on-surface-variant">{CATEGORY_LABEL[p.category] ?? p.category ?? '—'}</td>
                      <td className="px-6 py-3 text-body-md text-on-surface-variant">{p.brand ?? '—'}</td>
                      <td className="px-6 py-3 text-body-sm">
                        {p.note ? <span className="text-on-surface">{p.note}</span> : <span className="text-on-surface-variant">Not filled in</span>}
                      </td>
                      <td className="px-6 py-3 text-right">
                        <Link to={`/catalog/${p.sku}?tab=${field.tab}`} title="Open product" aria-label={`Open ${p.sku}`} className="inline-flex items-center text-on-surface-variant hover:text-primary transition-colors">
                          <ArrowRight className="w-4 h-4" aria-hidden="true" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Products of the selected category */}
      {view === 'category' && cat && (
        <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden animate-banner-in">
          <header className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h3 className="text-title-md text-on-surface">{cat.label}</h3>
              <p className="text-body-sm text-on-surface-variant mt-0.5">{cat.complete} of {cat.total} at 100%{catProducts.length !== cat.total ? ` · ${catProducts.length} shown` : ''}</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <SearchBox value={search} onChange={setSearch} />
              <label className="inline-flex items-center gap-2 text-body-sm text-on-surface cursor-pointer">
                <input type="checkbox" checked={onlyIncomplete} onChange={(e) => setOnlyIncomplete(e.target.checked)} className="accent-primary" />
                Only incomplete
              </label>
            </div>
          </header>
          {catProducts.length === 0 ? (
            <div className="px-6 py-12 text-center text-body-sm text-on-surface-variant">
              {q ? (
                <>No product in {cat.label} matches "{search.trim()}"{onlyIncomplete ? ' among the incomplete ones' : ''}.</>
              ) : onlyIncomplete ? (
                <>
                  Every product in {cat.label} is at 100%.{' '}
                  <button type="button" onClick={() => setOnlyIncomplete(false)} className="text-primary font-semibold hover:underline">Show all {cat.total}</button>
                </>
              ) : (
                <>No products in {cat.label}.</>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
                    <th className="text-left px-6 py-3 font-medium">Product</th>
                    <th className="text-left px-6 py-3 font-medium">Brand</th>
                    <th className="text-right px-6 py-3 font-medium">Missing</th>
                    <th className="text-right px-6 py-3 font-medium">Score</th>
                    <th className="px-6 py-3"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant">
                  {catProducts.map((p) => {
                    const isOpen = expandedSku === p.sku;
                    return (
                      <Fragment key={p.sku}>
                        <tr
                          onClick={() => setExpandedSku(isOpen ? null : p.sku)}
                          className={`cursor-pointer transition-colors ${isOpen ? 'bg-surface-container-low/60' : 'hover:bg-surface-container-low/40'}`}
                        >
                          <td className="px-6 py-3">
                            <button type="button" aria-expanded={isOpen} className="w-full flex items-center gap-2 text-left cursor-pointer active:scale-none!">
                              <ChevronDown className={`w-4 h-4 text-on-surface-variant flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                              <div>
                                <div className="text-body-md text-on-surface font-medium truncate max-w-md">{p.model_name || p.sku}</div>
                                <div className="text-body-sm text-on-surface-variant font-mono mt-0.5">{p.sku}</div>
                              </div>
                            </button>
                          </td>
                          <td className="px-6 py-3 text-body-md text-on-surface-variant">{p.brand ?? '—'}</td>
                          <td className="px-6 py-3 text-right tabular-nums">
                            {p.result.missing.length > 0 ? <span className="text-error font-medium">{p.result.missing.length}</span> : <span className="text-on-surface-variant">—</span>}
                          </td>
                          <td className="px-6 py-3 text-right">
                            <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-label-md font-semibold ${SCORE_BADGE_STYLES[categorizeScore(p.result.score)]}`}>{p.result.score}</span>
                          </td>
                          <td className="px-6 py-3 text-right">
                            <Link to={`/catalog/${p.sku}`} onClick={(e) => e.stopPropagation()} title="Open product" aria-label={`Open ${p.sku}`} className="inline-flex items-center text-on-surface-variant hover:text-primary transition-colors">
                              <ArrowRight className="w-4 h-4" aria-hidden="true" />
                            </Link>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-surface-container-low/30">
                            <td colSpan={5} className="px-6 pb-4 pt-1">
                              <MissingBreakdown sku={p.sku} result={p.result} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// One row per check: how many products it applies to, how many miss it, and
// where it is filled in (product tab › section). Fields nobody misses wait
// behind a toggle so the gaps lead.
function FieldTable({ fields, openField, onToggle }) {
  const [showFull, setShowFull] = useState(false);
  const full = fields.filter((f) => f.products.length === 0).length;
  const shown = showFull ? fields : fields.filter((f) => f.products.length > 0 || f.key === openField);
  return (
    <>
    <table className="w-full min-w-[640px]">
      <thead>
        <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
          <th className="text-left px-6 py-3 font-medium">Field</th>
          <th className="text-left px-6 py-3 font-medium">Where</th>
          <th className="text-right px-6 py-3 font-medium">Applies to</th>
          <th className="text-right px-6 py-3 font-medium">Missing</th>
          <th className="px-6 py-3 font-medium text-left w-56">Filled</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-outline-variant">
        {shown.map((f) => {
          const active = f.key === openField;
          const gaps = f.products.length;
          return (
            <tr
              key={f.key}
              onClick={() => onToggle(f.key)}
              className={`cursor-pointer transition-colors ${active ? 'bg-surface-container-low/60' : 'hover:bg-surface-container-low/40'}`}
            >
              <td className="px-6 py-3">
                <button type="button" aria-expanded={active} className="w-full flex items-center gap-2 text-left cursor-pointer active:scale-none!">
                  <ChevronDown className={`w-4 h-4 text-on-surface-variant flex-shrink-0 transition-transform ${active ? 'rotate-180' : ''}`} aria-hidden="true" />
                  <span className={`text-body-md font-medium ${gaps ? 'text-on-surface' : 'text-on-surface-variant'}`}>{f.label}</span>
                </button>
              </td>
              <td className="px-6 py-3">
                <div className="text-body-md text-on-surface-variant">{f.group}</div>
                {f.section !== f.group && <div className="text-body-sm text-on-surface-variant">{f.section}</div>}
              </td>
              <td className="px-6 py-3 text-right text-body-md text-on-surface tabular-nums">{f.applies}</td>
              <td className="px-6 py-3 text-right tabular-nums">
                {gaps > 0 ? <span className="text-error font-medium">{gaps}</span> : <span className="text-on-surface-variant">—</span>}
              </td>
              <td className="px-6 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2 rounded-full bg-surface-container-high overflow-hidden">
                    <div className={`h-full rounded-full ${barTone(f.pct)}`} style={{ width: `${f.pct}%` }} />
                  </div>
                  <span className="text-label-md text-on-surface tabular-nums w-10 text-right">{f.pct}%</span>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    {full > 0 && (
      <div className="px-6 py-3 border-t border-outline-variant">
        <button type="button" aria-expanded={showFull} onClick={() => setShowFull((v) => !v)} className="text-body-sm text-primary font-semibold hover:underline">
          {showFull ? 'Hide the fields nothing is missing' : `Show the ${full} fields nothing is missing`}
        </button>
      </div>
    )}
    </>
  );
}

function Segmented({ label, value, onChange, options }) {
  return (
    <div className="inline-flex rounded-full bg-surface-container p-1" role="group" aria-label={label}>
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={`px-4 py-1.5 rounded-full text-label-md font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${value === key ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function SearchBox({ value, onChange }) {
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" aria-hidden="true" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search by SKU or name…"
        aria-label="Search products by SKU or name"
        className="pl-9 pr-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary w-64"
      />
    </div>
  );
}

// The SKUs on screen, one per line — ready to paste into a sheet or a message.
function CopySkus({ skus }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(skus.join('\n'));
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      disabled={skus.length === 0}
      className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-outline-variant text-body-sm text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-60"
    >
      {copied ? <Check className="w-4 h-4 text-tertiary" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
      {copied ? 'Copied' : `Copy ${skus.length} SKU${skus.length === 1 ? '' : 's'}`}
      {copied && <span role="status" className="sr-only">{skus.length} SKUs copied</span>}
    </button>
  );
}

function Stat({ label, value, sub, tone }) {
  const toneClass = tone === 'good' ? 'text-tertiary' : tone === 'warn' ? 'text-warning' : tone === 'bad' ? 'text-error' : 'text-on-surface';
  return (
    <div>
      <p className="text-label-md text-on-surface-variant uppercase tracking-wider">{label}</p>
      <p className={`text-headline-md font-semibold mt-1 tabular-nums ${toneClass}`}>{value}</p>
      {sub && <p className="text-body-sm text-on-surface-variant">{sub}</p>}
    </div>
  );
}

// Missing fields grouped by the product tab where they get filled in; a
// filled-but-wrong field says why.
function MissingBreakdown({ sku, result }) {
  if (result.missing.length === 0) {
    return <p className="text-body-sm text-on-surface animate-banner-in">All {result.passed.length} fields filled. Nothing to fix.</p>;
  }
  const groups = Object.keys(GROUPS)
    .sort((a, b) => GROUPS[a].order - GROUPS[b].order)
    .map((g) => ({ group: g, tab: GROUPS[g].tab, items: result.missing.filter((m) => m.group === g) }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="animate-banner-in flex flex-wrap gap-x-8 gap-y-3">
      {groups.map((g) => (
        <div key={g.group} className="min-w-[14rem]">
          <Link to={`/catalog/${sku}?tab=${g.tab}`} className="inline-flex items-center gap-1 text-label-md font-semibold uppercase tracking-wider text-primary hover:underline">
            {g.group} · {g.items.length}
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </Link>
          <ul className="mt-1.5 space-y-1">
            {g.items.map((m) => (
              <li key={m.key} className="text-body-sm text-on-surface flex items-start gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-error flex-shrink-0 mt-[0.45rem]" />
                <span>
                  {m.label}
                  {m.note && <span className="text-on-surface-variant"> — {m.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
