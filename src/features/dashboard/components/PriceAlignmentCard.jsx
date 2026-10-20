import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DollarSign, ArrowRight } from 'lucide-react';
import { formatTimeAgo } from '@/lib/format';
import { OVERVIEW_SEGMENTS, alignmentSummary } from '@/features/pricing/lib/alignmentSummary';

/**
 * Price Alignment at a glance, next to the Catalog card (user, 2026-10-01).
 * It reads each channel's LATEST SAVED report — the same loadLatestAlignment
 * the Pricing tab uses (twice-daily cron or a manual "Run analysis") — and
 * pulls nothing from the channels. The analysis module loads with the card,
 * so the Dashboard's first download stays as it was. A row opens Pricing on
 * that channel's alignment.
 */
export default function PriceAlignmentCard() {
  const [state, setState] = useState(null); // { targets, keys, reports } once loaded
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    import('@/features/pricing/api/priceAlignment')
      .then(async ({ ALIGN_TARGETS, ALIGN_TARGET_KEYS, loadLatestAlignment }) => {
        // The channels' own reports show first; the stores read from their
        // pages (one larger read) join when they arrive.
        const load = async (keys) => Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await loadLatestAlignment(k).catch(() => null)])));
        const pageKeys = ALIGN_TARGET_KEYS.filter((k) => ALIGN_TARGETS[k].kind === 'page');
        const apiReports = await load(ALIGN_TARGET_KEYS.filter((k) => ALIGN_TARGETS[k].kind !== 'page'));
        if (!active) return;
        setState({ targets: ALIGN_TARGETS, keys: ALIGN_TARGET_KEYS, reports: apiReports });
        const pageReports = await load(pageKeys);
        if (active) setState((s) => ({ ...s, reports: { ...s.reports, ...pageReports } }));
      })
      .catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);

  // The stores read from their own pages (Where to Buy check) show once they
  // have prices read; the API channels always show.
  const allRows = state ? state.keys.map((key) => ({ key, target: state.targets[key], report: state.reports[key], ...alignmentSummary(state.reports[key]) })) : [];
  const rows = allRows.filter((r) => r.target.kind !== 'page');
  const pageRows = allRows.filter((r) => r.target.kind === 'page' && r.counts && r.total > 0);
  const withReport = [...rows, ...pageRows].filter((r) => r.counts);
  const aligned = withReport.reduce((n, r) => n + r.aligned, 0);
  const comparable = withReport.reduce((n, r) => n + r.comparable, 0);
  const toFix = withReport.reduce((n, r) => n + r.parts.filter((p) => p.key === 'promo_missing' || p.key === 'misaligned').reduce((a, p) => a + p.n, 0), 0);
  const overallPct = comparable > 0 ? Math.round((aligned / comparable) * 100) : null;

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden flex flex-col">
      <Link
        to="/pricing"
        state={{ pricingTab: 'alignment' }}
        className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-2 hover:bg-surface-container-low/40 transition-colors group"
      >
        <div className="flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-on-surface-variant" />
          <h2 className="text-title-md text-on-surface">Price Alignment</h2>
        </div>
        <span className="inline-flex items-center gap-1 text-label-md text-primary">
          Open price alignment
          <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </span>
      </Link>

      {error ? (
        <p role="alert" className="px-6 py-6 text-body-sm text-error">{error}</p>
      ) : !state ? (
        <div role="status" aria-label="Loading price alignment" className="px-6 py-5 space-y-3">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} aria-hidden="true" className="flex items-center gap-3">
              <div className="w-28 h-4 rounded bg-surface-container-high animate-pulse" />
              <div className="flex-1 h-2.5 rounded-full bg-surface-container-high animate-pulse" />
              <div className="w-12 h-4 rounded bg-surface-container-high animate-pulse" />
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* All channels together: the share of comparable products at the
              price they should have, and how many need a fix. */}
          <div className="px-6 pt-5 pb-3 flex items-end justify-between gap-4 flex-wrap">
            <div>
              <p className="text-headline-md text-on-surface tabular-nums leading-none">{overallPct != null ? `${overallPct}%` : '—'}</p>
              <p className="text-label-md text-on-surface-variant mt-1.5">
                aligned across {withReport.length} channel{withReport.length === 1 ? '' : 's'}
                {comparable > 0 && <> · <span className="tabular-nums">{aligned}/{comparable}</span></>}
              </p>
            </div>
            {toFix > 0 && (
              <p className="text-label-md text-on-surface-variant">
                <span className="text-on-surface font-semibold tabular-nums">{toFix}</span> to fix
              </p>
            )}
          </div>

          <div className="px-6 pb-2 flex items-center gap-3 flex-wrap">
            {OVERVIEW_SEGMENTS.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5 text-label-md text-on-surface-variant">
                <span className={`w-2 h-2 rounded-full border border-outline-variant/60 ${s.cls}`} />
                {s.label}
              </span>
            ))}
          </div>

          {[{ key: 'api', heading: null, list: rows }, { key: 'page', heading: 'Read from the store pages', list: pageRows }].filter((g) => g.list.length).map((g) => (
            <div key={g.key} className={g.heading ? 'border-t border-outline-variant/60 pt-2' : ''}>
              {g.heading && <p className="px-6 pb-1 text-label-md text-on-surface-variant">{g.heading}</p>}
              <ul className="px-4 pb-4 flex-1 space-y-0.5" aria-label={g.heading ?? 'Channels'}>
                {g.list.map(({ key, target, report, counts, parts, total, comparable: rowComparable, aligned: rowAligned, pct }) => {
                  const breakdown = counts
                    ? parts.filter((p) => p.n > 0).map((p) => `${p.label}: ${p.n}`).join(' · ')
                    : 'no saved report yet';
                  const updated = report?.ranAt ? `${target.kind === 'page' ? 'read' : 'updated'} ${formatTimeAgo(report.ranAt)}` : null;
                  return (
                    <li key={key}>
                      <Link
                        to="/pricing"
                        state={{ pricingTab: 'alignment', alignSite: key }}
                        title={`${target.label} — ${breakdown}${updated ? ` · ${updated}` : ''}`}
                        className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-surface-container-low transition-colors"
                      >
                        <span className="w-32 flex-shrink-0 truncate text-label-lg text-on-surface">
                          {target.short}
                          <span className="block text-label-md text-on-surface-variant font-normal">{target.priceShort}</span>
                        </span>
                        <span className="flex-1 flex h-2.5 rounded-full overflow-hidden bg-surface-container gap-[2px]" aria-hidden="true">
                          {total > 0
                            ? parts.filter((p) => p.n > 0).map((p) => (
                                <span key={p.key} className={`${p.cls} h-full`} style={{ width: `${(p.n / total) * 100}%` }} />
                              ))
                            : <span className="h-full w-full bg-surface-container" />}
                        </span>
                        <span className="sr-only">{`${pct != null ? `${pct}% aligned. ` : ''}${breakdown}${updated ? `, ${updated}` : ''}`}</span>
                        <span className="w-16 flex-shrink-0 text-right tabular-nums text-label-lg text-on-surface" aria-hidden="true">
                          {pct != null ? `${pct}%` : '—'}
                          <span className="block text-label-md text-on-surface-variant font-normal">
                            {counts ? `${rowAligned}/${rowComparable}` : 'no report'}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          <p className="px-6 py-3 border-t border-outline-variant text-label-md text-on-surface-variant mt-auto">
            From each channel's last saved report — nothing is re-checked here.
          </p>
        </>
      )}
    </section>
  );
}
