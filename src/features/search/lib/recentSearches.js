// The products a person opened from the top search bar, newest first (user
// idea 2026-10-05) — shown when the empty bar is clicked. Per user and per
// browser: a convenience, not shared data, so it lives in localStorage; a
// blocked storage just keeps the list for the session.

const MAX = 4; // the last 4 opened (user, 2026-10-05)
const keyFor = (userId) => (userId ? `pim:recent-search:${userId}` : null);

function write(userId, list) {
  const key = keyFor(userId);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // storage blocked or full — the in-memory list still works this session
  }
}

/** The stored list (empty when there is none or storage is unreadable). */
export function readRecent(userId) {
  const key = keyFor(userId);
  if (!key) return [];
  try {
    const list = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(list) ? list.filter((x) => x && typeof x.sku === 'string').slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/** Put a product first (once), keeping the newest MAX; returns the new list. */
export function rememberRecent(userId, product, list) {
  const item = {
    sku: product.sku,
    model_name: product.model_name ?? null,
    brand: product.brand ?? null,
    category: product.category ?? null,
    image: product.primary_image?.storage_path ?? null,
  };
  const next = [item, ...list.filter((x) => x.sku !== item.sku)].slice(0, MAX);
  write(userId, next);
  return next;
}

export function forgetRecent(userId, sku, list) {
  const next = list.filter((x) => x.sku !== sku);
  write(userId, next);
  return next;
}

export function clearRecent(userId) {
  write(userId, []);
  return [];
}
