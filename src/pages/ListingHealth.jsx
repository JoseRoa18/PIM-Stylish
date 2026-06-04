import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Loader2,
  AlertCircle,
  Search,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { useListingHealth } from '@/features/dashboard/hooks/useListingHealth';
import ListingHealthOverview from '@/features/dashboard/components/ListingHealthOverview';
import ListingHealthActions from '@/features/dashboard/components/ListingHealthActions';
import {
  categorizeScore,
  MARKETPLACES,
  API_MARKETPLACE_KEYS,
} from '@/features/dashboard/lib/listingHealth';
import { readWixProduct } from '@/features/syndication/api/wixSync';

const SCORE_BADGE_STYLES = {
  excellent: 'bg-emerald-100 text-emerald-800',
  good: 'bg-tertiary-container/40 text-on-tertiary-container',
  needs_work: 'bg-amber-100 text-amber-800',
  critical: 'bg-error-container text-on-error-container',
};

const SOURCE_STYLES = {
  wix_cache: { label: 'Wix cache', class: 'bg-tertiary-container/40 text-on-tertiary-container' },
  pim_fallback: { label: 'PIM (no cache)', class: 'bg-amber-100 text-amber-800' },
  not_linked: { label: 'Not linked', class: 'bg-surface-container text-on-surface-variant' },
  pim: { label: 'PIM', class: 'bg-surface-container text-on-surface-variant' },
};

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
  const [marketplace, setMarketplace] = useState(API_MARKETPLACE_KEYS[0]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('score_asc');
  const [filter, setFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState({ done: 0, total: 0 });

  const mktDef = MARKETPLACES[marketplace];
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
    <div className="p-6 max-w-7xl mx-auto">
      <header className="mb-4">
        <h1 className="text-display-lg text-on-surface">Listing Health</h1>
        <p className="text-body-md text-on-surface-variant mt-1">
          Track readiness across each marketplace and identify what needs attention.
        </p>
      </header>

      {/* Marketplace tabs — only API-connected channels */}
      {API_MARKETPLACE_KEYS.length > 1 && (
      <div className="border-b border-outline-variant mb-6 overflow-x-auto scrollbar-hide">
        <nav className="flex min-w-max gap-1" role="tablist">
          {API_MARKETPLACE_KEYS.map((key) => {
            const def = MARKETPLACES[key];
            const data = byMarketplace[key];
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
      )}

      {loading && (
        <div className="flex items-center justify-center py-24 text-on-surface-variant">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading catalog health…
        </div>
      )}

      {error && (
        <div className="rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error.message}
        </div>
      )}

      {!loading && !error && mktData && (
        <>
          {/* Marketplace subtitle + actions */}
          <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
            <p className="text-body-sm text-on-surface-variant">
              {mktDef.subtitle}
              {mktDef.dataSource === 'wix_cache' && (
                <> · scoring against cached Wix data</>
              )}
              {mktDef.dataSource === 'pim' && (
                <> · scoring against PIM data needed to fill the template</>
              )}
            </p>
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
            <div className="mb-4 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-body-sm flex items-start gap-2">
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
          <ListingHealthActions stats={stats} products={products} />

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
              <table className="w-full">
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
                  {filtered.map((p) => {
                    const cat = categorizeScore(p.result.score);
                    const critCount = p.result.issues.filter((i) => i.severity === 'critical').length;
                    const source = SOURCE_STYLES[p.source] ?? SOURCE_STYLES.pim;
                    return (
                      <tr key={p.sku} className="hover:bg-surface-container-low/40 transition-colors">
                        <td className="px-6 py-3">
                          <Link
                            to={`/catalog/${p.sku}?tab=marketplaces`}
                            className="text-body-md text-on-surface hover:text-primary transition-colors"
                          >
                            <div className="font-medium truncate max-w-md">{p.model_name || p.sku}</div>
                            <div className="text-body-sm text-on-surface-variant font-mono mt-0.5">{p.sku}</div>
                          </Link>
                        </td>
                        <td className="px-6 py-3 text-body-md text-on-surface-variant">{p.brand ?? '—'}</td>
                        <td className="px-6 py-3 text-body-sm">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-label-md ${source.class}`}>
                            {source.label}
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
                            className="inline-flex items-center text-on-surface-variant hover:text-primary transition-colors"
                          >
                            <ArrowRight className="w-4 h-4" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <footer className="px-6 py-3 border-t border-outline-variant text-label-md text-on-surface-variant">
              Showing {filtered.length} of {products.length} {products.length === 1 ? 'product' : 'products'}
            </footer>
          </section>
        </>
      )}
    </div>
  );
}
