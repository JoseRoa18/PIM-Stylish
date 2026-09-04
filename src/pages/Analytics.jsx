import { useMemo, useState } from 'react';
import { AlertCircle, Camera, ChevronLeft, ChevronRight, Download, Info } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { useKpi } from '@/features/analytics/hooks/useKpi';
import { takeSnapshot } from '@/features/analytics/api/kpi';
import { latestSnapshot, snapshotAt, weeklySeries, formatShort, projectToTarget } from '@/features/analytics/lib/weekly';
import { CATEGORY_LABEL } from '@/features/products/lib/completeness';
import WeekSummary from '@/features/analytics/components/WeekSummary';
import HeadlineKpis from '@/features/analytics/components/HeadlineKpis';
import CategoryProgress from '@/features/analytics/components/CategoryProgress';
import GapAging from '@/features/analytics/components/GapAging';
import LaunchFunnel from '@/features/analytics/components/LaunchFunnel';
import ChannelCoverage from '@/features/analytics/components/ChannelCoverage';
import PromoStatus from '@/features/analytics/components/PromoStatus';
import TeamActivity from '@/features/analytics/components/TeamActivity';
import TeamTrend from '@/features/analytics/components/TeamTrend';
import TargetsDialog from '@/features/analytics/components/TargetsDialog';
import { LineTrend } from '@/features/analytics/components/charts';
import { formatTimeAgo } from '@/lib/format';

// The page reads top to bottom like a weekly report: the week in one line,
// the headline numbers, then the evidence by theme. The section index and
// the week switcher stay pinned so a reader can jump and compare weeks
// without scrolling back up.
const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'quality', label: 'Data quality' },
  { id: 'launches', label: 'Launches' },
  { id: 'channels', label: 'Channels' },
  { id: 'promotions', label: 'Promotions' },
  { id: 'team', label: 'Team' },
];

