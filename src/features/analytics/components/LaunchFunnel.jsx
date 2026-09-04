import { Link } from 'react-router-dom';
import { CATEGORY_LABEL } from '@/features/products/lib/completeness';
import { latestSnapshot, snapshotAt } from '../lib/weekly';
import SCORE_BADGE_STYLES from '@/lib/scoreBadgeStyles';
import { categorizeScore } from '@/features/dashboard/lib/listingHealth';

const STAGES = [
  { key: 'new', label: 'New' },
  { key: 'in_review', label: 'In review' },
  { key: 'ready_to_sell', label: 'Ready to sell' },
];

/**
 * Launch funnel: where products sit in the workflow, what moved to Ready
 * this week, the products created this week and how complete they are now,
 * and the median time from creation to Ready where the dates exist.
 */
export default function LaunchFunnel({ launches, auditRows, index, week }) {
  const now = latestSnapshot(index, 'pim', 'all');
  const before = snapshotAt(index, 'pim', 'all', new Date(week.start.getTime() - 1));
  const counts = Object.fromEntries(STAGES.map((s) => [s.key, launches.filter((p) => p.workflow_status === s.key).length]));
  const beforeCounts = before?.metrics?.workflow ?? null;
  const scores = now?.metrics?.scores ?? {};
  const end = new Date(week.end.getTime() + 86399999);
  const inWeek = (d) => { const t = new Date(d); return t >= week.start && t <= end; };

  const readyThisWeek = launches.filter((p) => p.ready_to_sell_date && inWeek(p.ready_to_sell_date));
  const createdThisWeek = (auditRows ?? [])
    .filter((r) => r.action === 'create' && r.entity_type === 'product' && r.target === 'pim' && inWeek(r.occurred_at))
    .map((r) => launches.find((p) => p.sku === r.entity_id) ?? { sku: r.entity_id, model_name: null, category: null, workflow_status: null })
    .filter((p, i, arr) => arr.findIndex((q) => q.sku === p.sku) === i);

  // Median days from creation to Ready, by category, over products that have both dates in order.
  const spans = launches.filter((p) => p.ready_to_sell_date && p.created_at && new Date(p.ready_to_sell_date) >= new Date(p.created_at))
    .map((p) => ({ cat: p.category, days: Math.round((new Date(p.ready_to_sell_date) - new Date(p.created_at)) / 86400000) }));
  const byCat = {};
  for (const s of spans) (byCat[s.cat] ??= []).push(s.days);
  const medians = Object.entries(byCat).map(([cat, days]) => { const d = [...days].sort((a, b) => a - b); return { cat, label: CATEGORY_LABEL[cat] ?? cat, n: d.length, median: d[Math.floor(d.length / 2)] }; }).sort((a, b) => b.n - a.n);

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant">
        <h3 className="text-title-md text-on-surface">Launches</h3>
        <p className="text-body-sm text-on-surface-variant mt-0.5">Where products sit in the workflow, what reached Ready to sell in {week.name}, and how complete new products are.</p>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-outline-variant">
        {STAGES.map((s) => {
          const d = beforeCounts ? counts[s.key] - (beforeCounts[s.key] ?? 0) : null;
          return (
            <div key={s.key} className="px-6 py-5">
              <p className="text-label-md text-on-surface-variant uppercase tracking-wider">{s.label}</p>
              <p className="text-headline-md font-semibold text-on-surface leading-none mt-2">{counts[s.key]}</p>
              <p className="text-body-sm text-on-surface-variant mt-1">{d == null ? 'no earlier snapshot' : d === 0 ? 'unchanged since week start' : `${d > 0 ? '+' : ''}${d} since week start`}</p>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 border-t border-outline-variant divide-y lg:divide-y-0 lg:divide-x divide-outline-variant">
        <div className="px-6 py-5">
          <p className="text-label-md font-semibold uppercase tracking-wider text-on-surface-variant">Created in {week.name} · {createdThisWeek.length}</p>
          {createdThisWeek.length === 0 ? <p className="text-body-sm text-on-surface-variant mt-2">No products were created this week.</p> : (
            <ul className="mt-2 space-y-1.5">
              {createdThisWeek.slice(0, 8).map((p) => (
                <li key={p.sku} className="flex items-center justify-between gap-3 text-body-sm">
                  <Link to={`/catalog/${p.sku}`} className="text-on-surface hover:text-primary truncate"><span className="font-mono">{p.sku}</span>{p.model_name ? ` · ${p.model_name}` : ''}</Link>
                  {typeof scores[p.sku] === 'number' ? <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-label-md font-semibold ${SCORE_BADGE_STYLES[categorizeScore(scores[p.sku])]}`} title="Completeness now">{scores[p.sku]}</span> : <span className="text-on-surface-variant">not scored yet</span>}
                </li>
              ))}
              {createdThisWeek.length > 8 && <li className="text-body-sm text-on-surface-variant">and {createdThisWeek.length - 8} more</li>}
            </ul>
          )}
        </div>
        <div className="px-6 py-5">
          <p className="text-label-md font-semibold uppercase tracking-wider text-on-surface-variant">Reached Ready to sell in {week.name} · {readyThisWeek.length}</p>
          {readyThisWeek.length === 0 ? <p className="text-body-sm text-on-surface-variant mt-2">No product carries a Ready date in this week.</p> : (
            <ul className="mt-2 space-y-1.5">
              {readyThisWeek.slice(0, 8).map((p) => (
                <li key={p.sku} className="flex items-center justify-between gap-3 text-body-sm">
                  <Link to={`/catalog/${p.sku}`} className="text-on-surface hover:text-primary truncate"><span className="font-mono">{p.sku}</span>{p.model_name ? ` · ${p.model_name}` : ''}</Link>
                  {typeof scores[p.sku] === 'number' && <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-label-md font-semibold ${SCORE_BADGE_STYLES[categorizeScore(scores[p.sku])]}`}>{scores[p.sku]}</span>}
                </li>
              ))}
            </ul>
          )}
          {medians.length > 0 ? (
            <p className="mt-4 text-body-sm text-on-surface-variant">
              Median time from creation to Ready: {medians.slice(0, 4).map((m) => `${m.label} ${m.median} d (${m.n})`).join(' · ')}.
            </p>
          ) : (
            <p className="mt-4 text-body-sm text-on-surface-variant">Time to Ready needs the Ready-to-sell date on products; only {spans.length} carry one today.</p>
          )}
        </div>
      </div>
    </section>
  );
}
