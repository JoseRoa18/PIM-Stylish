import { useMemo, useState } from 'react';
import { AlertCircle, Camera, Download, Info } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { useKpi } from '@/features/analytics/hooks/useKpi';
import { takeSnapshot } from '@/features/analytics/api/kpi';
import { latestSnapshot, snapshotAt, weeklySeries, formatShort } from '@/features/analytics/lib/weekly';
import { CATEGORY_LABEL } from '@/features/products/lib/completeness';
import HeadlineKpis from '@/features/analytics/components/HeadlineKpis';
import CategoryProgress from '@/features/analytics/components/CategoryProgress';
import ChannelCoverage from '@/features/analytics/components/ChannelCoverage';
import TeamActivity from '@/features/analytics/components/TeamActivity';
import TargetsDialog from '@/features/analytics/components/TargetsDialog';
import { LineTrend } from '@/features/analytics/components/charts';
import { formatTimeAgo } from '@/lib/format';

// Weekly KPIs: how the catalog's data completeness, channel coverage and
// team throughput moved this week versus last. Completeness comes from daily
// snapshots (the cron plus "Take snapshot"); activity from the audit log.
export default function Analytics() {
  const { canEdit, role } = useAuth();
  const [weekKey, setWeekKey] = useState(null);
  const { weeks, week, index, snapshots, targets, setTargets, activity, prevActivity, loading, error, reloadSnapshots } = useKpi(weekKey);
  const [snapping, setSnapping] = useState(false);
  const [snapMsg, setSnapMsg] = useState(null);
  const [editingTargets, setEditingTargets] = useState(false);

  const now = latestSnapshot(index, 'pim', 'all');
  const before = snapshotAt(index, 'pim', 'all', new Date(week.start.getTime() - 1));
  const trend = useMemo(() => weeklySeries(index, 'pim', 'all', 'pct'), [index]);
  const categories = useMemo(() => {
    const fromSnaps = [...index.keys()].filter((k) => k.startsWith('pim_category|')).map((k) => k.split('|')[1]);
    return fromSnaps.length ? fromSnaps : Object.keys(CATEGORY_LABEL);
  }, [index]);
  const latestTaken = snapshots.length ? snapshots.reduce((a, r) => (r.taken_at > a ? r.taken_at : a), '') : null;

  async function snapshotNow() {
    setSnapping(true);
    setSnapMsg(null);
    try {
      const r = await takeSnapshot();
      await reloadSnapshots();
      setSnapMsg({ tone: 'ok', text: `Snapshot for ${r.date} saved (${r.rows} rows).` });
    } catch (err) {
      setSnapMsg({ tone: 'error', text: err.message });
    } finally {
      setSnapping(false);
    }
  }

  function exportCsv() {
    const lines = [[week.name, week.range], [], ['Category', 'Products', 'At 100%', 'Share', 'Avg score', `Change since ${week.name} started`]];
    for (const cat of categories) {
      const n = latestSnapshot(index, 'pim_category', cat)?.metrics;
      const b = snapshotAt(index, 'pim_category', cat, new Date(week.start.getTime() - 1))?.metrics;
      lines.push([CATEGORY_LABEL[cat] ?? cat, n?.total ?? '', n?.complete ?? '', n ? `${n.pct}%` : '', n?.avg ?? '', n && b ? n.complete - b.complete : '']);
    }
    lines.push([], ['Catalog', now?.metrics?.total ?? '', now?.metrics?.complete ?? '', now ? `${now.metrics.pct}%` : '', now?.metrics?.avg ?? '', now && before ? now.metrics.complete - before.metrics.complete : '']);
    if (activity) {
      lines.push([], ['Person', 'Products touched', 'Edits', 'Media uploaded', 'Pushes', 'New products']);
      for (const p of activity.people) lines.push([p.name || p.email, p.touched, p.edits, p.uploads, p.pushes, p.creates]);
    }
    const csv = lines.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pim-kpis-${week.year}-${week.tag}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="max-w-7xl mx-auto">
      <header className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-display-lg text-on-surface">Analytics</h1>
          <p className="text-body-md text-on-surface-variant mt-1">{week.name} · {week.range}{week.hint ? ` · ${week.hint}` : ''}. Progress of the catalog's data, channel coverage and the team's work.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-body-sm text-on-surface-variant flex items-center gap-2">
            Week
            <select value={week.key} onChange={(e) => setWeekKey(e.target.value)} className="px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary">
              {weeks.map((w) => <option key={w.key} value={w.key}>{w.name}{w.hint ? ` (${w.hint})` : ''} · {w.range}</option>)}
            </select>
          </label>
          <button type="button" onClick={exportCsv} disabled={loading} className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-60">
            <Download className="w-4 h-4" />
            Export week
          </button>
          {canEdit && (
            <button type="button" onClick={snapshotNow} disabled={snapping} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-body-md font-semibold enabled:hover:opacity-90 transition-opacity disabled:opacity-60">
              <Camera className={`w-4 h-4 ${snapping ? 'animate-pulse' : ''}`} />
              {snapping ? 'Taking snapshot…' : 'Take snapshot'}
            </button>
          )}
        </div>
      </header>

      {snapMsg && (
        <div className={`mb-4 px-4 py-3 rounded-xl text-body-sm flex items-center gap-2 animate-banner-in ${snapMsg.tone === 'ok' ? 'bg-success-container text-on-success-container' : 'bg-error-container text-on-error-container'}`}>
          <Info className="w-4 h-4 flex-shrink-0" />
          {snapMsg.text}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error.message}
        </div>
      )}

      {loading ? (
        <div role="status" aria-label="Loading KPIs" className="animate-pulse space-y-6">
          <div className="h-44 rounded-2xl bg-surface-container" />
          <div className="h-64 rounded-2xl bg-surface-container" />
          <div className="h-80 rounded-2xl bg-surface-container" />
        </div>
      ) : (
        <div className="space-y-6">
          {!now && (
            <div className="rounded-2xl border border-outline-variant bg-surface-container-low px-6 py-5 text-body-md text-on-surface flex items-start gap-3">
              <Camera className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">No snapshot yet. History starts with the first one.</p>
                <p className="text-body-sm text-on-surface-variant mt-0.5">The daily refresh takes one every morning and afternoon; take one now so this week already has a starting point.</p>
              </div>
            </div>
          )}

          <HeadlineKpis now={now} before={before} activity={activity} prevActivity={prevActivity} target={targets?.global} />

          <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6">
            <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
              <div>
                <h3 className="text-title-md text-on-surface">Share of products at 100%, last 12 weeks</h3>
                <p className="text-body-sm text-on-surface-variant mt-0.5">One point per week, the last snapshot of that week. {latestTaken ? `Latest snapshot ${formatTimeAgo(latestTaken)}.` : ''}</p>
              </div>
              {targets?.global?.pct != null && <span className="text-body-sm text-on-surface-variant">Target {targets.global.pct}%{targets.global.date ? ` by ${targets.global.date}` : ''}</span>}
            </div>
            <LineTrend points={trend} ariaLabel="Share of products at 100% per week" />
          </section>

          <CategoryProgress index={index} week={week} targets={targets} canEditTargets={role === 'admin'} onEditTargets={() => setEditingTargets(true)} />
          <ChannelCoverage index={index} week={week} />
          <TeamActivity activity={activity} prevActivity={prevActivity} week={week} />

          <p className="text-body-sm text-on-surface-variant">
            Completeness uses the same rules as the PIM tab in Listing Health. Weeks are numbered the ISO way, Monday to Sunday; "week start" compares with the last snapshot before {week.name} began on {formatShort(week.start)}.
          </p>
        </div>
      )}

      {editingTargets && (
        <TargetsDialog targets={targets} categories={categories} onClose={() => setEditingTargets(false)} onSaved={setTargets} />
      )}
    </div>
  );
}
