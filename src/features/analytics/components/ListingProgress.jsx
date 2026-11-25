import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Download, ListChecks } from 'lucide-react';
import { Columns, DeltaChip, Meter, Sparkline } from './charts';
import ListingsDialog from './ListingsDialog';
import { compact } from '../lib/weekly';
import { BAD_UNDER, change, issuesByCheck, progressScopes, scopeInWeek, sumStandings, sumWeekly, weeklyStandings } from '../lib/progress';
import { startTask } from '@/lib/taskProgress';

// Progress to 100% (user, 2026-11-25): how the PIM and every marketplace
// stand — listings at 100%, how many are left, how many are bad, the open
// issues — week by week, and which listings are left. Read from the daily
// snapshots only (lib/progress.js); a marketplace's at 100% and issue counts
// are kept since 2026-11-25, so its weeks before that show a dash.

const num = (v) => (v == null ? '—' : v.toLocaleString('en-CA'));
const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`;
const issuePoints = (series) => series.map((p) => ({ label: p.label, range: p.range, value: p.standing?.issues ?? null }));

export default function ListingProgress({ index, week, names }) {
  const [open, setOpen] = useState(null);
  const [list, setList] = useState(null); // { scope, filter }
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  // What opens under a row keeps to the part of the table in view: on a phone
  // the table scrolls sideways and its cells are wider than the screen.
  const boxRef = useRef(null);
  const [boxWidth, setBoxWidth] = useState(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setBoxWidth(box.clientWidth));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const scopes = useMemo(() => progressScopes(index), [index]);
  const rows = useMemo(() => scopes.map((scope) => {
    const series = weeklyStandings(index, scope);
    return { ...scopeInWeek(index, scope, week), series };
  }), [scopes, index, week]);

  // The PIM, the marketplaces, and the marketplaces added up.
  const { pim, channels, all } = useMemo(() => {
    const list = rows.filter((r) => r.scope.kind === 'channel');
    return {
      pim: rows.find((r) => r.scope.kind === 'pim') ?? null,
      channels: list,
      all: list.length ? {
        now: sumStandings(list.map((r) => r.now)),
        before: sumStandings(list.map((r) => r.before)),
        series: sumWeekly(list.map((r) => r.series)),
      } : null,
    };
  }, [rows]);

  if (rows.length === 0) {
    return (
      <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest px-6 py-10 text-center text-body-sm text-on-surface-variant">
        No snapshot yet. Take the first one to start the history.
      </section>
    );
  }

  async function exportAll(only = null) {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    const task = startTask('Progress to 100% export', { detail: 'Reading the listings…' });
    try {
      const { downloadProgressExcel } = await import('../api/progressExcel');
      const r = await downloadProgressExcel({ week, rows: only ? rows.filter((x) => x.scope.id === only) : rows, names, task });
      task.finish(`${r.fileName} · ${r.listings} listings left`);
    } catch (err) {
      task.fail(err);
      setExportError(err.message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {pim && <IssuesCard title="PIM" noun="product" now={pim.now} before={pim.before} series={pim.series} />}
        {all && <IssuesCard title="Marketplaces" noun="listing" now={all.now} before={all.before} series={all.series} count={channels.length} />}
      </div>

      <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
        <header className="px-6 py-4 border-b border-outline-variant flex items-start justify-between gap-4 flex-wrap">
          <div className="max-w-3xl">
            <h3 className="text-title-md text-on-surface">The PIM and each marketplace</h3>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              An issue is one check a listing fails: a field missing in the PIM, or a failed check of the marketplace&apos;s Listing Health. Bad = a score under {BAD_UNDER}. Open a row for its weeks and the listings left.
            </p>
          </div>
          <button type="button" onClick={() => exportAll()} disabled={exporting} aria-busy={exporting} className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-60">
            <Download className="w-4 h-4" aria-hidden="true" />
            {exporting ? 'Exporting…' : 'Export to Excel'}
          </button>
        </header>
        {exportError && <p role="alert" className="px-6 py-3 border-b border-outline-variant bg-error-container text-on-error-container text-body-sm">{exportError}</p>}
        <div ref={boxRef} className="relative overflow-x-auto" tabIndex={0}>
          <table className="w-full min-w-[980px]">
            <thead>
              <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
                <th scope="col" className="text-left px-6 py-3 font-medium">Where</th>
                <th scope="col" className="text-left px-4 py-3 font-medium w-60">At 100%</th>
                <th scope="col" className="text-right px-4 py-3 font-medium">Left</th>
                <th scope="col" className="text-right px-4 py-3 font-medium">Bad</th>
                <th scope="col" className="text-right px-4 py-3 font-medium">Open issues</th>
                <th scope="col" className="text-left px-4 py-3 font-medium">This week</th>
                <th scope="col" className="text-left px-6 py-3 font-medium">Issues, 12 weeks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {rows.map((r) => {
                const isOpen = open === r.scope.id;
                const n = r.now;
                return (
                  <Fragment key={r.scope.id}>
                    <tr onClick={() => setOpen(isOpen ? null : r.scope.id)} className={`cursor-pointer transition-colors ${isOpen ? 'bg-surface-container-low/60' : 'hover:bg-surface-container-low/40'}`}>
                      <td className="px-6 py-3">
                        {/* A button so the row opens from the keyboard too (its click
                            reaches the row's onClick); plain look, no press sink. */}
                        <button type="button" aria-expanded={isOpen} className="w-full flex items-center gap-2 text-left cursor-pointer active:scale-none!">
                          <ChevronDown className={`w-4 h-4 text-on-surface-variant flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                          <span>
                            <span className="block text-body-md text-on-surface font-medium whitespace-nowrap">{r.scope.label}</span>
                            <span className="block text-body-sm text-on-surface-variant tabular-nums whitespace-nowrap">
                              {n?.total != null ? `${num(n.total)} ${plural(n.total, r.scope.noun)}` : 'no snapshot'}
                              {r.scope.kind === 'channel' && n?.linked != null ? ` · ${num(n.linked)} linked` : ''}
                            </span>
                          </span>
                        </button>
                      </td>
                      <StandingCells now={n} before={r.before} />
                      <td className="px-6 py-3"><Sparkline points={issuePoints(r.series)} max={Math.max(1, ...r.series.map((p) => p.standing?.issues ?? 0))} /></td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-surface-container-low/30">
                        <td colSpan={7} className="p-0">
                          <div className="sticky left-0 px-4 sm:px-6 pb-5 pt-2" style={boxWidth ? { width: boxWidth } : undefined}>
                            <ScopeDetail row={r} week={week} onList={(filter) => setList({ scope: r.scope, filter })} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {all?.now && channels.length > 1 && (
                <tr className="bg-surface-container-low/40">
                  <td className="px-6 py-3">
                    <span className="block pl-6 text-body-md text-on-surface font-medium whitespace-nowrap">All marketplaces</span>
                    <span className="block pl-6 text-body-sm text-on-surface-variant tabular-nums whitespace-nowrap">{num(all.now.total)} listings on {channels.length}</span>
                  </td>
                  <StandingCells now={all.now} before={all.before} />
                  <td className="px-6 py-3"><Sparkline points={issuePoints(all.series)} max={Math.max(1, ...all.series.map((p) => p.standing?.issues ?? 0))} /></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {list && (
        <ListingsDialog
          row={rows.find((r) => r.scope.id === list.scope.id)}
          week={week}
          names={names}
          initialFilter={list.filter}
          exporting={exporting}
          onExport={() => exportAll(list.scope.id)}
          onClose={() => setList(null)}
        />
      )}
    </>
  );
}

