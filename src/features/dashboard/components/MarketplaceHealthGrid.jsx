import { Link } from 'react-router-dom';
import { HeartPulse, Loader2 } from 'lucide-react';
import { formatTimeAgo } from '@/lib/format';
import {
  MARKETPLACES,
  API_MARKETPLACE_KEYS,
  categorizeScore,
} from '../lib/listingHealth';

const SCORE_BADGE_STYLES = {
  excellent: 'bg-success-container text-on-success-container',
  good: 'bg-tertiary-container/40 text-on-tertiary-container',
  needs_work: 'bg-warning-container text-on-warning-container',
  critical: 'bg-error-container text-on-error-container',
};

const DISTRIBUTION_SEGMENTS = [
  { key: 'excellent', class: 'bg-success' },
  { key: 'good', class: 'bg-tertiary' },
  { key: 'needs_work', class: 'bg-warning' },
  { key: 'critical', class: 'bg-error' },
];

/**
 * One compact card per API-connected marketplace, fed by the persisted
 * listing-health summaries — average score, score distribution, critical
 * count and snapshot age. Each card deep-links into its Listing Health tab.
 */
export default function MarketplaceHealthGrid({ summaries, refreshing = false }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <HeartPulse className="w-4 h-4 text-on-surface-variant" />
        <h2 className="text-title-md text-on-surface">Marketplace Health</h2>
        {refreshing && (
          <span className="inline-flex items-center gap-1.5 text-label-md text-on-surface-variant">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            updating scores…
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {API_MARKETPLACE_KEYS.map((key) => (
          <HealthCard
            key={key}
            mkt={MARKETPLACES[key]}
            summary={summaries[key]}
            refreshing={refreshing}
          />
        ))}
      </div>
    </section>
  );
}

function HealthCard({ mkt, summary, refreshing }) {
  if (!summary) {
    return (
      <Link
        to={`/listing-health?tab=${mkt.key}`}
        className="rounded-xl border border-dashed border-outline-variant bg-surface px-4 py-3 flex flex-col hover:border-primary transition-colors"
      >
        <span className="text-body-md text-on-surface font-medium truncate">{mkt.label}</span>
        <span className="text-body-sm text-on-surface-variant mt-1">
          {refreshing ? 'Computing the first score…' : 'No score yet — open Listing Health to compute it.'}
        </span>
      </Link>
    );
  }

  const category = categorizeScore(summary.avgScore);
  const d = summary.distribution ?? {};
  const critical = d.critical ?? 0;
  const scored = DISTRIBUTION_SEGMENTS.reduce((sum, s) => sum + (d[s.key] ?? 0), 0);

  return (
    <Link
      to={`/listing-health?tab=${mkt.key}`}
      className="rounded-xl border border-outline-variant bg-surface px-4 py-3 flex flex-col gap-2 hover:border-primary transition-colors"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-body-md text-on-surface font-medium truncate">{mkt.label}</span>
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-label-md font-semibold tabular-nums ${SCORE_BADGE_STYLES[category]}`}>
          {summary.avgScore}
        </span>
      </div>

      {scored > 0 && (
        <div className="flex h-1.5 rounded-full overflow-hidden bg-surface-container">
          {DISTRIBUTION_SEGMENTS.filter((s) => (d[s.key] ?? 0) > 0).map((s) => (
            <div key={s.key} className={s.class} style={{ width: `${(d[s.key] / scored) * 100}%` }} />
          ))}
        </div>
      )}

      <div className="text-label-md text-on-surface-variant">
        {critical > 0 ? (
          <span className="text-error font-medium">{critical} critical</span>
        ) : (
          <span>No critical listings</span>
        )}
        <span> · updated {formatTimeAgo(summary.runAt)}</span>
      </div>
    </Link>
  );
}
