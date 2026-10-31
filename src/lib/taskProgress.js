// The long tasks running in this tab — a download or export, an import or
// upload, a push to a channel — each shown by TaskProgressDock as a card with
// its percentage and what it is doing (user, 2026-10-31: "que salga en
// pantalla cuál es el porcentaje"). Never for a page loading its data (user,
// the same day: "no me gusta que se muestre cuando cargan las páginas"). A plain module, not React state, so the
// api/ and exports/ code that does the work can report from where it loops.
//
//   const task = startTask('Full Report', { detail: 'Loading products…' });
//   const load = task.part(0, 0.6);          // the first 60% of the bar
//   load.count(done, total, 'Loading products…');
//   task.part(0.6, 1).progress(0.5, 'Building the sheets…');
//   task.finish('Downloaded');               // or task.fail(err)
//
// or `await withTask('Full Report', (task) => generate({ onProgress: … }))`.
// A task that ends within SHOW_AFTER_MS never shows (no flash on fast runs);
// a finished card goes away by itself, a failed one stays until closed.

const SHOW_AFTER_MS = 400;
const FINISHED_MS = 4000;
const NOTIFY_MS = 80; // updates from a tight loop reach the screen ~12 times a second

let tasks = [];
let seq = 0;
const listeners = new Set();
let notifyTimer = null;

function notifyNow() {
  notifyTimer = null;
  for (const l of listeners) l();
}
function notify(now = false) {
  if (now) {
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyNow();
  } else if (!notifyTimer) {
    notifyTimer = setTimeout(notifyNow, NOTIFY_MS);
  }
}

function patch(id, fields, now = false) {
  let changed = false;
  tasks = tasks.map((t) => {
    if (t.id !== id) return t;
    changed = true;
    return { ...t, ...fields };
  });
  if (changed) notify(now);
}

function remove(id) {
  const before = tasks.length;
  tasks = tasks.filter((t) => t.id !== id);
  if (tasks.length !== before) notify(true);
}

export function subscribeTasks(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const getTasks = () => tasks;
export const dismissTask = remove;

// Resolves once the browser has painted: work that blocks the page (building
// a sheet, zipping) awaits it after a reading so the card shows it first.
// A hidden tab never paints (requestAnimationFrame waits until it is shown
// again, and its timers are slowed down), so there it resolves at once — an
// export left running in another tab must not stall.
const nextPaint = () => new Promise((resolve) => {
  if (typeof document !== 'undefined' && document.hidden) { resolve(); return; }
  if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 0); return; }
  let settled = false;
  const go = () => { if (!settled) { settled = true; resolve(); } };
  requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, 100); // hidden right after the call: go on anyway
});

// One reporter over a slice [from, to] of the task's bar (shares 0–1 of the
// whole). The bar never moves back: a later, smaller reading is ignored.
function reporter(id, from, to) {
  const at = (share) => from + (to - from) * Math.min(1, Math.max(0, Number(share) || 0));
  const set = (share, detail) => {
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status !== 'running') return;
    const pct = Math.max(t.pct ?? 0, Math.round(at(share) * 1000) / 10);
    patch(id, detail === undefined ? { pct } : { pct, detail });
  };
  const r = {
    /** A share (0–1) of this slice done, with what it is doing now. */
    progress: (share, detail) => set(share, detail),
    /** `done` of `total` items of this slice ("Product 3 of 20"). */
    count: (done, total, detail) => set(total > 0 ? done / total : 0, detail),
    /**
     * Only what it is doing now (the bar stays). Await it before work that
     * blocks the page, so the card shows the new step first.
     */
    step: (detail) => { patch(id, { detail }, true); return nextPaint(); },
    /** Show the latest reading now and wait for the paint (before blocking work). */
    paint: () => { notify(true); return nextPaint(); },
    /** A sub-slice [start, end] (shares 0–1 of THIS slice) for one stage. */
    part: (start, end) => reporter(id, at(start), at(end)),
    /** A callback `(done, total)` for code that already reports counts. */
    counter: (detail) => (done, total) => set(total > 0 ? done / total : 0, typeof detail === 'function' ? detail(done, total) : detail),
  };
  return r;
}

/**
 * Start a task card. `detail` is what it is doing; the bar stays
 * indeterminate (a moving stripe) until the first progress reading.
 */
export function startTask(title, { detail = null } = {}) {
  const id = ++seq;
  tasks = [...tasks, { id, title, detail, pct: null, status: 'running', shown: false, startedAt: Date.now() }];
  setTimeout(() => {
    const t = tasks.find((x) => x.id === id);
    if (t && t.status === 'running') patch(id, { shown: true }, true);
  }, SHOW_AFTER_MS);
  const handle = reporter(id, 0, 1);
  return {
    ...handle,
    id,
    /** Done: the bar fills, the card says so and goes away by itself. */
    finish(detail) {
      const t = tasks.find((x) => x.id === id);
      if (!t || t.status !== 'running') return;
      if (!t.shown) { remove(id); return; }
      patch(id, { status: 'done', pct: 100, detail: detail ?? 'Done', endedAt: Date.now() }, true);
      setTimeout(() => remove(id), FINISHED_MS);
    },
    /** Failed: the card turns red with the reason and stays until closed. */
    fail(error) {
      const t = tasks.find((x) => x.id === id);
      if (!t || t.status !== 'running') return;
      const message = typeof error === 'string' ? error : error?.message ?? 'Something went wrong';
      patch(id, { status: 'error', detail: message, shown: true, endedAt: Date.now() }, true);
    },
    /** Gone without a word (the work was cancelled or had nothing to do). */
    cancel() { remove(id); },
  };
}

/**
 * Run `fn(task)` under a task card: finished when it resolves, failed (and
 * rethrown) when it throws. `finishDetail` may be a function of the result.
 */
export async function withTask(title, fn, { detail, finishDetail } = {}) {
  const task = startTask(title, { detail });
  try {
    const result = await fn(task);
    task.finish(typeof finishDetail === 'function' ? finishDetail(result) : finishDetail);
    return result;
  } catch (err) {
    task.fail(err);
    throw err;
  }
}
