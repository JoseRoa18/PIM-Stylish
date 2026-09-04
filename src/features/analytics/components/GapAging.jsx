import { Link } from 'react-router-dom';
import { CHECKS } from '@/features/products/lib/completeness';
import { gapAging } from '../lib/weekly';

const CHECK_LABEL = Object.fromEntries(CHECKS.map((c) => [c.key, c.label]));

/**
 * How old the gaps are: a missing spec sheet from three months ago weighs
 * more than one from yesterday. Ages come from consecutive daily snapshots.
 */
export default function GapAging({ index }) {
  const rows = gapAging(index);
  if (rows.length === 0) return null;
  const days = index.get('pim|all')?.filter((r) => r.metrics?.missing_skus).length ?? 0;
  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant">
        <h3 className="text-title-md text-on-surface">How old the gaps are</h3>
        <p className="text-body-sm text-on-surface-variant mt-0.5">Products missing each field and for how long, from {days} daily snapshot{days === 1 ? '' : 's'}. Ages grow as the history does.</p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
              <th className="text-left px-6 py-3 font-medium">Field</th>
              <th className="text-right px-6 py-3 font-medium">Missing</th>
              <th className="text-right px-6 py-3 font-medium">7+ days</th>
              <th className="text-right px-6 py-3 font-medium">30+ days</th>
              <th className="text-left px-6 py-3 font-medium">Oldest</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant">
            {rows.slice(0, 12).map((r) => (
              <tr key={r.key}>
                <td className="px-6 py-3 text-body-md text-on-surface">{CHECK_LABEL[r.key] ?? r.key}</td>
                <td className="px-6 py-3 text-right tabular-nums text-on-surface">{r.count}</td>
                <td className="px-6 py-3 text-right tabular-nums text-on-surface">{r.over7}</td>
                <td className={`px-6 py-3 text-right tabular-nums ${r.over30 > 0 ? 'text-error font-medium' : 'text-on-surface'}`}>{r.over30}</td>
                <td className="px-6 py-3 text-body-sm text-on-surface-variant">
                  {r.oldestSku ? <>{r.oldestDays} day{r.oldestDays === 1 ? '' : 's'} · <Link to={`/catalog/${r.oldestSku}`} className="font-mono text-primary hover:underline">{r.oldestSku}</Link></> : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