export default function Analytics() {
  const { canEdit, role } = useAuth();
  const [weekKey, setWeekKey] = useState(null);
  const {
    weeks, week, index, snapshots, targets, setTargets, auditRows, activity, prevActivity, activityTrend,
    launches, promotions, loading, error, reloadSnapshots,
  } = useKpi(weekKey);
  const [snapping, setSnapping] = useState(false);
  const [snapMsg, setSnapMsg] = useState(null);
  const [editingTargets, setEditingTargets] = useState(false);

  const now = latestSnapshot(index, 'pim', 'all');
  const before = snapshotAt(index, 'pim', 'all', new Date(week.start.getTime() - 1));
  const trend = useMemo(() => weeklySeries(index, 'pim', 'all', 'pct'), [index]);
  const trendPoints = trend.filter((p) => typeof p.value === 'number').length;
  const projection = useMemo(() => projectToTarget(trend, targets?.global), [trend, targets]);
  const categories = useMemo(() => {
    const fromSnaps = [...index.keys()].filter((k) => k.startsWith('pim_category|')).map((k) => k.split('|')[1]);
    return fromSnaps.length ? fromSnaps : Object.keys(CATEGORY_LABEL);
  }, [index]);
  const latestTaken = snapshots.length ? snapshots.reduce((a, r) => (r.taken_at > a ? r.taken_at : a), '') : null;
  const weekIndex = weeks.findIndex((w) => w.key === week.key);
  const goWeek = (step) => { const next = weeks[weekIndex + step]; if (next) setWeekKey(next.key); };

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
    const channels = [...index.keys()].filter((k) => k.startsWith('channel|')).map((k) => k.split('|')[1]);
    if (channels.length) {
      lines.push([], ['Channel', 'Linked', 'Products', 'Avg score']);
      for (const c of channels) { const m = latestSnapshot(index, 'channel', c)?.metrics; if (m) lines.push([c, m.linked, m.total, m.avg]); }
    }
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

  const paceNote = targets?.global?.pct != null && now
    ? projection.onTrack === true
      ? `On track for ${targets.global.pct}%${targets.global.date ? ` by ${targets.global.date}` : ''}.`
      : projection.onTrack === false
        ? `Behind the ${targets.global.pct}% target${targets.global.date ? ` for ${targets.global.date}` : ''}${projection.eta ? `; at this pace it lands ${formatShort(projection.eta)}` : ''}.`
        : `Target ${targets.global.pct}%${targets.global.date ? ` by ${targets.global.date}` : ''}; the pace needs two weeks of history.`
    : null;

  return (
    <div className="max-w-7xl mx-auto">
      <header className="mb-4">
        <h1 className="text-display-lg text-on-surface">Analytics</h1>
        <p className="text-body-md text-on-surface-variant mt-1">Weekly progress of the catalog's data, launches, channels, promotions and the team's work.</p>
      </header>

      {/* Pinned: week switcher, section index, actions */}
      <div className="sticky top-0 z-20 -mt-1 mb-6 py-3 bg-background/95 backdrop-blur border-b border-outline-variant flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => goWeek(1)} disabled={weekIndex >= weeks.length - 1} title="Earlier week" aria-label="Earlier week" className="inline-flex items-center justify-center w-9 h-9 rounded-full border border-outline-variant text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <select value={week.key} onChange={(e) => setWeekKey(e.target.value)} aria-label="Week" className="px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface font-medium focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary">
              {weeks.map((w) => <option key={w.key} value={w.key}>{w.name}{w.hint ? ` (${w.hint})` : ''} · {w.range}</option>)}
            </select>
            <button type="button" onClick={() => goWeek(-1)} disabled={weekIndex <= 0} title="Later week" aria-label="Later week" className="inline-flex items-center justify-center w-9 h-9 rounded-full border border-outline-variant text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <nav aria-label="Sections" className="hidden md:flex items-center gap-1">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="px-3 py-1.5 rounded-full text-label-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low transition-colors">{s.label}</a>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
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
      </div>

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
          <div className="h-28 rounded-2xl bg-surface-container" />
          <div className="h-44 rounded-2xl bg-surface-container" />
          <div className="h-64 rounded-2xl bg-surface-container" />
        </div>
      ) : (
        <div className="space-y-10">
          {!now && (
            <div className="rounded-2xl border border-outline-variant bg-surface-container-low px-6 py-5 text-body-md text-on-surface flex items-start gap-3">
              <Camera className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">No snapshot yet. History starts with the first one.</p>
                <p className="text-body-sm text-on-surface-variant mt-0.5">The daily refresh takes one every morning and afternoon; take one now so this week already has a starting point.</p>
              </div>
            </div>
          )}

          <Section id="overview" title="Overview" blurb="The week in one line, the headline numbers, and where the catalog is heading.">
            <WeekSummary index={index} week={week} activity={activity} />
            <HeadlineKpis now={now} before={before} activity={activity} prevActivity={prevActivity} target={targets?.global} />
            <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6">
              <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
                <div>
                  <h3 className="text-title-md text-on-surface">Share of products at 100%, last 12 weeks</h3>
                  <p className="text-body-sm text-on-surface-variant mt-0.5">
                    {trendPoints <= 1 ? `History starts in ${week.name}: one point per week from now on, the last snapshot of each week.` : 'One point per week, the last snapshot of that week.'}
                    {latestTaken ? ` Latest snapshot ${formatTimeAgo(latestTaken)}.` : ''}
                    {paceNote ? ` ${paceNote}` : ''}
                  </p>
                </div>
              </div>
              <LineTrend points={trend} ariaLabel="Share of products at 100% per week" reference={targets?.global?.pct != null ? { value: targets.global.pct, label: `Target ${targets.global.pct}%${targets.global.date ? ` by ${targets.global.date}` : ''}` } : null} />
            </div>
          </Section>

          <Section id="quality" title="Data quality" blurb="Completeness by category against its target, and how long the gaps have been open.">
            <CategoryProgress index={index} week={week} targets={targets} canEditTargets={role === 'admin'} onEditTargets={() => setEditingTargets(true)} />
            <GapAging index={index} />
          </Section>

          <Section id="launches" title="Launches" blurb="The workflow funnel and the products that were created or reached Ready to sell this week.">
            <LaunchFunnel launches={launches} auditRows={auditRows} index={index} week={week} />
          </Section>

          <Section id="channels" title="Channels" blurb="Coverage, listing scores, price alignment and spec sync per marketplace.">
            <ChannelCoverage index={index} week={week} />
          </Section>

          <Section id="promotions" title="Promotions" blurb="Whether the monthly promotion ran on time on each market, and what the automation reported.">
            <PromoStatus promotions={promotions} />
          </Section>

          <Section id="team" title="Team" blurb="What the team did this week, by person, and the pace over the last 12 weeks.">
            <TeamActivity activity={activity} prevActivity={prevActivity} week={week} />
            <TeamTrend trend={activityTrend} />
          </Section>

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

function Section({ id, title, blurb, children }) {
  return (
    <section id={id} className="scroll-mt-24 space-y-4">
      <div>
        <h2 className="text-headline-md text-on-surface">{title}</h2>
        <p className="text-body-sm text-on-surface-variant mt-0.5 max-w-3xl">{blurb}</p>
      </div>
      {children}
    </section>
  );
}
