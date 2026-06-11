import { TrendingUp, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { categorizeScore, SCORE_CATEGORIES } from '../lib/listingHealth';

const CATEGORY_ICONS = {
  excellent: CheckCircle2,
  good: TrendingUp,
  needs_work: Clock,
  critical: XCircle,
};

const CATEGORY_STYLES = {
  excellent: 'bg-success-container text-on-success-container',
  good: 'bg-tertiary-container/40 text-on-tertiary-container',
  needs_work: 'bg-warning-container text-on-warning-container',
  critical: 'bg-error-container text-on-error-container',
};

const BAR_COLORS = {
  excellent: 'bg-success',
  good: 'bg-tertiary',
  needs_work: 'bg-warning',
  critical: 'bg-error',
};

export default function ListingHealthOverview({ stats, productCount, marketplaceLabel }) {
  if (!stats) return null;

  const overallCat = categorizeScore(stats.avgScore);
  const dist = stats.distribution;
  const total = dist.excellent + dist.good + dist.needs_work + dist.critical;
  const label = marketplaceLabel ?? 'Marketplace';

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6 mb-6">
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h2 className="text-title-lg text-on-surface">{label} Listing Health</h2>
          <p className="text-body-sm text-on-surface-variant mt-1">
            How ready your {productCount} {productCount === 1 ? 'product is' : 'products are'} for {label}.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-display-md text-on-surface font-semibold leading-none">
              {stats.avgScore}
              <span className="text-title-lg text-on-surface-variant">/100</span>
            </div>
            <div className="text-label-md text-on-surface-variant mt-1">Catalog average</div>
          </div>
          <CategoryBadge category={overallCat} large />
        </div>
      </div>

      {/* Distribution bar */}
      <div className="mb-3">
        <div className="flex h-3 rounded-full overflow-hidden bg-surface-container">
          {total > 0 && (
            <>
              <Segment count={dist.excellent} total={total} color={BAR_COLORS.excellent} />
              <Segment count={dist.good} total={total} color={BAR_COLORS.good} />
              <Segment count={dist.needs_work} total={total} color={BAR_COLORS.needs_work} />
              <Segment count={dist.critical} total={total} color={BAR_COLORS.critical} />
            </>
          )}
        </div>
      </div>

      {/* Distribution counts */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {Object.entries(SCORE_CATEGORIES).map(([key, c]) => {
          const Icon = CATEGORY_ICONS[key];
          return (
            <div
              key={key}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-outline-variant bg-surface"
            >
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${CATEGORY_STYLES[key]}`}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-title-md text-on-surface font-semibold leading-none">
                  {dist[key]}
                </div>
                <div className="text-label-md text-on-surface-variant mt-0.5 truncate">
                  {c.label} <span className="opacity-60">{c.range}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Segment({ count, total, color }) {
  if (count === 0) return null;
  const pct = (count / total) * 100;
  return <div className={color} style={{ width: `${pct}%` }} title={`${count} products`} />;
}

function CategoryBadge({ category, large = false }) {
  const Icon = CATEGORY_ICONS[category];
  const style = CATEGORY_STYLES[category];
  const label = SCORE_CATEGORIES[category].label;
  const padding = large ? 'px-3 py-1.5 text-body-md' : 'px-2 py-0.5 text-label-md';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full ${padding} ${style} font-medium`}>
      <Icon className={large ? 'w-4 h-4' : 'w-3 h-3'} />
      {label}
    </span>
  );
}