// The five cells every row of the table shares: at 100%, left, bad, open issues, the week's change.
function StandingCells({ now, before }) {
  const tone = now?.pct == null ? 'accent' : now.pct >= 90 ? 'good' : now.pct >= 60 ? 'warn' : 'bad';
  return (
    <>
      <td className="px-4 py-3">
        {now?.complete != null ? (
          <div className="flex items-center gap-3">
            <Meter className="flex-1 min-w-16" pct={now.pct ?? 0} tone={tone} />
            <span className="text-label-md text-on-surface tabular-nums whitespace-nowrap w-28 text-right">{num(now.complete)} · {now.pct}%</span>
          </div>
        ) : <span className="text-body-sm text-on-surface-variant">—</span>}
      </td>
      <td className="px-4 py-3 text-right text-body-md text-on-surface font-medium tabular-nums">{num(now?.left)}</td>
      <td className={`px-4 py-3 text-right text-body-md tabular-nums ${now?.bad ? 'text-error font-medium' : 'text-on-surface'}`}>{num(now?.bad)}</td>
      <td className="px-4 py-3 text-right text-body-md text-on-surface font-medium tabular-nums">{num(now?.issues)}</td>
      <td className="px-4 py-3 whitespace-nowrap">
        <WeekChange now={now} before={before} />
      </td>
    </>
  );
}

