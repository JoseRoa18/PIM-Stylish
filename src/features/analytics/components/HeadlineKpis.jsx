import { DeltaChip, Meter } from './charts';
import { compact } from '../lib/weekly';

// The week's headline: one hero figure (products at 100%) and three stat
// tiles, each with its change since the start of the selected week.
export default function HeadlineKpis({ now, before, activity, prevActivity, target }) {
  const m = now?.metrics ?? null;
  const b = before?.metrics ?? null;
  const d = (k) => (m && b && typeof m[k] === 'number' && typeof b[k] === 'number' ? m[k] - b[k] : null);
  const pushes = activity?.totals?.pushes ?? null;
  const prevPushes = prevActivity?.totals?.pushes ?? null;

  return (
    <section className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr_1fr_1fr] gap-4">
      <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6 flex flex-col justify-between gap-5">
        <div>
          <p className="text-label-md text-on-surface-variant uppercase tracking-wider">Products at 100%</p>
          <div className="mt-2 flex items-baseline gap-3 flex-wrap">
            <span className="text-[52px] leading-none font-semibold text-on-surface">{m ? compact(m.complete) : '—'}</span>
            {m && <span className="text-title-md text-on-surface-variant">of {compact(m.total)} · {m.pct}%</span>}
          </div>
          <div className="mt-3"><DeltaChip value={d('complete')} upIsGood vs="week start" /></div>
        </div>
        <div>
          <Meter pct={m?.pct ?? 0} marker={target?.pct ?? null} tone={m ? (m.pct >= 90 ? 'good' : m.pct >= 60 ? 'warn' : 'bad') : 'accent'} />
          <p className="mt-2 text-body-sm text-on-surface-variant">
            {target?.pct != null ? `Target ${target.pct}%${target.date ? ` by ${target.date}` : ''}` : 'No catalog target set'}
          </p>
        </div>
      </div>

      <Tile label="Average completeness" value={m ? `${m.avg}%` : '—'} delta={d('avg')} suffix=" pts" sub="across every field that applies" />
      <Tile label="Pushes this week" value={pushes ?? '—'} delta={pushes != null && prevPushes != null ? pushes - prevPushes : null} sub={activity ? `${activity.totals.touched} products touched` : 'loading activity'} vs="last week" />
      <Tile label="Products edited" value={activity ? activity.totals.edits : '—'} delta={activity && prevActivity ? activity.totals.edits - prevActivity.totals.edits : null} sub={activity ? `${activity.totals.uploads} media uploaded` : ' '} vs="last week" />
    </section>
  );
}

function Tile({ label, value, delta, suffix = '', sub, vs = 'week start' }) {
  return (
    <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6 flex flex-col gap-3">
      <p className="text-label-md text-on-surface-variant uppercase tracking-wider">{label}</p>
      <p className="text-headline-md font-semibold text-on-surface leading-none">{value}</p>
      <DeltaChip value={delta} suffix={suffix} upIsGood vs={vs} />
      {sub && <p className="text-body-sm text-on-surface-variant">{sub}</p>}
    </div>
  );
}
