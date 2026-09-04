import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadSnapshots, loadActivityRows, aggregateActivity, loadTargets, loadLaunches, loadPromotions, loadScreenTime } from '../api/kpi';
import { indexSnapshots, recentWeeks, weekBuckets, addDays, weekStart, toDateKey, weekTag, formatShort } from '../lib/weekly';

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
  const [screenRows, setScreenRows] = useState([]);
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
        const [snaps, tg, rows, ln, pr, st] = await Promise.all([
          loadSnapshots(),
          loadTargets(),
          loadActivityRows(from, new Date()),
          loadLaunches(),
          loadPromotions(),
          loadScreenTime(from, new Date()).catch(() => []),
        ]);
        if (!active) return;
        setSnapshots(snaps);
        setTargets(tg);
        setAuditRows(rows);
        setLaunches(ln);
        setPromotions(pr);
        setScreenRows(st);
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

  // Screen time: minutes per person for the selected week (and last week),
  // plus a 12-week series of team minutes.
  const inRange = (r, s, e) => r.day >= toDateKey(s) && r.day <= toDateKey(e);
  const sumByPerson = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const cur = m.get(r.email) ?? { email: r.email, name: r.name, minutes: 0 };
      cur.minutes += r.minutes;
      m.set(r.email, cur);
    }
    return m;
  };
  const screen = useMemo(() => sumByPerson(screenRows.filter((r) => inRange(r, week.start, week.endOfWeek))), [screenRows, week]); // eslint-disable-line react-hooks/exhaustive-deps
  const prevScreen = useMemo(() => sumByPerson(screenRows.filter((r) => inRange(r, addDays(week.start, -7), addDays(week.start, -1)))), [screenRows, week]); // eslint-disable-line react-hooks/exhaustive-deps
  const screenTrend = useMemo(() => {
    const start = weekStart(new Date());
    const out = [];
    for (let i = 11; i >= 0; i--) {
      const s = addDays(start, -7 * i);
      const e = addDays(s, 6);
      out.push({ label: weekTag(s), range: `${formatShort(s)} – ${formatShort(e)}`, value: Math.round(screenRows.filter((r) => inRange(r, s, e)).reduce((a, r) => a + r.minutes, 0) / 6) / 10 });
    }
    return out;
  }, [screenRows]); // eslint-disable-line react-hooks/exhaustive-deps

  return { weeks, week, index, snapshots, targets, setTargets, auditRows, activity, prevActivity, activityTrend, launches, promotions, screen, prevScreen, screenTrend, loading, error, reloadSnapshots };
}
