import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, ChevronDown, RefreshCw, Search } from 'lucide-react';
import { usePimCompleteness } from '../hooks/usePimCompleteness';
import { GROUPS } from '@/features/products/lib/completeness';
import { formatTimeAgo } from '@/lib/format';
import { categorizeScore } from '../lib/listingHealth';
import SCORE_BADGE_STYLES from '@/lib/scoreBadgeStyles';

// The PIM tab of Listing Health: how complete is the catalog's OWN data, by
// category, live. No channel state here — only fields, images, documents.
export default function PimCompletenessPanel() {
  const { data, loading, error, reload } = usePimCompleteness();
  const [openCat, setOpenCat] = useState(null);
  const [search, setSearch] = useState('');
  const [onlyIncomplete, setOnlyIncomplete] = useState(true);
  const [expandedSku, setExpandedSku] = useState(null);

  const cat = useMemo(() => data?.categories.find((c) => c.category === openCat) ?? null, [data, openCat]);
  const products = useMemo(() => {
    if (!cat) return [];
    const q = search.trim().toLowerCase();
    return cat.products.filter((p) =>
      (!onlyIncomplete || !p.result.complete) &&
      (!q || p.sku.toLowerCase().includes(q) || (p.model_name ?? '').toLowerCase().includes(q)));
  }, [cat, search, onlyIncomplete]);

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
      <div className="rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
        <AlertCircle className="w-4 h-4 flex-shrink-0" />
        {error.message}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-body-sm text-on-surface-variant">
          Data completeness per category, computed live from the PIM · {data.totals.complete} of {data.totals.total} products at 100% · updated {formatTimeAgo(data.computedAt)}
        </p>
        <button
          type="button"
          onClick={reload}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Recompute
        </button>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile label="Products" value={data.totals.total} />
        <Tile label="At 100%" value={data.totals.complete} sub={`${data.totals.pct}% of catalog`} tone={data.totals.pct >= 90 ? 'good' : data.totals.pct >= 60 ? 'warn' : 'bad'} />
        <Tile label="Average completeness" value={`${data.totals.avg}%`} />
        <Tile label="Categories" value={data.categories.length} />
      </div>

      {/* Per-category table */}
      <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
        <header className="px-6 py-4 border-b border-outline-variant">
          <h3 className="text-title-md text-on-surface">By category</h3>
          <p className="text-body-sm text-on-surface-variant mt-0.5">Click a category to see its products and what each one is missing.</p>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
                <th className="text-left px-6 py-3 font-medium">Category</th>
                <th className="text-right px-6 py-3 font-medium">Products</th>
                <th className="text-right px-6 py-3 font-medium">At 100%</th>
                <th className="px-6 py-3 font-medium text-left w-56">Share complete</th>
                <th className="text-right px-6 py-3 font-medium">Avg score</th>
                <th className="text-left px-6 py-3 font-medium">Most common gaps</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {data.categories.map((c) => {
                const active = c.category === openCat;
                return (
                  <tr
                    key={c.category}
                    onClick={() => { setOpenCat(active ? null : c.category); setExpandedSku(null); }}
                    aria-expanded={active}
                    className={`cursor-pointer transition-colors ${active ? 'bg-surface-container-low/60' : 'hover:bg-surface-container-low/40'}`}
                  >
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-2">
                        <ChevronDown className={`w-4 h-4 text-on-surface-variant flex-shrink-0 transition-transform ${active ? 'rotate-180' : ''}`} />
                        <span className="text-body-md text-on-surface font-medium">{c.label}</span>
                      </div>
                    </td>
                    <td className="px-6 py-3 text-right text-body-md text-on-surface tabular-nums">{c.total}</td>
                    <td className="px-6 py-3 text-right text-body-md text-on-surface tabular-nums">{c.complete}</td>
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-2 rounded-full bg-surface-container-high overflow-hidden">
                          <div className={`h-full rounded-full ${c.pct >= 90 ? 'bg-tertiary' : c.pct >= 60 ? 'bg-warning' : 'bg-error'}`} style={{ width: `${c.pct}%` }} />
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
        </div>
      </section>

      {/* Products of the selected category */}
      {cat && (
        <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden animate-banner-in">
          <header className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h3 className="text-title-md text-on-surface">{cat.label}</h3>
              <p className="text-body-sm text-on-surface-variant mt-0.5">{cat.complete} of {cat.total} at 100% · showing {products.length}</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by SKU or name…"
                  className="pl-9 pr-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary w-64"
                />
              </div>
              <label className="inline-flex items-center gap-2 text-body-sm text-on-surface cursor-pointer">
                <input type="checkbox" checked={onlyIncomplete} onChange={(e) => setOnlyIncomplete(e.target.checked)} className="accent-primary" />
                Only incomplete
              </label>
            </div>
          </header>
          {products.length === 0 ? (
            <div className="px-6 py-12 text-center text-body-sm text-on-surface-variant">
              {onlyIncomplete ? 'Every product in this category is at 100%. ✨' : 'No products match.'}
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
                    <th className="px-6 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant">
                  {products.map((p) => {
                    const isOpen = expandedSku === p.sku;
                    return (
                      <Fragment key={p.sku}>
                        <tr
                          onClick={() => setExpandedSku(isOpen ? null : p.sku)}
                          aria-expanded={isOpen}
                          className={`cursor-pointer transition-colors ${isOpen ? 'bg-surface-container-low/60' : 'hover:bg-surface-container-low/40'}`}
                        >
                          <td className="px-6 py-3">
                            <div className="flex items-center gap-2">
                              <ChevronDown className={`w-4 h-4 text-on-surface-variant flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                              <div>
                                <div className="text-body-md text-on-surface font-medium truncate max-w-md">{p.model_name || p.sku}</div>
                                <div className="text-body-sm text-on-surface-variant font-mono mt-0.5">{p.sku}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-3 text-body-md text-on-surface-variant">{p.brand ?? '—'}</td>
                          <td className="px-6 py-3 text-right tabular-nums">
                            {p.result.missing.length > 0 ? <span className="text-error font-medium">{p.result.missing.length}</span> : <span className="text-on-surface-variant">—</span>}
                          </td>
                          <td className="px-6 py-3 text-right">
                            <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-label-md font-semibold ${SCORE_BADGE_STYLES[categorizeScore(p.result.score)]}`}>{p.result.score}</span>
                          </td>
                          <td className="px-6 py-3 text-right">
                            <Link to={`/catalog/${p.sku}`} onClick={(e) => e.stopPropagation()} title="Open product" className="inline-flex items-center text-on-surface-variant hover:text-primary transition-colors">
                              <ArrowRight className="w-4 h-4" />
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

function Tile({ label, value, sub, tone }) {
  const toneClass = tone === 'good' ? 'text-tertiary' : tone === 'warn' ? 'text-warning' : tone === 'bad' ? 'text-error' : 'text-on-surface';
  return (
    <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest px-5 py-4">
      <p className="text-label-md text-on-surface-variant">{label}</p>
      <p className={`text-headline-md font-semibold mt-1 tabular-nums ${toneClass}`}>{value}</p>
      {sub && <p className="text-body-sm text-on-surface-variant mt-0.5">{sub}</p>}
    </div>
  );
}

// Missing fields grouped by the product tab where they get filled in.
function MissingBreakdown({ sku, result }) {
  if (result.missing.length === 0) {
    return <p className="text-body-sm text-on-surface animate-banner-in">All {result.passed.length} fields filled — 100%. ✨</p>;
  }
  const groups = Object.keys(GROUPS)
    .sort((a, b) => GROUPS[a].order - GROUPS[b].order)
    .map((g) => ({ group: g, tab: GROUPS[g].tab, items: result.missing.filter((m) => m.group === g) }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="animate-banner-in flex flex-wrap gap-x-8 gap-y-3">
      {groups.map((g) => (
        <div key={g.group} className="min-w-[14rem]">
          <Link to={`/catalog/${sku}?tab=${g.tab}`} className="text-label-md font-semibold uppercase tracking-wider text-primary hover:underline">
            {g.group} · {g.items.length} →
          </Link>
          <ul className="mt-1.5 space-y-1">
            {g.items.map((m) => (
              <li key={m.key} className="text-body-sm text-on-surface flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-error flex-shrink-0" />
                {m.label}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
