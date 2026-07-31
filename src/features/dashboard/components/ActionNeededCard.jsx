import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCircle2, ScanSearch } from 'lucide-react';
import { formatTimeAgo } from '@/lib/format';

/**
 * The "what needs my attention" strip — one row per channel discrepancy,
 * built from the persisted channel snapshots. Every row links to the
 * workspace where the fix happens (the PIM is the source of truth, so
 * diffs are resolved by pushing, not by copying channel data in).
 */
export default function ActionNeededCard({ actions, hasChannelSnapshots }) {
  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-on-surface-variant" />
        <h2 className="text-title-md text-on-surface">Needs Attention</h2>
        {actions.length > 0 && (
          <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded-md text-label-md font-semibold bg-error-container text-on-error-container">
            {actions.length}
          </span>
        )}
      </header>

      {actions.length === 0 ? (
        hasChannelSnapshots ? (
          <div className="px-6 py-8 flex items-center gap-3 text-body-md text-on-surface">
            <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
            All channels are in sync with the PIM — no discrepancies detected.
          </div>
        ) : (
          <div className="px-6 py-8 flex items-center gap-3 text-body-md text-on-surface-variant">
            <ScanSearch className="w-5 h-5 flex-shrink-0" />
            <span>
              No channel snapshots yet. Run the pulls from{' '}
              <Link to="/listing-health" className="text-primary font-semibold hover:underline">
                Listing Health
              </Link>{' '}
              to start tracking discrepancies.
            </span>
          </div>
        )
      ) : (
        <ul className="divide-y divide-outline-variant">
          {actions.map((a) => (
            <li key={a.key}>
              <Link
                to={a.to}
                className="flex items-center gap-4 px-6 py-3.5 hover:bg-surface-container-low/40 transition-colors group"
              >
                <span className="inline-flex items-center justify-center min-w-9 h-9 px-2 rounded-lg bg-error-container text-on-error-container text-title-md font-semibold tabular-nums flex-shrink-0">
                  {a.count}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-body-md text-on-surface font-medium truncate">
                    {a.title}
                  </span>
                  <span className="block text-body-sm text-on-surface-variant truncate">
                    {a.detail}
                    {a.runAt && <span> · checked {formatTimeAgo(a.runAt)}</span>}
                  </span>
                </span>
                <ArrowRight className="w-4 h-4 text-on-surface-variant group-hover:text-primary group-hover:translate-x-0.5 transition-all flex-shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
