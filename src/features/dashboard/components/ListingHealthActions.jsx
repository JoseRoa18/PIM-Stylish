import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Package } from 'lucide-react';
import { categorizeScore } from '../lib/listingHealth';

const SEVERITY_STYLES = {
  critical: { dot: 'bg-error', text: 'text-error', label: 'Critical' },
  major: { dot: 'bg-warning', text: 'text-warning', label: 'Major' },
  minor: { dot: 'bg-on-surface-variant', text: 'text-on-surface-variant', label: 'Minor' },
};

const SCORE_BADGE_STYLES = {
  excellent: 'bg-success-container text-on-success-container',
  good: 'bg-tertiary-container/40 text-on-tertiary-container',
  needs_work: 'bg-warning-container text-on-warning-container',
  critical: 'bg-error-container text-on-error-container',
};

export default function ListingHealthActions({ stats, products }) {
  if (!stats) return null;

  const ranked = [...products]
    .sort((a, b) => a.result.score - b.result.score)
    .slice(0, 8);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
        <header className="px-6 py-4 border-b border-outline-variant">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <h3 className="text-title-md text-on-surface">Top Issues</h3>
          </div>
          <p className="text-body-sm text-on-surface-variant mt-0.5">
            Most impactful gaps across the catalog
          </p>
        </header>
        <ul className="divide-y divide-outline-variant">
          {stats.topIssues.length === 0 ? (
            <li className="px-6 py-8 text-center text-body-sm text-on-surface-variant">
              No issues found — all listings look healthy.
            </li>
          ) : (
            stats.topIssues.map((issue) => {
              const sev = SEVERITY_STYLES[issue.severity];
              return (
                <li
                  key={issue.key}
                  className="px-6 py-3.5 hover:bg-surface-container-low/50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`w-1.5 h-1.5 rounded-full ${sev.dot} flex-shrink-0`} />
                        <span className="text-body-md text-on-surface font-medium">{issue.label}</span>
                        <span className="text-label-md text-on-surface-variant">· {issue.category}</span>
                      </div>
                      <p className={`text-body-sm ${sev.text} mt-0.5`}>
                        Missing in {issue.count} {issue.count === 1 ? 'product' : 'products'} · {sev.label}
                      </p>
                    </div>
                    <Link
                      to={`/catalog/${issue.skus[0]}?tab=marketplaces`}
                      className="text-label-md text-primary font-medium hover:underline whitespace-nowrap"
                      title={`First: ${issue.skus[0]}`}
                    >
                      View →
                    </Link>
                  </div>
                </li>
              );
            })
          )}
        </ul>
      </section>

      <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
        <header className="px-6 py-4 border-b border-outline-variant">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-on-surface-variant" />
            <h3 className="text-title-md text-on-surface">Needs Attention</h3>
          </div>
          <p className="text-body-sm text-on-surface-variant mt-0.5">
            Products with the lowest Wix readiness scores
          </p>
        </header>
        <ul className="divide-y divide-outline-variant">
          {ranked.length === 0 ? (
            <li className="px-6 py-8 text-center text-body-sm text-on-surface-variant">
              No products yet.
            </li>
          ) : (
            ranked.map((p) => {
              const cat = categorizeScore(p.result.score);
              const criticalCount = p.result.issues.filter((i) => i.severity === 'critical').length;
              return (
                <li key={p.sku}>
                  <Link
                    to={`/catalog/${p.sku}?tab=marketplaces`}
                    className="flex items-center justify-between gap-3 px-6 py-3.5 hover:bg-surface-container-low/50 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-body-md text-on-surface font-medium truncate">
                        {p.model_name || p.sku}
                      </div>
                      <p className="text-body-sm text-on-surface-variant mt-0.5">
                        <span className="font-mono">{p.sku}</span>
                        {p.brand ? <span> · {p.brand}</span> : null}
                        {criticalCount > 0 && (
                          <span className="text-error"> · {criticalCount} critical {criticalCount === 1 ? 'issue' : 'issues'}</span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-label-md font-semibold ${SCORE_BADGE_STYLES[cat]}`}>
                        {p.result.score}
                      </span>
                      <ArrowRight className="w-4 h-4 text-on-surface-variant" />
                    </div>
                  </Link>
                </li>
              );
            })
          )}
        </ul>
      </section>
    </div>
  );
}