// The open issues against the start of the week. A marketplace's issues are
// counted since late November 2026: its first week has nothing to compare with.
function WeekChange({ now, before }) {
  if (now?.issues == null) return <span className="text-body-sm text-on-surface-variant">—</span>;
  if (before && before.issues == null) return <span className="text-label-md text-on-surface-variant">first week counted</span>;
  return <DeltaChip value={change(now, before, 'issues')} upIsGood={false} vs="week start" />;
}

// One headline: the open issues of the PIM, or of every marketplace together,
// with the week's change and the last 12 weeks.
function IssuesCard({ title, noun, now, before, series, count = null }) {
  const known = now?.issues != null;
  const left = now?.left;
  return (
    <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-x-6 gap-y-4 items-end">
      <div>
        <p className="text-label-md text-on-surface-variant uppercase tracking-wider">{title} · open issues</p>
        <p className="mt-2 text-[44px] leading-none font-semibold text-on-surface tabular-nums">{known ? compact(now.issues) : '—'}</p>
        <div className="mt-3">
          {known ? <WeekChange now={now} before={before} /> : <span className="text-label-md text-on-surface-variant">counted from the next snapshot</span>}
        </div>
        <p className="mt-3 text-body-sm text-on-surface-variant">
          {left != null
            ? <><span className="text-on-surface font-medium tabular-nums">{num(left)}</span> of {num(now.total)} {plural(now.total, noun)} left to reach 100%{now.bad != null ? <> · <span className={now.bad ? 'text-error font-medium tabular-nums' : 'tabular-nums'}>{num(now.bad)}</span> bad</> : null}</>
            : now?.bad != null ? <><span className={now.bad ? 'text-error font-medium tabular-nums' : 'tabular-nums'}>{num(now.bad)}</span> bad of {num(now.total)} {plural(now.total, noun)}</> : 'No snapshot yet.'}
          {count ? ` · ${count} marketplaces` : ''}
        </p>
      </div>
      <div>
        <Columns points={issuePoints(series)} ariaLabel={`${title}: open issues at the end of each week`} format={(v) => v.toLocaleString('en-CA')} />
        <p className="text-label-md text-on-surface-variant text-center">Open issues at the end of each week</p>
      </div>
    </div>
  );
}

