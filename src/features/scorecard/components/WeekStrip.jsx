import { Check, Minus, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { STATUS_FILTERS } from '../lib/status';
import { addWeeks, weekRange, weekTag } from '../lib/weeks';

// The latest week at a glance — how many numbers are in, on target, off
// target, without one — and the filter of the grid below (user, 2026-11-12):
// each counter is a button, pressed it shows only those measurables, pressed
// again all of them. A counter at 0 is left out unless it is the one pressed.

const LOOK = {
  on: { icon: Check, idle: 'bg-success-container/60 text-on-success-container hover:bg-success-container', pressed: 'bg-success text-on-success' },
  off: { icon: X, idle: 'bg-error-container/60 text-on-error-container hover:bg-error-container', pressed: 'bg-error text-on-error' },
  none: { icon: Minus, idle: 'bg-surface-container-high text-on-surface-variant hover:text-on-surface', pressed: 'bg-on-surface text-surface' },
};

export default function WeekStrip({ summary, filter, onFilter }) {
  if (!summary || summary.total === 0) return null;
  const week = weekTag(summary.week);
  return (
    <div className="flex items-center gap-x-2 gap-y-1.5 flex-wrap">
      <span className="font-semibold text-on-surface">{week} · numbers of {weekRange(addWeeks(summary.week, -1))}:</span>
      <span>{summary.filled} of {summary.total} filled</span>
      <div role="group" aria-label={`Show only the measurables that, in ${week}, are`} className="flex items-center gap-1.5 flex-wrap">
        {STATUS_FILTERS.filter((f) => summary[f.key] > 0 || filter === f.key).map((f) => {
          const { icon: Icon, idle, pressed } = LOOK[f.key];
          const on = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={on}
              onClick={() => onFilter(on ? null : f.key)}
              title={on ? 'Show every measurable again' : `Show only the measurables ${f.label} in ${week}`}
              className={cn('inline-flex items-center gap-1 px-2.5 py-1 rounded-full whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40', on ? `${pressed} font-semibold` : idle)}
            >
              <Icon className="w-3 h-3" aria-hidden />
              {summary[f.key]} {f.label}
            </button>
          );
        })}
      </div>
      {filter && (
        <button type="button" onClick={() => onFilter(null)} className="px-1 py-1 text-on-surface underline underline-offset-2 hover:opacity-80 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
          Show all
        </button>
      )}
      {summary.mineEmpty > 0 && <span className="font-semibold text-on-surface"><span aria-hidden className="font-normal text-on-surface-variant">· </span>{summary.mineEmpty} of yours to fill</span>}
    </div>
  );
}

/** What stands in the grid's place when the filter keeps no row. `where` = "of Wayfair · Canada". */
export function NoMatch({ filter, week, where = '', onShowAll }) {
  const f = STATUS_FILTERS.find((x) => x.key === filter);
  return (
    <div role="status" className="rounded-2xl border border-outline-variant bg-surface-container-lowest px-6 py-5 flex items-center justify-between gap-4 flex-wrap">
      <p className="text-body-md text-on-surface">No measurable{where ? ` ${where}` : ''} {f?.none} in {weekTag(week)}.</p>
      <button type="button" onClick={onShowAll} className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">
        Show every measurable
      </button>
    </div>
  );
}
