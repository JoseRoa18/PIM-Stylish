import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  Search,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import { useListingHealth } from '@/features/dashboard/hooks/useListingHealth';
import ListingHealthOverview from '@/features/dashboard/components/ListingHealthOverview';
import ListingHealthActions from '@/features/dashboard/components/ListingHealthActions';
import PimCompletenessPanel from '@/features/dashboard/components/PimCompletenessPanel';
import {
  categorizeScore,
  MARKETPLACES,
  API_MARKETPLACE_KEYS,
} from '@/features/dashboard/lib/listingHealth';
import { readWixProduct, refreshWixCatalog } from '@/features/syndication/api/wixSync';
import { refreshBestBuyOffers } from '@/features/syndication/api/bestbuySync';
import { refreshWalmartItems } from '@/features/syndication/api/walmartSync';
import WayfairAuditCard from '@/features/syndication/components/WayfairAuditCard';
import SCORE_BADGE_STYLES from '@/lib/scoreBadgeStyles';

// The PIM tab scores the catalog's OWN data completeness, live — it leads
// the strip because every channel score starts from it.
const PIM_TAB = 'pim';

const SOURCE_STYLES = {
  wix_cache: { label: 'Wix cache', class: 'bg-tertiary/25 text-on-tertiary-container border border-tertiary/40' },
  pim_fallback: { label: 'PIM (no cache)', class: 'bg-warning-container text-on-warning-container' },
  not_linked: { label: 'Not linked', class: 'bg-surface-container text-on-surface-variant' },
  pim: { label: 'PIM', class: 'bg-surface-container text-on-surface-variant' },
  offer: { label: 'Live offer', class: 'bg-success-container text-on-success-container' },
  site: { label: 'Live site', class: 'bg-success-container text-on-success-container' },
};

const SEVERITY_META = {
  critical: { label: 'Critical', dot: 'bg-error', text: 'text-error' },
  major: { label: 'Major', dot: 'bg-warning', text: 'text-warning' },
  minor: { label: 'Minor', dot: 'bg-on-surface-variant', text: 'text-on-surface-variant' },
};

