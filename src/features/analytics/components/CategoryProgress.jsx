import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Target } from 'lucide-react';
import { CATEGORY_LABEL, CHECKS } from '@/features/products/lib/completeness';
import { DeltaChip, Meter, Sparkline } from './charts';
import { formatShort, gapsClosed, projectToTarget, snapshotAt, latestSnapshot, weeklySeries } from '../lib/weekly';

const CHECK_LABEL = Object.fromEntries(CHECKS.map((c) => [c.key, c.label]));

// Per-category progress: where it stands now, how it moved this week, the
// 12-week trend, the target and whether the current pace reaches it.
export default function CategoryProgress({ index, week, targets, canEditTargets, onEditTargets }) {
  const [open, setOpen] = useState(null);
  const cats = [...(index.keys())]
    .filter((k) => k.startsWith('pim_category|'))
    .map((k) => k.split('|')[1]);
  const rows = cats.map((cat) => {
    const now = latestSnapshot(index, 'pim_category', cat);
    const before = snapshotAt(index, 'pim_category', cat, new Date(week.start.getTime() - 1));
    const series = weeklySeries(index, 'pim_category', cat, 'pct');
    const target = targets?.categories?.[cat] ?? null;
    const proj = projectToTarget(series, target);
    return { cat, label: CATEGORY_LABEL[cat] ?? cat, now, before, series, target, proj, closed: gapsClosed(now, before) };
  }).sort((a, b) => (a.now?.metrics?.pct ?? 0) - (b.now?.metrics?.pct ?? 0));

  if (rows.length === 0) {
    return (
      <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest px-6 py-10 text-center text-body-sm text-on-surface-variant">
        No snapshot yet. Take the first one to start the history.
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-title-md text-on-surface">Progress by category</h3>
          <p className="text-body-sm text-on-surface-variant mt-0.5">Products at 100% now, the change since {formatShort(week.start)}, and the pace toward each target.</p>
        </div>
        {canEditTargets && (
          <button type="button" onClick={onEditTargets} className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors">
            <Target className="w-4 h-4" />
            Set targets
          </button>
        )}
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
              <th className="text-left px-6 py-3 font-medium">Category</th>
              <th className="text-left px-6 py-3 font-medium w-64">At 100%</th>
              <th className="text-left px-6 py-3 font-medium">This week</th>
              <th className="text-left px-6 py-3 font-medium">12 weeks</th>
              <th className="text-left px-6 py-3 font-medium">Target</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant">
            {rows.map((r) => {
              const m = r.now?.metrics;
              const isOpen = open === r.cat;
              return (
                <Fragment key={r.cat}>
                  <tr onClick={() => setOpen(isOpen ? null : r.cat)} aria-expanded={isOpen} className={`cursor-pointer transition-colors ${isOpen ? 'bg-surface-container-low/60' : 'hover:bg-surface-container-low/40'}`}>
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-2">
                        <ChevronDown className={`w-4 h-4 text-on-surface-variant flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                        <div>
                          <div className="text-body-md text-on-surface font-medium">{r.label}</div>
                          <div className="text-body-sm text-on-surface-variant tabular-nums">{m ? `${m.complete} of ${m.total}` : 'no snapshot'}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-3">
                        <Meter className="flex-1" pct={m?.pct ?? 0} marker={r.target?.pct ?? null} tone={m ? (m.pct >= 90 ? 'good' : m.pct >= 60 ? 'warn' : 'bad') : 'accent'} />
                        <span className="text-label-md text-on-surface tabular-nums w-10 text-right">{m ? `${m.pct}%` : '—'}</span>
                      </div>
                    </td>
                    <td className="px-6 py-3"><DeltaChip value={m && r.before ? m.complete - r.before.metrics.complete : null} upIsGood vs="week start" /></td>
                    <td className="px-6 py-3"><Sparkline points={r.series} /></td>
                    <td className="px-6 py-3 text-body-sm">
                      {r.target?.pct != null ? (
                        <TargetStatus target={r.target} proj={r.proj} />
                      ) : (
                        <span className="text-on-surface-variant">none</span>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-surface-container-low/30">
                      <td colSpan={5} className="px-6 pb-4 pt-1">
                        <CategoryDetail row={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TargetStatus({ target, proj }) {
  const when = target.date ? ` by ${target.date}` : '';
  if (proj.onTrack === true && proj.eta && proj.eta <= new Date()) {
    return <span className="inline-flex items-center gap-1.5 text-success font-medium"><span className="w-1.5 h-1.5 rounded-full bg-success" />Reached · {target.pct}%{when}</span>;
  }
  if (proj.onTrack === true) {
    return <span className="inline-flex items-center gap-1.5 text-success font-medium"><span className="w-1.5 h-1.5 rounded-full bg-success" />On track · {target.pct}%{when}<span className="text-on-surface-variant font-normal">· reaches it {formatShort(proj.eta)}</span></span>;
  }
  if (proj.onTrack === false) {
    return <span className="inline-flex items-center gap-1.5 text-warning font-medium"><span className="w-1.5 h-1.5 rounded-full bg-warning" />Behind · {target.pct}%{when}<span className="text-on-surface-variant font-normal">{proj.eta ? ` · at this pace ${formatShort(proj.eta)}` : ' · no progress in 12 weeks'}</span></span>;
  }
  return <span className="text-on-surface-variant">{target.pct}%{when} · needs 2 weeks of history</span>;
}

// What changed inside the category this week: gaps closed (and opened), and
// the gaps still most common, each linking to the PIM tab that lists them.
function CategoryDetail({ row }) {
  const missing = Object.entries(row.now?.metrics?.missing ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const closed = row.closed.filter((c) => c.closed > 0).slice(0, 6);
  const opened = row.closed.filter((c) => c.closed < 0).slice(0, 4);
  return (
    <div className="animate-banner-in grid grid-cols-1 md:grid-cols-3 gap-6">
      <div>
        <p className="text-label-md font-semibold uppercase tracking-wider text-on-surface-variant mb-1.5">Closed this week</p>
        {closed.length === 0 ? <p className="text-body-sm text-on-surface-variant">Nothing closed yet this week.</p> : (
          <ul className="space-y-1">{closed.map((c) => <li key={c.key} className="text-body-sm text-on-surface flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-success" />{CHECK_LABEL[c.key] ?? c.key} <span className="text-on-surface-variant">· {c.closed} product{c.closed === 1 ? '' : 's'}</span></li>)}</ul>
        )}
        {opened.length > 0 && (
          <ul className="space-y-1 mt-2">{opened.map((c) => <li key={c.key} className="text-body-sm text-on-surface flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-error" />{CHECK_LABEL[c.key] ?? c.key} <span className="text-on-surface-variant">· {-c.closed} new gap{c.closed === -1 ? '' : 's'}</span></li>)}</ul>
        )}
      </div>
      <div>
        <p className="text-label-md font-semibold uppercase tracking-wider text-on-surface-variant mb-1.5">Still missing most</p>
        {missing.length === 0 ? <p className="text-body-sm text-on-surface-variant">Nothing missing.</p> : (
          <ul className="space-y-1">{missing.map(([k, n]) => <li key={k} className="text-body-sm text-on-surface flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-on-surface-variant" />{CHECK_LABEL[k] ?? k} <span className="text-on-surface-variant">· {n}</span></li>)}</ul>
        )}
      </div>
      <div className="text-body-sm text-on-surface-variant">
        <p>Snapshot {row.now?.snapshot_date ?? '—'}{row.before ? ` · compared with ${row.before.snapshot_date}` : ' · no earlier snapshot to compare'}.</p>
        <Link to="/listing-health?tab=pim" className="inline-block mt-2 text-primary font-semibold hover:underline">Open the live list in Listing Health</Link>
      </div>
    </div>
  );
}
