import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Loader2, Check, AlertTriangle, X } from 'lucide-react';
import { subscribeTasks, getTasks, dismissTask } from '@/lib/taskProgress';

// The cards of the long tasks (src/lib/taskProgress.js), bottom right like a
// browser's downloads: the task, what it is doing, its percentage and a bar.
// They stay while the person moves between pages. The other bottom-right
// card (PromoTaskNudge) sits above them: the dock's height is published as
// --task-dock-h. A bar fixed to the bottom (the bulk actions, a sticky
// footer) lifts them above it through useDockClearance (--dock-clear-h).
export default function TaskProgressDock() {
  const all = useSyncExternalStore(subscribeTasks, getTasks);
  const tasks = all.filter((t) => t.shown);
  const dockRef = useRef(null);
  const announced = useRef(new Map());
  const liveRef = useRef(null);

  // Screen readers hear when a task starts, ends or fails — never each percent
  // (written straight into the live region, which is always rendered).
  useEffect(() => {
    const seen = announced.current;
    let say = null;
    for (const t of tasks) {
      if (seen.get(t.id) === t.status) continue;
      seen.set(t.id, t.status);
      if (t.status === 'running') say = `${t.title} started`;
      else if (t.status === 'done') say = `${t.title}: ${t.detail ?? 'done'}`;
      else if (t.status === 'error') say = `${t.title} failed: ${t.detail ?? ''}`;
    }
    for (const id of [...seen.keys()]) if (!tasks.some((t) => t.id === id)) seen.delete(id);
    if (say && liveRef.current) liveRef.current.textContent = say;
  }, [tasks]);

  // Dev hatch: `demoTask()` in the console runs a 6-second fake task
  // (`demoTask(true)` ends it in an error).
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    window.demoTask = async (fail = false) => {
      const { startTask } = await import('@/lib/taskProgress');
      const t = startTask('Demo export', { detail: 'Loading products…' });
      for (let i = 1; i <= 30; i += 1) {
        await new Promise((r) => setTimeout(r, 200));
        t.count(i, 30, `Product ${i} of 30`);
      }
      if (fail) t.fail('Walmart answered 503 — try again'); else t.finish('Downloaded Demo.xlsx');
    };
    return () => { delete window.demoTask; };
  }, []);

  // Room for the dock under the other bottom-right card.
  const any = tasks.length > 0;
  useEffect(() => {
    const root = document.documentElement;
    const el = dockRef.current;
    if (!any || !el) { root.style.setProperty('--task-dock-h', '0px'); return undefined; }
    const set = () => root.style.setProperty('--task-dock-h', `${el.offsetHeight + 8}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.setProperty('--task-dock-h', '0px'); };
  }, [any]);

  return (
    <>
      <div ref={liveRef} role="status" aria-live="polite" className="sr-only" />
      {any && (
        <section
          ref={dockRef}
          aria-label="Tasks in progress"
          data-lenis-prevent
          className="fixed right-4 bottom-[calc(1rem+var(--dock-clear-h,0px))] z-50 w-[22rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem-var(--dock-clear-h,0px))] overflow-y-auto flex flex-col gap-2"
        >
          {tasks.map((t) => <TaskCard key={t.id} task={t} />)}
        </section>
      )}
    </>
  );
}

function TaskCard({ task }) {
  const { id, title, detail, pct, status } = task;
  const running = status === 'running';
  const failed = status === 'error';
  const known = pct != null;
  const shown = known ? Math.round(pct) : null;
  const descId = `task-${id}-detail`;

  return (
    <div
      className={`rounded-2xl border shadow-xl px-4 py-3 animate-menu-in-up ${failed ? 'border-error/40 bg-error-container text-on-error-container' : 'border-outline-variant/70 bg-surface text-on-surface'}`}
    >
      <div className="flex items-center gap-2.5">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${failed ? 'bg-error/15 text-error' : status === 'done' ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-high text-on-surface-variant'}`}>
          {running && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
          {status === 'done' && <Check className="w-4 h-4" aria-hidden="true" />}
          {failed && <AlertTriangle className="w-4 h-4" aria-hidden="true" />}
        </span>
        <p className="min-w-0 flex-1 text-label-lg font-semibold truncate" title={title}>{title}</p>
        {!failed && (
          <span className="text-label-lg font-semibold tabular-nums text-on-surface">
            {known ? `${shown}%` : ''}
          </span>
        )}
        {!running && (
          <button
            type="button"
            onClick={() => dismissTask(id)}
            aria-label={`Close: ${title}`}
            className="p-1 -mr-1 rounded-full hover:bg-on-surface/8 transition-colors"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {!failed && (
        <div
          role="progressbar"
          aria-label={title}
          aria-describedby={detail ? descId : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={known ? shown : undefined}
          aria-valuetext={known ? `${shown}%` : 'Working'}
          className="mt-2.5 h-1.5 rounded-full bg-surface-container-highest overflow-hidden"
        >
          {known ? (
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          ) : (
            <div className="h-full w-2/5 rounded-full bg-primary animate-task-indeterminate motion-reduce:animate-none motion-reduce:w-full motion-reduce:opacity-40" />
          )}
        </div>
      )}

      {detail && (
        <p id={descId} className={`mt-1.5 text-body-sm leading-snug ${failed ? '' : 'text-on-surface-variant truncate'}`} title={failed ? undefined : detail}>
          {detail}
        </p>
      )}
    </div>
  );
}
