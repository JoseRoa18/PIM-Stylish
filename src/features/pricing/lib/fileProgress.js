// The promotion files and pushes on their task card (src/lib/taskProgress.js,
// user 2026-10-31: a percentage on screen for everything slow). Every helper
// takes a reporter or null, so a caller without a card runs exactly as before.

/**
 * The reporter of a loop over `total` items in batches of `size`: call it
 * with the offset of the batch about to run ("Products · batch 2 of 4").
 */
export function batchTicker(task, total, size, label) {
  const n = Math.max(1, Math.ceil(total / size));
  return (offset) => {
    const b = Math.min(n - 1, Math.floor(offset / size));
    task?.count(b, n, n > 1 ? `${label} · batch ${b + 1} of ${n}` : `${label}…`);
  };
}

/**
 * The bar to `share` and the next step shown — awaited before work that
 * blocks the page (filling a sheet, compressing the file), so the card
 * paints it first. A hidden tab never paints (no animation frame), so the
 * wait is capped: a file made while the person is on another tab is not
 * held until they come back. Steps before network work are not awaited.
 */
export async function blockingStep(task, share, detail) {
  if (!task) return;
  task.progress(share);
  await Promise.race([task.step(detail), new Promise((resolve) => { setTimeout(resolve, 100); })]);
}
