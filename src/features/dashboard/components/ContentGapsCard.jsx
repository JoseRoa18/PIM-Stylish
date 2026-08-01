import { Link } from 'react-router-dom';
import { ListChecks, ArrowRight, CheckCircle2 } from 'lucide-react';

// Dot and bar share the severity token so both encodings tell the same story.
const SEVERITY_STYLES = {
  critical: { dot: 'bg-error', bar: 'bg-error/70' },
  major: { dot: 'bg-warning', bar: 'bg-warning/70' },
  minor: { dot: 'bg-on-surface-variant', bar: 'bg-outline-variant' },
};

/**
 * The most frequent missing content across marketplaces (no photo, no UPC,
 * no bullet points…), merged from the persisted listing-health summaries.
 * Channel-side checks are filtered out upstream — everything here is fixable
 * by editing product content in the PIM.
 */
export default function ContentGapsCard({ gaps, hasSummaries }) {
  const max = gaps.reduce((m, g) => Math.max(m, g.count), 0) || 1;

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <Link
        to="/listing-health"
        className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-2 hover:bg-surface-container-low/40 transition-colors group"
      >
        <span className="flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-on-surface-variant" />
          <span className="text-title-md text-on-surface">Content Gaps</span>
        </span>
        <span className="inline-flex items-center gap-1 text-label-md text-primary">
          Listing Health
          <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </span>
      </Link>

      {gaps.length === 0 ? (
        <div className="px-6 py-10 flex items-center justify-center gap-2 text-body-sm text-on-surface-variant text-center">
          {hasSummaries ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
              No missing content across marketplaces. ✨
            </>
          ) : (
            <span>
              Open Listing Health once to compute content coverage — the top gaps will show up here.
            </span>
          )}
        </div>
      ) : (
        <ul className="px-6 py-4 space-y-3">
          {gaps.map((g) => {
            const sev = SEVERITY_STYLES[g.severity] ?? SEVERITY_STYLES.minor;
            return (
              <li key={g.key} className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${sev.dot}`} />
                  {/* The gap name never yields its width to the marketplace list —
                      only the secondary span truncates. */}
                  <span className="text-body-sm text-on-surface flex-shrink-0">{g.label}</span>
                  <span className="text-label-md text-on-surface-variant flex-1 min-w-0 truncate hidden sm:inline">
                    · {g.marketplaces.join(' · ')}
                  </span>
                  <span className="text-label-md text-on-surface font-semibold tabular-nums ml-auto">
                    {g.count}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-surface-container overflow-hidden ml-3.5">
                  <div
                    className={`h-full rounded-full ${sev.bar} transition-[width] duration-500`}
                    style={{ width: `${Math.max(4, (g.count / max) * 100)}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
