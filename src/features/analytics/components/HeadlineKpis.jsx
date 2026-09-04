import { DeltaChip, Meter } from './charts';
import { compact } from '../lib/weekly';

// The week's headline: one hero figure (products at 100%) and three stat
// tiles, each with its change since the start of the selected week.
export default function HeadlineKpis({ now, before, activity, prevActivity, target, onOpen }) {
  const m = now?.metrics ?? null;
  const b = before?.metrics ?? null;
  const d = (k) => (m && b && typeof m[k] === 'number' && typeof b[k] === 'number' ? m[k] - b[k] : null);
  const pushes = activity?.totals?.pushes ?? null;
  const prevPushes = prevActivity?.totals?.pushes ?? null;

  return (
    <section className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr_1fr_1fr] gap-4">
      <button type="button" onClick={() => onOpen?.('complete')} className="text-left rounded-2xl border border-outline-variant bg-surface-container-lowest p-6 flex flex-col justify-between gap-5 hover:border-primary/60 hover:bg-surface-container-low/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" title="See which products reached or left 100%">
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
      </button>

      <Tile label="Average completeness" value={m ? `${m.avg}%` : '—'} delta={d('avg')} suffix=" pts" sub="across every field that applies" onClick={() => onOpen?.('movers')} hint="See the biggest score changes" />
      <Tile label="Pushes this week" value={pushes ?? '—'} delta={pushes != null && prevPushes != null ? pushes - prevPushes : null} sub={activity ? `${activity.totals.touched} products touched${activity.totals.tests ? ` · ${activity.totals.tests} sandbox tests not counted` : ''}` : 'loading activity'} vs="last week" onClick={() => onOpen?.('pushes')} hint="See which products went where" />
      <Tile label="Products edited" value={activity ? activity.totals.edits : '—'} delta={activity && prevActivity ? activity.totals.edits - prevActivity.totals.edits : null} sub={activity ? `${activity.totals.uploads} media uploaded` : ' '} vs="last week" onClick={() => onOpen?.('edits')} hint="See which products were edited" />
    </section>
  );
}

function Tile({ label, value, delta, suffix = '', sub, vs = 'week start', onClick, hint }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} title={hint} className={`text-left rounded-2xl border border-outline-variant bg-surface-container-lowest p-6 flex flex-col gap-3 ${onClick ? 'hover:border-primary/60 hover:bg-surface-container-low/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40' : ''}`}>
      <p className="text-label-md text-on-surface-variant uppercase tracking-wider">{label}</p>
      <p className="text-headline-md font-semibold text-on-surface leading-none">{value}</p>
      <DeltaChip value={delta} suffix={suffix} upIsGood vs={vs} />
      {sub && <p className="text-body-sm text-on-surface-variant">{sub}</p>}
    </Tag>
  );
}
