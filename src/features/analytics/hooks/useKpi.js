import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadSnapshots, loadActivityRows, aggregateActivity, loadTargets, loadLaunches, loadPromotions } from '../api/kpi';
import { indexSnapshots, recentWeeks, weekBuckets, addDays, weekStart } from '../lib/weekly';

// Everything the Analytics page needs: the snapshot index (now vs week
// start, trends, aging), 12 weeks of audit rows (bucketed for the team trend
// and sliced for the selected week), launches and promotions.
export function useKpi(weekKey) {
  const weeks = useMemo(() => recentWeeks(8), []);
  const week = weeks.find((w) => w.key === weekKey) ?? weeks[0];
  const [snapshots, setSnapshots] = useState([]);
  const [targets, setTargets] = useState({ global: null, categories: {} });
  const [auditRows, setAuditRows] = useState(null);
  const [launches, setLaunches] = useState([]);
  const [promotions, setPromotions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reloadSnapshots = useCallback(async () => {
    setSnapshots(await loadSnapshots());
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const from = addDays(weekStart(new Date()), -12 * 7);
        const [snaps, tg, rows, ln, pr] = await Promise.all([
          loadSnapshots(),
          loadTargets(),
          loadActivityRows(from, new Date()),
          loadLaunches(),
          loadPromotions(),
        ]);
        if (!active) return;
        setSnapshots(snaps);
        setTargets(tg);
        setAuditRows(rows);
        setLaunches(ln);
        setPromotions(pr);
      } catch (err) {
        if (active) setError(err);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const index = useMemo(() => indexSnapshots(snapshots), [snapshots]);
  const buckets = useMemo(() => (auditRows ? weekBuckets(auditRows, 12) : []), [auditRows]);
  const activity = useMemo(() => {
    if (!auditRows) return null;
    const end = new Date(week.end.getTime() + 86399999);
    return aggregateActivity(auditRows.filter((r) => { const t = new Date(r.occurred_at); return t >= week.start && t <= end; }));
  }, [auditRows, week]);
  const prevActivity = useMemo(() => {
    if (!auditRows) return null;
    const s = addDays(week.start, -7);
    return aggregateActivity(auditRows.filter((r) => { const t = new Date(r.occurred_at); return t >= s && t < week.start; }));
  }, [auditRows, week]);
  const activityTrend = useMemo(() => buckets.map((b) => ({ label: b.label, range: b.range, ...aggregateActivity(b.rows).totals })), [buckets]);

  return { weeks, week, index, snapshots, targets, setTargets, auditRows, activity, prevActivity, activityTrend, launches, promotions, loading, error, reloadSnapshots };
}
