import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle } from 'lucide-react';
import { COMPANY_BOARD, buildCompanyView } from '../lib/company';
import { loadCompany, saveCompanyTarget } from '../api/company';
import { setMetricTarget } from '../api/scorecard';
import { judgedWeek, rowsWithStatus, summarizeWeek } from '../lib/status';
import { addWeeks, weekRange, weekTag } from '../lib/weeks';
import ScorecardTable from './ScorecardTable';
import TargetDialog from './TargetDialog';
import WeekStrip, { NoMatch } from './WeekStrip';

// The Company tab of the EOS ScoreCard (user, 2026-11-11): the whole company
// in one grid, for its viewers only. Every number in it is added up from the
// marketplace tabs (lib/company.js) or is the inventory snapshot the database
// takes: nothing is typed here but the rows' targets.
//
// `stripSlot` is the place in the page's pinned controls where the tab draws
// its week strip; `filter` / `onFilter` are the page's on / off / without a
// target filter (lib/status.js), kept by the page across the tabs.
export default function CompanyBoard({ weeks, thisWeek, isAdmin = false, stripSlot = null, filter = null, onFilter = () => {} }) {
  const [data, setData] = useState(null); // { metrics, values, own, targets }
  const [error, setError] = useState(null);
  const [targeting, setTargeting] = useState(null); // { row, group }: the target being changed

  useEffect(() => {
    let cancelled = false;
    loadCompany(weeks)
      .then((d) => { if (!cancelled) { setError(null); setData(d); } })
      .catch((err) => { if (!cancelled) setError(err); });
    return () => { cancelled = true; };
  }, [weeks]);

  const view = useMemo(() => (data ? buildCompanyView({ ...data, weeks }) : null), [data, weeks]);
  const rows = useMemo(() => view?.groups.flatMap((g) => g.rows) ?? [], [view]);
  const week = judgedWeek(weeks, thisWeek);
  const summary = useMemo(() => (view ? summarizeWeek(rows, view.values, week) : null), [view, rows, week]);
  // the groups with the rows the filter keeps
  const groups = useMemo(
    () => (view?.groups ?? []).map((g) => ({ ...g, rows: rowsWithStatus(g.rows, view.values, week, filter) })).filter((g) => g.rows.length),
    [view, week, filter],
  );

  // A marketplace's row carries its own tab's target — changed there too, by
  // an admin; the rows the tab works out keep theirs here, for its viewers. A
  // country's total has neither: its target is its marketplaces' added up.
  const canEditTarget = (row) => (row.metric ? isAdmin : Boolean(row.target));

  async function saveTarget({ row, group }, target) {
    if (row.metric) {
      const saved = await setMetricTarget(row.metric, target);
      setData((prev) => ({ ...prev, metrics: prev.metrics.map((m) => (m.id === saved.id ? { ...m, goal: saved.goal, goal_op: saved.goal_op } : m)) }));
      return;
    }
    const before = row.target.own ? { goal: row.goal, goal_op: row.goal_op } : null;
    const saved = await saveCompanyTarget(row.target.key, `${group.label} · ${row.name}`, row.unit, target, before);
    setData((prev) => ({ ...prev, targets: [...prev.targets.filter((t) => t.key !== row.target.key), ...(saved ? [saved] : [])] }));
  }

  if (error) {
    return (
      <div role="alert" className="mb-4 rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
        <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden />
        {error.message}
      </div>
    );
  }
  if (!view) return <div role="status" aria-label="Loading the company view" className="animate-pulse rounded-2xl bg-surface-container h-96" />;

  return (
    <>
      {stripSlot && createPortal(<WeekStrip summary={summary} filter={filter} onFilter={onFilter} />, stripSlot)}
      {groups.length ? (
      <ScorecardTable
        board={COMPANY_BOARD}
        metrics={groups.flatMap((g) => g.rows)}
        groups={groups}
        values={view.values}
        weeks={weeks}
        thisWeek={thisWeek}
        canWrite={() => false}
        isAdmin={false}
        plain
        onSave={() => {}}
        onEditMetric={() => {}}
        canEditTarget={canEditTarget}
        onEditTarget={(row, group) => setTargeting({ row, group })}
      />
      ) : (
        <NoMatch filter={filter} week={week} where="of the company view" onShowAll={() => onFilter(null)} />
      )}
      <p className="mt-3 text-body-sm text-on-surface-variant">
        Only the people this tab was opened to see it. Every number comes from the marketplace tabs, so it changes when they do: MAP % and on-time shipping are the average of every marketplace's own percentage; sales list each marketplace and add them up per country — Canada in CAD, the USA in USD, never together. Click a row's Target to set or change it: a closed week turns green when it meets the target and red when it misses it. The counters over the table — on target, off target, without a target — show only those rows when pressed, by the numbers of the week they name. A marketplace's sales row carries the target of its own tab, changed here or there. A country's total takes its marketplaces' targets added up (hover it to see whether one of them has none yet), and "Total vs target" is the total against it, green at 100% or more. Inventory is what Odoo has available now, kept every hour in the column of the week in progress. Each column holds the numbers of the week before it ({weekTag(thisWeek)} = {weekRange(addWeeks(thisWeek, -1))}).
      </p>
      {targeting && (
        <TargetDialog
          metric={targeting.row}
          context={`${COMPANY_BOARD.label} · ${targeting.group.label}`}
          born={targeting.row.target?.born ?? null}
          onSave={(target) => saveTarget(targeting, target)}
          onClose={() => setTargeting(null)}
        />
      )}
    </>
  );
}
