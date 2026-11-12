import { useEffect, useMemo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { COMPANY_BOARD, buildCompanyView } from '../lib/company';
import { loadCompany, saveCompanyValue } from '../api/company';
import { addWeeks, weekRange, weekTag } from '../lib/weeks';
import ScorecardTable from './ScorecardTable';

// The Company tab of the EOS ScoreCard (user, 2026-11-11): the whole company
// in one grid, for its viewers only. Everything in it is added up from the
// marketplace tabs (lib/company.js) except the weekly sales targets, which a
// viewer types here, and the inventory snapshot the database takes.
export default function CompanyBoard({ weeks, thisWeek }) {
  const [data, setData] = useState(null); // { metrics, values, own }
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadCompany(weeks)
      .then((d) => { if (!cancelled) { setError(null); setData(d); } })
      .catch((err) => { if (!cancelled) setError(err); });
    return () => { cancelled = true; };
  }, [weeks]);

  const view = useMemo(() => (data ? buildCompanyView({ ...data, weeks }) : null), [data, weeks]);
  const rows = useMemo(() => view?.groups.flatMap((g) => g.rows) ?? [], [view]);

  async function save(metric, week, parsed) {
    setNotice(null);
    try {
      // a note typed where a number goes is not a target
      if (parsed && parsed.value == null) throw new Error('Type the target as a number.');
      const row = await saveCompanyValue(metric.companyKey, `${metric.name}`, week, parsed ? parsed.value : null);
      setData((prev) => {
        const own = prev.own.filter((r) => !(r.key === metric.companyKey && r.week_start === week));
        if (row) own.push(row);
        return { ...prev, own };
      });
    } catch (err) {
      setNotice(`${metric.name}, ${weekTag(week)}: ${err.message}`);
    }
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
      {notice && (
        <div role="alert" className="mb-4 rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden />
          {notice}
        </div>
      )}
      <ScorecardTable
        board={COMPANY_BOARD}
        metrics={rows}
        groups={view.groups}
        values={view.values}
        weeks={weeks}
        thisWeek={thisWeek}
        canWrite={(m) => Boolean(m.editable)}
        isAdmin={false}
        plain
        onSave={save}
        onEditMetric={() => {}}
      />
      <p className="mt-3 text-body-sm text-on-surface-variant">
        Only the people this tab was opened to see it. Every number comes from the marketplace tabs, so it changes when they do: MAP % and on-time shipping are the average of every marketplace's own percentage; sales list each marketplace and add them up per country — Canada in CAD, the USA in USD, never together. Type a country's weekly target on its row: it stays in force until another week's is typed, and "Total vs target" turns green at 100% or more. Inventory is what Odoo has available now, kept every hour in the column of the week in progress. Each column holds the numbers of the week before it ({weekTag(thisWeek)} = {weekRange(addWeeks(thisWeek, -1))}).
      </p>
    </>
  );
}
