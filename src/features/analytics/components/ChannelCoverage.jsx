import { MARKETPLACES } from '@/features/dashboard/lib/listingHealth';
import { DeltaChip, Meter, Sparkline } from './charts';
import { latestSnapshot, snapshotAt, weeklySeries } from '../lib/weekly';
import SCORE_BADGE_STYLES from '@/lib/scoreBadgeStyles';
import { categorizeScore } from '@/features/dashboard/lib/listingHealth';

// Coverage per channel: how many products are linked and how healthy the
// listings score, with the change since the week started.
export default function ChannelCoverage({ index, week }) {
  const keys = [...(index.keys())].filter((k) => k.startsWith('channel|')).map((k) => k.split('|')[1]);
  if (keys.length === 0) return null;
  const rows = keys.map((key) => {
    const now = latestSnapshot(index, 'channel', key);
    const before = snapshotAt(index, 'channel', key, new Date(week.start.getTime() - 1));
    return { key, label: MARKETPLACES[key]?.label ?? key, now, before, series: weeklySeries(index, 'channel', key, 'avg') };
  }).sort((a, b) => (b.now?.metrics?.linked ?? 0) - (a.now?.metrics?.linked ?? 0));

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant">
        <h3 className="text-title-md text-on-surface">Channel coverage</h3>
        <p className="text-body-sm text-on-surface-variant mt-0.5">Products linked per channel and the average listing score, from the latest snapshot.</p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px]">
          <thead>
            <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
              <th className="text-left px-6 py-3 font-medium">Channel</th>
              <th className="text-left px-6 py-3 font-medium w-64">Linked</th>
              <th className="text-left px-6 py-3 font-medium">This week</th>
              <th className="text-right px-6 py-3 font-medium">Avg score</th>
              <th className="text-left px-6 py-3 font-medium">12 weeks</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant">
            {rows.map((r) => {
              const m = r.now?.metrics;
              const pct = m?.total ? Math.round((m.linked / m.total) * 100) : 0;
              return (
                <tr key={r.key}>
                  <td className="px-6 py-3 text-body-md text-on-surface font-medium">{r.label}</td>
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-3">
                      <Meter className="flex-1" pct={pct} />
                      <span className="text-label-md text-on-surface tabular-nums w-24 text-right">{m ? `${m.linked} of ${m.total}` : '—'}</span>
                    </div>
                  </td>
                  <td className="px-6 py-3"><DeltaChip value={m && r.before ? m.linked - r.before.metrics.linked : null} upIsGood vs="week start" /></td>
                  <td className="px-6 py-3 text-right">
                    {m ? <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-label-md font-semibold ${SCORE_BADGE_STYLES[categorizeScore(m.avg)]}`}>{m.avg}</span> : '—'}
                  </td>
                  <td className="px-6 py-3"><Sparkline points={r.series} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
