import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, Check, ChevronLeft, ChevronRight, Plus, RefreshCw, X } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { cn } from '@/lib/cn';
import { etToday } from '@/features/pricing/lib/promoCalendar';
import { BOARDS, BOARD_BY_KEY, MARKET_LABEL } from '@/features/scorecard/lib/boards';
import { FIRST_WEEK, addWeeks, spanLabel, weekRange, weekStartOf, weekTag, weeksEnding } from '@/features/scorecard/lib/weeks';
import { meetsGoal } from '@/features/scorecard/lib/format';
import { computeAutoValues, isServerKey } from '@/features/scorecard/lib/autoMetrics';
import { listMetrics, listPeople, listValues, refreshServerNumbers, saveAutoValues, saveValue } from '@/features/scorecard/api/scorecard';
import ScorecardTable from '@/features/scorecard/components/ScorecardTable';
import MetricDialog from '@/features/scorecard/components/MetricDialog';

const WEEKS_SHOWN = 13;
// Opening a tab works its live rows out again unless they were in the last
// 15 minutes (user, 2026-11-10); the crons fill them in between.
const AUTO_FRESH_MS = 15 * 60 * 1000;

// EOS ScoreCard (user, 2026-11-03): the weekly measurables of each
// marketplace, one tab per sheet of the company's scorecard workbook.
export default function Scorecard() {
  const { user, isAdmin, canEdit } = useAuth();
  const [params, setParams] = useSearchParams();
  const boardKey = BOARD_BY_KEY[params.get('board')] ? params.get('board') : BOARDS[0].key;
  const board = BOARD_BY_KEY[boardKey];
  // One market at a time (Canada / USA) when the board sells in both.
  const boardMarkets = Object.keys(board.markets);
  const market = boardMarkets.includes(params.get('market')) ? params.get('market') : boardMarkets[0];
  const thisWeek = weekStartOf();
  // The column of the week in progress (its numbers so far): the grid ends on it.
  const runningWeek = addWeeks(thisWeek, 1);
  const [endWeek, setEndWeek] = useState(runningWeek);
  // Never before W44, where the scorecard starts (FIRST_WEEK). Until 13 weeks
  // have passed the grid is W44 and the 12 weeks after it — the coming ones
  // empty, filled week by week — so it keeps the EOS sheet's 13 columns
  // (user, 2026-11-05: one column alone "se ve horrible"); then it slides.
  const weeks = useMemo(() => {
    const last = weeksEnding(endWeek, WEEKS_SHOWN);
    return last[0] < FIRST_WEEK ? weeksEnding(addWeeks(FIRST_WEEK, WEEKS_SHOWN - 1), WEEKS_SHOWN) : last;
  }, [endWeek]);
  const [metrics, setMetrics] = useState(null);
  const [values, setValues] = useState(() => new Map());
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [auto, setAuto] = useState(null); // { state: 'running' | 'done' | 'error', text }
  const [people, setPeople] = useState([]);
  const [editing, setEditing] = useState(null); // a measurable, or { isNew: true }
  const autoDone = useRef(new Set());
  const boardTabs = useRef(null);
  // The pinned controls: their height (the table's week header pins under
  // them) and whether they are pinned now (a line under them).
  const toolbar = useRef(null);
  const stickSentinel = useRef(null);
  const [toolbarH, setToolbarH] = useState(0);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = toolbar.current;
    if (!el) return undefined;
    // Pinned from lg only: on a phone the controls wrap to a third of the screen.
    const wide = window.matchMedia('(min-width: 1024px)');
    const ro = new ResizeObserver(() => setToolbarH(wide.matches ? el.offsetHeight : 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = stickSentinel.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), { root: document.getElementById('main-content') });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // On a phone the tab row scrolls: keep the chosen marketplace in view.
  useEffect(() => {
    boardTabs.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [boardKey]);

  // The board's measurables and the shown weeks' values.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ms = await listMetrics(boardKey);
        const vals = await listValues(ms.map((m) => m.id), weeks[0], weeks.at(-1));
        if (cancelled) return;
        setError(null);
        setMetrics(ms);
        setValues(vals);
      } catch (err) {
        if (!cancelled) setError(err);
      }
    })();
    return () => { cancelled = true; };
  }, [boardKey, weeks]);

  useEffect(() => {
    if (!isAdmin) return;
    listPeople().then(setPeople).catch(() => {});
  }, [isAdmin]);

  // The browser-side PIM numbers (Price Alignment, promotions) of this week's
  // column and the week in progress: worked out when an editor opens the
  // board, again after 3 h. The server-side ones (Odoo orders, stock, Activity
  // Log) come from the scorecard-fill crons, or "Refresh PIM numbers".
  // Returns how many were saved.
  const fillAuto = useCallback(async (ms, vals, { force = false, report = true } = {}) => {
    const dueIn = (column) => ms.filter((m) => {
      if (!m.auto_key || isServerKey(m.auto_key)) return false;
      const row = vals.get(`${m.id}|${column}`);
      // The row is the PIM's: a number typed or imported this week is replaced.
      if (!row || row.origin !== 'auto') return true;
      return force || Date.now() - new Date(row.updated_at).getTime() > AUTO_FRESH_MS;
    });
    const plan = [thisWeek, runningWeek].map((column) => ({ column, due: dueIn(column) })).filter((p) => p.due.length);
    if (!plan.length) return 0;
    const count = plan.reduce((n, p) => n + p.due.length, 0);
    if (report) setAuto({ state: 'running', text: `Working out ${count} number${count === 1 ? '' : 's'} from the PIM…` });
    try {
      const saved = [];
      for (const { column, due } of plan) {
        const computed = await computeAutoValues(boardKey, due, column, etToday());
        saved.push(...await saveAutoValues(column, [...computed].map(([metricId, value]) => ({ metricId, value }))));
      }
      setValues((prev) => {
        const next = new Map(prev);
        for (const v of saved) next.set(`${v.metric_id}|${v.week_start}`, v);
        return next;
      });
      if (report) setAuto({ state: 'done', text: `${saved.length} number${saved.length === 1 ? '' : 's'} of ${weekTag(thisWeek)} and ${weekTag(runningWeek)} filled from the PIM.` });
      return saved.length;
    } catch (err) {
      if (!report) throw err;
      setAuto({ state: 'error', text: `The PIM's numbers could not be worked out: ${err.message}` });
      return 0;
    }
  }, [boardKey, thisWeek, runningWeek]);

  // "Refresh PIM numbers": the server's (Odoo orders…) and the browser's.
  async function refreshAll() {
    setAuto({ state: 'running', text: board.serverFill ? "Reading Odoo's orders and the PIM…" : 'Working out the PIM numbers…' });
    try {
      let vals = values;
      let n = 0;
      if (board.serverFill) {
        const r = await refreshServerNumbers(boardKey);
        n += r?.written ?? 0;
        vals = await listValues(metrics.map((m) => m.id), weeks[0], weeks.at(-1));
        setValues(vals);
      }
      n += await fillAuto(metrics, vals, { force: true, report: false });
      setAuto({ state: 'done', text: `${n} number${n === 1 ? '' : 's'} of ${weekTag(thisWeek)} and ${weekTag(runningWeek)} filled from the PIM.` });
    } catch (err) {
      setAuto({ state: 'error', text: `The PIM's numbers could not be worked out: ${err.message}` });
    }
  }

  useEffect(() => {
    if (!canEdit || !metrics || !weeks.includes(thisWeek)) return;
    const key = `${boardKey}|${thisWeek}`;
    if (autoDone.current.has(key)) return;
    autoDone.current.add(key);
    fillAuto(metrics, values);
  }, [canEdit, metrics, values, weeks, thisWeek, boardKey, fillAuto]);

  // The PIM's numbers can't be edited (user, 2026-11-04) — not even by an
  // admin; RLS refuses them too. An admin turns "Filled by the PIM" off to type a row.
  const canWrite = (m) => !m.auto_key && (isAdmin || (Boolean(user?.id) && m.owner_id === user.id));

  async function save(metric, week, parsed) {
    setNotice(null);
    try {
      const row = await saveValue(metric, week, parsed);
      setValues((prev) => {
        const next = new Map(prev);
        if (row) next.set(`${metric.id}|${week}`, row);
        else next.delete(`${metric.id}|${week}`);
        return next;
      });
    } catch (err) {
      setNotice({ tone: 'error', text: `${metric.name}, ${weekTag(week)}: ${err.message}` });
    }
  }

  function selectBoard(key) {
    setMetrics(null);
    setAuto(null);
    setParams((p) => { const n = new URLSearchParams(p); n.set('board', key); return n; }, { replace: true });
  }
  function selectMarket(mk) {
    setParams((p) => { const n = new URLSearchParams(p); n.set('market', mk); return n; }, { replace: true });
  }

  const shown = metrics?.filter((m) => !m.market || m.market === market) ?? null;
  const autoRows = metrics?.filter((m) => m.auto_key).length ?? 0;

  // The latest shown week at a glance: how many numbers are in, on and off goal.
  // Never a coming week (until W56 the grid shows them, empty): this week then.
  const summary = (() => {
    if (!shown) return null;
    const week = weeks.at(-1) > thisWeek ? thisWeek : weeks.at(-1);
    const out = { week, total: 0, filled: 0, on: 0, off: 0, noGoal: 0, mineEmpty: 0 };
    for (const m of shown) {
      if (m.unit === 'text') continue;
      const row = values.get(`${m.id}|${week}`);
      const has = Boolean(row && (row.value != null || row.note));
      const ok = meetsGoal(m, row?.value);
      out.total += 1;
      if (has) out.filled += 1;
      if (ok === true) out.on += 1;
      if (ok === false) out.off += 1;
      if (m.goal == null) out.noGoal += 1;
      if (!has && !m.auto_key && user?.id && m.owner_id === user.id) out.mineEmpty += 1;
    }
    return out;
  })();

  return (
    <div style={{ '--sc-toolbar-h': `${toolbarH}px` }}>
      <header className="mb-3 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-display-lg text-on-surface">EOS ScoreCard</h1>
          <p className="text-body-md text-on-surface-variant mt-1">Each marketplace's weekly measurables: owner, goal and {WEEKS_SHOWN} weeks, Sunday to Saturday, from {weekTag(FIRST_WEEK)}.</p>
        </div>
        {isAdmin && (
          <button type="button" onClick={() => setEditing({ isNew: true })} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-body-md font-semibold hover:opacity-90 transition-opacity">
            <Plus className="w-4 h-4" aria-hidden />
            Add measurable
          </button>
        )}
      </header>

      {/* The controls stay pinned while the table scrolls (user, 2026-11-05:
          "fijar los marketplaces … para poder cambiar rápido"): marketplace,
          market, weeks and the week's summary — from lg (on a phone they wrap
          to a third of the screen). Full width of the page's padding; a line
          under it once it is pinned. Its height goes to --sc-toolbar-h (0
          under lg) so the table's week header pins right under it. */}
      <div ref={stickSentinel} aria-hidden className="h-px -mb-px" />
      <div ref={toolbar} className={cn('lg:sticky lg:top-0 lg:z-30 -mx-4 px-4 sm:-mx-8 sm:px-8 pt-3 pb-3 mb-3 bg-background flex flex-col gap-3 transition-shadow', stuck && 'lg:border-b lg:border-outline-variant lg:shadow-sm')}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div ref={boardTabs} role="group" aria-label="Marketplace" className="flex gap-1 max-w-full overflow-x-auto scrollbar-hide rounded-full bg-surface-container-low p-1">
          {BOARDS.map((b) => (
            <button
              key={b.key}
              type="button"
              aria-pressed={b.key === boardKey}
              onClick={() => selectBoard(b.key)}
              className={cn('px-4 py-1.5 rounded-full text-label-md whitespace-nowrap transition-colors', b.key === boardKey ? 'bg-secondary-container text-on-secondary-container font-semibold' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high')}
            >
              {b.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setEndWeek((w) => addWeeks(w, -WEEKS_SHOWN))} disabled={weeks[0] <= FIRST_WEEK} aria-label={`${WEEKS_SHOWN} weeks earlier`} title={`${WEEKS_SHOWN} weeks earlier`} className="inline-flex items-center justify-center w-9 h-9 rounded-full border border-outline-variant text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            <ChevronLeft className="w-4 h-4" aria-hidden />
          </button>
          <span className="px-2 text-body-sm text-on-surface-variant tabular-nums whitespace-nowrap">
            {weeks.length > 1 ? `${weekTag(weeks[0])} – ${weekTag(weeks.at(-1))}` : weekTag(weeks[0])} · {spanLabel(weeks[0], weeks.at(-1))}
          </span>
          <button type="button" onClick={() => setEndWeek((w) => addWeeks(w, WEEKS_SHOWN))} disabled={endWeek >= runningWeek} aria-label={`${WEEKS_SHOWN} weeks later`} title={`${WEEKS_SHOWN} weeks later`} className="inline-flex items-center justify-center w-9 h-9 rounded-full border border-outline-variant text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            <ChevronRight className="w-4 h-4" aria-hidden />
          </button>
          {endWeek !== runningWeek && (
            <button type="button" onClick={() => setEndWeek(runningWeek)} className="ml-1 px-3 py-1.5 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">This week</button>
          )}
        </div>
      </div>
      {metrics && (
          <div className="flex items-center justify-between gap-3 flex-wrap text-body-sm text-on-surface-variant">
            <div className="flex items-center gap-3 flex-wrap">
              {boardMarkets.length > 1 && (
                <div role="group" aria-label="Market" className="flex rounded-full border border-outline-variant p-0.5">
                  {boardMarkets.map((mk) => (
                    <button
                      key={mk}
                      type="button"
                      aria-pressed={mk === market}
                      onClick={() => selectMarket(mk)}
                      className={cn('px-4 py-1 rounded-full text-label-md transition-colors', mk === market ? 'bg-on-surface text-surface font-semibold' : 'text-on-surface-variant hover:text-on-surface')}
                    >
                      {MARKET_LABEL[mk]}
                    </button>
                  ))}
                </div>
              )}
              {summary && summary.total > 0 && (
                <p className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-on-surface">{weekTag(summary.week)} · numbers of {weekRange(addWeeks(summary.week, -1))}:</span>
                  <span>{summary.filled} of {summary.total} filled</span>
                  {summary.on > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success-container text-on-success-container">
                      <Check className="w-3 h-3" aria-hidden />{summary.on} on goal
                    </span>
                  )}
                  {summary.off > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-error-container text-on-error-container">
                      <X className="w-3 h-3" aria-hidden />{summary.off} off goal
                    </span>
                  )}
                  {summary.noGoal > 0 && <span><span aria-hidden>· </span>{summary.noGoal} without a goal</span>}
                  {summary.mineEmpty > 0 && <span className="font-semibold text-on-surface"><span aria-hidden className="font-normal text-on-surface-variant">· </span>{summary.mineEmpty} of yours to fill</span>}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {auto && (
                <span role={auto.state === 'error' ? 'alert' : 'status'} className={auto.state === 'error' ? 'text-error' : ''}>{auto.text}</span>
              )}
              {canEdit && autoRows > 0 && weeks.includes(thisWeek) && (
                <button type="button" onClick={refreshAll} disabled={auto?.state === 'running'} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50">
                  <RefreshCw className={cn('w-3.5 h-3.5', auto?.state === 'running' && 'animate-spin')} aria-hidden />
                  Refresh PIM numbers
                </button>
              )}
            </div>
          </div>
      )}
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden />
          {error.message}
        </div>
      )}
      {notice && (
        <div role="alert" className="mb-4 rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden />
          {notice.text}
        </div>
      )}

      {!metrics && !error ? (
        <div role="status" aria-label="Loading the scorecard" className="animate-pulse rounded-2xl bg-surface-container h-96" />
      ) : metrics && (
        <>
          {shown.length ? (
            <ScorecardTable
              board={board}
              metrics={shown}
              values={values}
              weeks={weeks}
              thisWeek={thisWeek}
              canWrite={canWrite}
              isAdmin={isAdmin}
              onSave={save}
              onEditMetric={setEditing}
            />
          ) : (
            <p className="rounded-2xl border border-outline-variant bg-surface-container-low px-6 py-5 text-body-md text-on-surface">No measurables here yet.</p>
          )}
          <p className="mt-3 text-body-sm text-on-surface-variant">
            Each column holds the numbers of the week before it ({weekTag(thisWeek)} = {weekRange(addWeeks(thisWeek, -1))}), the week reviewed in that week's meeting. Green with a check meets the goal, red with a cross misses it; a measurable without a goal is not colored. The week in progress shows its numbers so far, in italics, updated every 3 hours, and takes no color until it closes. Percentages are typed as percent numbers (95 = 95%). Rows marked PIM fill themselves every week and can't be edited; a dot marks each number the PIM filled.
            {isAdmin ? ' As an admin you can edit every other number; the pencil edits a measurable (owner, goal, theme) — turning "Filled by the PIM" off makes a row typed by hand again.' : ' Every other number is typed by its owner.'}
          </p>
        </>
      )}

      {editing && (
        <MetricDialog
          board={board}
          metric={editing.isNew ? null : editing}
          defaultMarket={market}
          people={people}
          onClose={() => setEditing(null)}
          onSaved={(m) => setMetrics((prev) => (prev.some((x) => x.id === m.id) ? prev.map((x) => (x.id === m.id ? m : x)) : [...prev, m]))}
          onRemoved={(m) => setMetrics((prev) => prev.filter((x) => x.id !== m.id))}
        />
      )}
    </div>
  );
}
