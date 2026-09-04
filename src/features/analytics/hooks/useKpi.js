import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadSnapshots, loadActivity, loadTargets } from '../api/kpi';
import { indexSnapshots, recentWeeks } from '../lib/weekly';

// Everything the Analytics page needs for one selected week: the snapshot
// index (for "now vs week start" and trends), that week's team activity, the
// previous week's activity (for deltas) and the targets.
export function useKpi(weekKey) {
  const weeks = useMemo(() => recentWeeks(8), []);
  const week = weeks.find((w) => w.key === weekKey) ?? weeks[0];
  const [snapshots, setSnapshots] = useState([]);
  const [targets, setTargets] = useState({ global: null, categories: {} });
  const [activity, setActivity] = useState(null);
  const [prevActivity, setPrevActivity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reloadSnapshots = useCallback(async () => {
    setSnapshots(await loadSnapshots());
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [snaps, tg] = await Promise.all([loadSnapshots(), loadTargets()]);
        if (!active) return;
        setSnapshots(snaps);
        setTargets(tg);
      } catch (err) {
        if (active) setError(err);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setActivity(null);
    (async () => {
      try {
        const prevStart = new Date(week.start); prevStart.setDate(prevStart.getDate() - 7);
        const prevEnd = new Date(week.start); prevEnd.setMilliseconds(-1);
        const [cur, prev] = await Promise.all([
          loadActivity(week.start, new Date(week.end.getTime() + 86399999)),
          loadActivity(prevStart, prevEnd),
        ]);
        if (!active) return;
        setActivity(cur);
        setPrevActivity(prev);
      } catch (err) {
        if (active) setError(err);
      }
    })();
    return () => { active = false; };
  }, [week]);

  const index = useMemo(() => indexSnapshots(snapshots), [snapshots]);
  return { weeks, week, index, snapshots, targets, setTargets, activity, prevActivity, loading, error, reloadSnapshots };
}