// What opens under a row: its weeks, what fails most, and the way to the listings.
function ScopeDetail({ row, week, onList }) {
  const { scope, now, before, series } = row;
  const [allChecks, setAllChecks] = useState(false);
  const checks = issuesByCheck(scope, now, before);
  const shown = allChecks ? checks : checks.slice(0, 8);
  // Newest week first; each one against the week before it that has numbers.
  const weeks = series.map((p, i) => {
    let prev = null;
    for (let k = i - 1; k >= 0 && !prev; k--) prev = series[k].standing;
    return { ...p, prev };
  }).filter((p) => p.standing).reverse().slice(0, 8);
  const healthTab = scope.kind === 'pim' ? 'pim' : scope.key;

  return (
    <div className="animate-banner-in grid grid-cols-1 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] gap-x-8 gap-y-6">
      <div>
        <p className="text-label-md font-semibold uppercase tracking-wider text-on-surface-variant mb-2">Week by week</p>
        {weeks.length === 0 ? <p className="text-body-sm text-on-surface-variant">No snapshot in the last 12 weeks.</p> : (
          <div className="relative overflow-x-auto rounded-xl border border-outline-variant bg-surface-container-lowest" tabIndex={0}>
            <table className="w-full min-w-[300px]">
              <thead>
                <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
                  <th scope="col" className="text-left px-3 sm:px-4 py-2 font-medium">Week</th>
                  <th scope="col" className="text-right px-2 sm:px-3 py-2 font-medium">At 100%</th>
                  <th scope="col" className="text-right px-2 sm:px-3 py-2 font-medium">Left</th>
                  <th scope="col" className="text-right px-2 sm:px-3 py-2 font-medium">Bad</th>
                  <th scope="col" className="text-right px-2 sm:px-3 py-2 font-medium">Issues</th>
                  <th scope="col" className="text-right px-3 sm:px-4 py-2 font-medium">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {weeks.map((p) => {
                  const s = p.standing;
                  const d = change(s, p.prev, 'issues');
                  const selected = p.key === week.key;
                  return (
                    <tr key={p.key} className={selected ? 'bg-primary-container/30' : undefined}>
                      <th scope="row" className="text-left px-3 sm:px-4 py-2 font-normal whitespace-nowrap">
                        <span className="text-body-sm text-on-surface font-medium" title={p.range}>{p.label}</span>
                        <span className="hidden sm:inline text-body-sm text-on-surface-variant"> · {p.range}</span>
                      </th>
                      <td className="px-2 sm:px-3 py-2 text-right text-body-sm text-on-surface tabular-nums whitespace-nowrap">{s.complete != null ? <>{num(s.complete)}<span className="hidden sm:inline text-on-surface-variant"> · {s.pct}%</span></> : '—'}</td>
                      <td className="px-2 sm:px-3 py-2 text-right text-body-sm text-on-surface tabular-nums">{num(s.left)}</td>
                      <td className={`px-2 sm:px-3 py-2 text-right text-body-sm tabular-nums ${s.bad ? 'text-error font-medium' : 'text-on-surface'}`}>{num(s.bad)}</td>
                      <td className="px-2 sm:px-3 py-2 text-right text-body-sm text-on-surface font-medium tabular-nums">{num(s.issues)}</td>
                      <td className="px-3 sm:px-4 py-2 text-right text-body-sm tabular-nums whitespace-nowrap"><Signed value={d} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {scope.kind === 'channel' && weeks.some((p) => p.standing.issues == null) && (
          <p className="mt-2 text-body-sm text-on-surface-variant">A marketplace&apos;s listings at 100% and its issues are counted since late November 2026: the weeks before show a dash.</p>
        )}
      </div>

      <div>
        <p className="text-label-md font-semibold uppercase tracking-wider text-on-surface-variant mb-2">Failing most</p>
        {now?.byCheck == null ? (
          <p className="text-body-sm text-on-surface-variant">Counted from the next snapshot.</p>
        ) : checks.length === 0 ? (
          <p className="text-body-sm text-on-surface">Nothing fails: every {scope.noun} is at 100%.</p>
        ) : (
          <ul className="space-y-1.5">
            {shown.map((c) => (
              <li key={c.key} className="flex items-baseline justify-between gap-3 text-body-sm">
                <span className="min-w-0">
                  <span className="text-on-surface">{c.label}</span>
                  {c.where && <span className="text-on-surface-variant"> · {c.where}</span>}
                </span>
                <span className="flex items-baseline gap-2 whitespace-nowrap tabular-nums">
                  <Signed value={c.delta} quiet />
                  <span className="text-on-surface font-medium w-10 text-right">{num(c.count)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {checks.length > 8 && (
          <button type="button" onClick={() => setAllChecks((v) => !v)} aria-expanded={allChecks} className="mt-2 py-1 text-label-md text-primary font-semibold hover:underline">
            {allChecks ? 'Show the top 8' : `Show all ${checks.length}`}
          </button>
        )}

        <div className="mt-4 flex items-center gap-2 flex-wrap">
          {now?.left != null && (
            <button type="button" onClick={() => onList('left')} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity">
              <ListChecks className="w-4 h-4" aria-hidden="true" />
              See the {num(now.left)} left to 100%
            </button>
          )}
          {now?.left != null && now.bad > 0 && (
            <button type="button" onClick={() => onList('bad')} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">
              The {num(now.bad)} bad
            </button>
          )}
          <Link to={`/listing-health?tab=${healthTab}`} className="py-1.5 text-label-md text-primary font-semibold hover:underline">Open in Listing Health</Link>
        </div>
      </div>
    </div>
  );
}

// A signed change of the open issues: fewer is the good direction.
function Signed({ value, quiet = false }) {
  if (value == null) return <span className="text-on-surface-variant">{quiet ? '' : '—'}</span>;
  if (value === 0) return <span className="text-on-surface-variant">{quiet ? '' : '0'}</span>;
  return <span className={`font-semibold ${value < 0 ? 'text-success' : 'text-error'}`}>{value > 0 ? '+' : '−'}{Math.abs(value).toLocaleString('en-CA')}</span>;
}