// Per-product breakdown of failed checks, grouped by severity — the exact
// "why is this score what it is" behind each row.
function IssueBreakdown({ result, sku, notLinked = false, marketplaceLabel = 'this marketplace', wayfairAudit, bbOffer, wmItem }) {
  if (result.issues.length === 0) {
    return (
      <p className="text-body-sm text-on-surface animate-banner-in">
        All {result.passed.length} checks pass — nothing to fix. ✨
      </p>
    );
  }
  const groups = ['critical', 'major', 'minor']
    .map((sev) => ({ sev, items: result.issues.filter((i) => i.severity === sev) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="animate-banner-in">
      {notLinked && (
        <p className="mb-3 px-3 py-2 rounded-lg bg-surface-container-high text-body-sm text-on-surface">
          Not connected to a {marketplaceLabel} listing yet — the checks below measure
          how ready this product is to launch there.
        </p>
      )}
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        {groups.map(({ sev, items }) => {
          const meta = SEVERITY_META[sev];
          return (
            <div key={sev} className="min-w-[14rem]">
              <p className={`text-label-md font-semibold uppercase tracking-wider ${meta.text} mb-1.5`}>
                {meta.label} · {items.length}
              </p>
              <ul className="space-y-1">
                {items.map((i) => (
                  <li key={i.key} className="text-body-sm text-on-surface">
                    <span className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot} flex-shrink-0`} />
                      {i.label}
                      {i.category !== i.label && (
                        <span className="text-on-surface-variant">· {i.category}</span>
                      )}
                    </span>
                    {i.key === 'wayfair_specs_synced' && wayfairAudit?.fields?.length > 0 && (
                      <p className="ml-3.5 mt-0.5 text-body-sm text-on-surface-variant max-w-md">
                        Differs at Wayfair in:{' '}
                        <span className="text-on-surface">{wayfairAudit.fields.join(' · ')}</span>
                      </p>
                    )}
                    {i.key === 'bb_price_matches' && bbOffer?.price != null && bbOffer?.msrp != null && (
                      <p className="ml-3.5 mt-0.5 text-body-sm text-on-surface-variant">
                        Best Buy <span className="text-on-surface">${Number(bbOffer.price).toFixed(2)}</span>{' '}
                        vs PIM MSRP <span className="text-on-surface">${Number(bbOffer.msrp).toFixed(2)}</span>
                      </p>
                    )}
                    {i.key === 'bb_in_stock' && bbOffer && (
                      <p className="ml-3.5 mt-0.5 text-body-sm text-on-surface-variant">
                        Quantity at Best Buy: <span className="text-on-surface">{bbOffer.quantity ?? 0}</span>
                      </p>
                    )}
                    {(i.key === 'wm_published' || i.key === 'wm_lifecycle_active') && wmItem && (
                      <p className="ml-3.5 mt-0.5 text-body-sm text-on-surface-variant">
                        Walmart status: <span className="text-on-surface">{wmItem.published || '—'}</span>
                        {wmItem.lifecycle ? <span> · {wmItem.lifecycle}</span> : null}
                        {wmItem.price != null && <span> · ${Number(wmItem.price).toFixed(2)} USD</span>}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-body-sm text-on-surface-variant">
        {result.passed.length} check{result.passed.length === 1 ? '' : 's'} passing ·{' '}
        <Link to={`/catalog/${sku}?tab=marketplaces`} className="text-primary font-semibold hover:underline">
          Open product to fix →
        </Link>
      </p>
    </div>
  );
}

const SORT_OPTIONS = [
  { key: 'score_asc', label: 'Lowest score first' },
  { key: 'score_desc', label: 'Highest score first' },
  { key: 'sku', label: 'SKU (A–Z)' },
  { key: 'name', label: 'Name (A–Z)' },
];

const FILTER_OPTIONS = [
  { key: 'all', label: 'All products' },
  { key: 'critical', label: 'Critical (0–49)' },
  { key: 'needs_work', label: 'Needs Work (50–69)' },
  { key: 'good', label: 'Good (70–89)' },
  { key: 'excellent', label: 'Excellent (90–100)' },
];

export default function ListingHealth() {
  const { byMarketplace, loading, error } = useListingHealth();
  // ?tab=<marketplace key> deep-links straight into a channel's tab
  // (used by the Syndication channel workspaces).
  const initialTab = new URLSearchParams(window.location.search).get('tab');
  const [marketplace, setMarketplace] = useState(
    initialTab === PIM_TAB || API_MARKETPLACE_KEYS.includes(initialTab) ? initialTab : PIM_TAB,
  );
  const isPim = marketplace === PIM_TAB;
  const TAB_KEYS = [PIM_TAB, ...API_MARKETPLACE_KEYS];
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('score_asc');
  const [filter, setFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState({ done: 0, total: 0 });
  const [page, setPage] = useState(1);
  const [expandedSku, setExpandedSku] = useState(null);
  const PAGE_SIZE = 25;

  // The tab strip hides its scrollbar, so edge fades + a chevron are the only
  // signal that more channels sit off-screen. Re-measured on scroll, resize,
  // and when the average-score badges arrive (they widen the strip).
  const tabsRef = useRef(null);
  const [tabsCanScroll, setTabsCanScroll] = useState({ left: false, right: false });
  const updateTabsScroll = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setTabsCanScroll((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    updateTabsScroll();
    window.addEventListener('resize', updateTabsScroll);
    return () => window.removeEventListener('resize', updateTabsScroll);
  }, [updateTabsScroll, byMarketplace]);

  const mktDef = isPim ? null : MARKETPLACES[marketplace];
  const mktData = byMarketplace[marketplace];
  const products = mktData?.products ?? [];
  const stats = mktData?.stats ?? null;
  const cachedCount = mktData?.cachedCount ?? 0;
  const linkedCount = mktData?.linkedCount ?? 0;

  const filtered = useMemo(() => {
    let list = [...products];

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (p) =>
          p.sku?.toLowerCase().includes(q) ||
          p.model_name?.toLowerCase().includes(q) ||
          p.brand?.toLowerCase().includes(q),
      );
    }

    if (filter !== 'all') {
      list = list.filter((p) => categorizeScore(p.result.score) === filter);
    }

    list.sort((a, b) => {
      switch (sort) {
        case 'score_asc': return a.result.score - b.result.score;
        case 'score_desc': return b.result.score - a.result.score;
        case 'sku': return (a.sku ?? '').localeCompare(b.sku ?? '');
        case 'name': return (a.model_name ?? '').localeCompare(b.model_name ?? '');
        default: return 0;
      }
    });

    return list;
  }, [products, search, filter, sort]);

  // Any change of what's listed goes back to page 1 and collapses details.
  useEffect(() => {
    setPage(1);
    setExpandedSku(null);
  }, [marketplace, search, filter, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Read-only channel pulls: fetch the channel's live state into a snapshot.
  // Keyed by marketplace key first, then by shared dataSource.
  const CHANNEL_REFRESH = {
    bestbuy: { run: refreshBestBuyOffers, label: 'Best Buy' },
    walmart_us: { run: () => refreshWalmartItems('us'), label: 'Walmart' },
    walmart_ca: { run: () => refreshWalmartItems('ca'), label: 'Walmart CA' },
    // Fleet snapshot (whole store in one pull) — the per-product cache
    // refresh below remains its own, slower button.
    wix_cache: { run: refreshWixCatalog, label: 'Wix' },
    wix_sinksdirect_us: { run: () => refreshWixCatalog('sinksdirect_us'), label: 'the site' },
    wix_stylish_ca: { run: () => refreshWixCatalog('stylish_ca'), label: 'the site' },
    wix_stylish_us: { run: () => refreshWixCatalog('stylish_us'), label: 'the site' },
  };
  const refreshDef = mktDef ? (CHANNEL_REFRESH[mktDef.key] ?? CHANNEL_REFRESH[mktDef.dataSource]) : null;

  async function refreshChannel() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshDef.run();
      window.location.reload();
    } catch (err) {
      alert(`${refreshDef.label} refresh failed: ${err.message}`);
      setRefreshing(false);
    }
  }

  async function refreshAllFromWix() {
    if (refreshing) return;
    const linked = products.filter((p) => p.wix_product_id);
    if (linked.length === 0) return;

    setRefreshing(true);
    setRefreshProgress({ done: 0, total: linked.length });

    let done = 0;
    for (let i = 0; i < linked.length; i += 4) {
      const batch = linked.slice(i, i + 4);
      await Promise.allSettled(batch.map((p) => readWixProduct(p.sku)));
      done += batch.length;
      setRefreshProgress({ done, total: linked.length });
    }

    window.location.reload();
  }

  return (
    <div className="max-w-7xl mx-auto">
      <header className="mb-4">
        <h1 className="text-display-lg text-on-surface">Listing Health</h1>
        <p className="text-body-md text-on-surface-variant mt-1">
          Track readiness across each marketplace and identify what needs attention.
        </p>
      </header>

      {/* Marketplace tabs — only API-connected channels */}
      {TAB_KEYS.length > 1 && (
      <div className="relative mb-6">
      <div
        ref={tabsRef}
        onScroll={updateTabsScroll}
        className="border-b border-outline-variant overflow-x-auto scrollbar-hide"
      >
        <nav className="flex min-w-max gap-1" role="tablist">
          {TAB_KEYS.map((key) => {
            const def = key === PIM_TAB ? { label: 'PIM' } : MARKETPLACES[key];
            const data = key === PIM_TAB ? null : byMarketplace[key];
            const avg = data?.stats?.avgScore ?? 0;
            const isActive = key === marketplace;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setMarketplace(key)}
                className={`inline-flex items-center gap-2 px-4 py-3 text-body-md whitespace-nowrap border-b-2 -mb-px transition-colors ${
                  isActive
                    ? 'border-primary text-primary font-semibold'
                    : 'border-transparent text-on-surface-variant hover:text-on-surface hover:border-outline-variant'
                }`}
              >
                {def.label}
                {key === PIM_TAB && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-label-md font-semibold bg-tertiary/20 text-on-tertiary-container">live</span>
                )}
                {data && (
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-label-md font-semibold ${SCORE_BADGE_STYLES[categorizeScore(avg)]}`}>
                    {avg}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>
      {tabsCanScroll.left && (
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-background to-transparent pointer-events-none"
        />
      )}
      {tabsCanScroll.right && (
        <div
          aria-hidden="true"
          className="absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-background to-transparent pointer-events-none flex items-center justify-end"
        >
          <ChevronRight className="w-4 h-4 text-on-surface-variant" />
        </div>
      )}
      </div>
      )}

      {isPim && <PimCompletenessPanel />}

      {!isPim && loading && (
        <div role="status" aria-label="Loading catalog health" className="animate-pulse space-y-6">
          <div className="h-56 rounded-2xl bg-surface-container" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-48 rounded-2xl bg-surface-container" />
            <div className="h-48 rounded-2xl bg-surface-container" />
          </div>
          <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
            <div className="h-16 bg-surface-container" />
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="h-14 border-t border-outline-variant flex items-center px-6">
                <div className="h-3 w-48 max-w-[40%] rounded bg-surface-container" />
              </div>
            ))}
          </div>
        </div>
      )}

      {!isPim && error && (
        <div className="rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error.message}
        </div>
      )}

      {!isPim && !loading && !error && mktData && (
        <>
          {/* Wayfair-only: the FULL spec-attributes audit lives right here —
              last run, per-SKU diffs and the mass push — so sync issues are
              worked without bouncing to the Syndication page. The cron runs
              it 20 minutes before each health refresh (6:40 & 1:40 VET). */}
          {mktDef.dataSource === 'wayfair' && (
            <div className="mb-6">
              <WayfairAuditCard />
            </div>
          )}

          {/* Marketplace subtitle + actions */}
          <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
            <p className="text-body-sm text-on-surface-variant">
              {/* The blurbs below already say read-only, so the subtitle's own
                  "(read-only)" suffix (defined channel-side) is dropped here. */}
              {mktDef.subtitle.replace(/\s*\(read-only\)\s*$/, '')}
              {mktDef.dataSource === 'wix_cache' && (
                <> · scoring against cached Wix data</>
              )}
              {mktDef.dataSource === 'pim' && (
                <> · scoring against PIM data needed to fill the template</>
              )}
              {mktDef.dataSource === 'wayfair' && (
                <> · PIM readiness + spec-attribute sync from the latest audit</>
              )}
              {mktDef.dataSource === 'bestbuy' && (
                <> · offers, stock & prices from the latest pull — nothing is ever written to Best Buy</>
              )}
              {mktDef.dataSource === 'walmart_us' && (
                <> · items & publish status from the latest pull — nothing is ever written to Walmart</>
              )}
              {mktDef.dataSource === 'walmart_ca' && (
                <> · Walmart CA exposes no item API — read-only</>
              )}
              {mktDef.dataSource === 'wix_site' && (
                <> · scoring against the store's latest catalog snapshot (refreshed twice a day)</>
              )}
            </p>
            {refreshDef && (
              <button
                type="button"
                onClick={refreshChannel}
                disabled={refreshing}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-60"
              >
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing ? 'Pulling…' : `Refresh from ${refreshDef.label}`}
              </button>
            )}
            {mktDef.dataSource === 'wix_cache' && linkedCount > 0 && (
              <button
                type="button"
                onClick={refreshAllFromWix}
                disabled={refreshing}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-60"
              >
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing
                  ? `Refreshing ${refreshProgress.done}/${refreshProgress.total}…`
                  : 'Refresh from Wix'}
              </button>
            )}
          </div>

          {mktDef.dataSource === 'wix_cache' && linkedCount > 0 && cachedCount < linkedCount && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-warning-container/50 border border-warning-container text-on-warning-container text-body-sm flex items-start gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">
                  {linkedCount - cachedCount} product{linkedCount - cachedCount === 1 ? '' : 's'} need a live Wix refresh
                </p>
                <p className="opacity-80 mt-0.5">
                  {cachedCount} of {linkedCount} linked products have cached Wix data. Click "Refresh from Wix" to update the rest.
                </p>
              </div>
            </div>
          )}

          <ListingHealthOverview
            stats={stats}
            productCount={products.length}
            marketplaceLabel={mktDef.label}
          />
          <ListingHealthActions stats={stats} products={products} marketplaceLabel={mktDef.label} />

          <section className="mt-6 rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
            <header className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-4 flex-wrap">
              <h3 className="text-title-md text-on-surface">All Products</h3>
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
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                >
                  {FILTER_OPTIONS.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                  className="px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                >
                  {SORT_OPTIONS.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
              </div>
            </header>

            {filtered.length === 0 ? (
              <div className="px-6 py-12 text-center text-body-sm text-on-surface-variant">
                No products match your filters.
              </div>
            ) : (
              // The section clips to its rounded corners, so narrow viewports
              // scroll the table inside its own wrapper instead of losing columns.
              <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
                    <th className="text-left px-6 py-3 font-medium">Product</th>
                    <th className="text-left px-6 py-3 font-medium">Brand</th>
                    <th className="text-left px-6 py-3 font-medium">Source</th>
                    <th className="text-right px-6 py-3 font-medium">Critical Issues</th>
                    <th className="text-right px-6 py-3 font-medium">Score</th>
                    <th className="px-6 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant">
                  {paged.map((p) => {
                    const cat = categorizeScore(p.result.score);
                    const critCount = p.result.issues.filter((i) => i.severity === 'critical').length;
                    const source = SOURCE_STYLES[p.source] ?? SOURCE_STYLES.pim;
                    // Walmart pulls items (publish status), not Mirakl offers —
                    // same green badge, channel-correct noun.
                    const sourceLabel =
                      p.source === 'offer' && mktDef.dataSource.startsWith('walmart_')
                        ? 'Live item'
                        : source.label;
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
                          <td className="px-6 py-3 text-body-sm">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-label-md ${source.class}`}>
                              {sourceLabel}
                            </span>
                          </td>
                          <td className="px-6 py-3 text-right">
                            {critCount > 0 ? (
                              <span className="text-error font-medium">{critCount}</span>
                            ) : (
                              <span className="text-on-surface-variant">—</span>
                            )}
                          </td>
                          <td className="px-6 py-3 text-right">
                            <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-label-md font-semibold ${SCORE_BADGE_STYLES[cat]}`}>
                              {p.result.score}
                            </span>
                          </td>
                          <td className="px-6 py-3 text-right">
                            <Link
                              to={`/catalog/${p.sku}?tab=marketplaces`}
                              onClick={(e) => e.stopPropagation()}
                              title="Open product"
                              className="inline-flex items-center text-on-surface-variant hover:text-primary transition-colors"
                            >
                              <ArrowRight className="w-4 h-4" />
                            </Link>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-surface-container-low/30">
                            <td colSpan={6} className="px-6 pb-4 pt-1">
                              <IssueBreakdown
                                result={p.result}
                                sku={p.sku}
                                notLinked={p.source === 'not_linked'}
                                marketplaceLabel={mktDef.label}
                                wayfairAudit={p.wayfair_audit}
                                bbOffer={p.bb_offer}
                                wmItem={p.wm_item}
                              />
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

            {filtered.length > PAGE_SIZE && (
              <div className="px-6 py-3 border-t border-outline-variant flex items-center justify-between gap-3 flex-wrap">
                <span className="text-body-sm text-on-surface-variant tabular-nums">
                  Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
                  {filtered.length !== products.length && <> · filtered from {products.length}</>}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={safePage === 1}
                    className="px-3 py-1.5 rounded-lg border border-outline-variant text-body-sm text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <span className="px-2 text-body-sm text-on-surface-variant tabular-nums">
                    {safePage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage === totalPages}
                    className="px-3 py-1.5 rounded-lg border border-outline-variant text-body-sm text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}

            {filtered.length <= PAGE_SIZE && (
              <footer className="px-6 py-3 border-t border-outline-variant text-label-md text-on-surface-variant">
                Showing {filtered.length} of {products.length} {products.length === 1 ? 'product' : 'products'}
              </footer>
            )}
          </section>
        </>
      )}
    </div>
  );
}
