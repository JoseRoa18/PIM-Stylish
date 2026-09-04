import { TrendingDown } from 'lucide-react';
import { CATEGORY_LABEL, CHECKS } from '@/features/products/lib/completeness';
import { gapsClosed, latestSnapshot, snapshotAt } from '../lib/weekly';

const CHECK_LABEL = Object.fromEntries(CHECKS.map((c) => [c.key, c.label]));
const pts = (n) => `${n > 0 ? '+' : ''}${n} pt${Math.abs(n) === 1 ? '' : 's'}`;

/**
 * The week in one paragraph, written from the numbers, plus what got worse.
 * A manager reads this first; everything below is the evidence.
 */
export default function WeekSummary({ index, week, activity }) {
  const now = latestSnapshot(index, 'pim', 'all');
  const before = snapshotAt(index, 'pim', 'all', new Date(week.start.getTime() - 1));
  const cats = [...index.keys()].filter((k) => k.startsWith('pim_category|')).map((k) => k.split('|')[1]);
  const catMoves = cats.map((cat) => {
    const n = latestSnapshot(index, 'pim_category', cat)?.metrics;
    const b = snapshotAt(index, 'pim_category', cat, new Date(week.start.getTime() - 1))?.metrics;
    return { cat, label: CATEGORY_LABEL[cat] ?? cat, dPct: n && b ? n.pct - b.pct : null, dComplete: n && b ? n.complete - b.complete : null };
  }).filter((c) => c.dPct != null);
  const gaps = gapsClosed(now, before);
  const closed = gaps.filter((g) => g.closed > 0);
  const opened = gaps.filter((g) => g.closed < 0);
  const up = catMoves.filter((c) => c.dComplete > 0).sort((a, b) => b.dPct - a.dPct);
  const down = catMoves.filter((c) => c.dComplete < 0).sort((a, b) => a.dPct - b.dPct);

  const parts = [];
  if (now && before) {
    const d = now.metrics.complete - before.metrics.complete;
    parts.push(`${d >= 0 ? '+' : ''}${d} product${Math.abs(d) === 1 ? '' : 's'} at 100% (${now.metrics.complete} of ${now.metrics.total}, ${now.metrics.pct}%)`);
    if (up.length) parts.push(`${up[0].label} ${pts(up[0].dPct)}`);
    if (closed.length) parts.push(`biggest gap closed: ${CHECK_LABEL[closed[0].key] ?? closed[0].key} (${closed[0].closed})`);
  }
  if (activity) {
    parts.push(`${activity.totals.pushes} push${activity.totals.pushes === 1 ? '' : 'es'}`);
    parts.push(`${activity.totals.edits} edit${activity.totals.edits === 1 ? '' : 's'} on ${activity.totals.touched} product${activity.totals.touched === 1 ? '' : 's'}`);
  }
  const sentence = parts.length ? `${week.name}: ${parts.join(' · ')}.` : `${week.name}: no earlier snapshot to compare yet.`;

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6">
      <p className="text-label-md text-on-surface-variant uppercase tracking-wider">This week in one line</p>
      <p className="text-title-lg text-on-surface mt-2 max-w-4xl text-balance">{sentence}</p>
      {(down.length > 0 || opened.length > 0) ? (
        <div className="mt-5 flex items-start gap-3 rounded-xl bg-warning-container/40 px-4 py-3">
          <TrendingDown className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <div className="text-body-sm text-on-surface">
            <p className="font-medium">What got worse</p>
            <ul className="mt-1 space-y-0.5">
              {down.slice(0, 4).map((c) => <li key={c.cat}>{c.label}: {c.dComplete} product{Math.abs(c.dComplete) === 1 ? '' : 's'} at 100% ({pts(c.dPct)})</li>)}
              {opened.slice(0, 4).map((g) => <li key={g.key}>{CHECK_LABEL[g.key] ?? g.key}: {-g.closed} more product{g.closed === -1 ? '' : 's'} missing it</li>)}
            </ul>
          </div>
        </div>
      ) : now && before ? (
        <p className="mt-4 text-body-sm text-on-surface-variant">Nothing got worse this week.</p>
      ) : null}
    </section>
  );
}
