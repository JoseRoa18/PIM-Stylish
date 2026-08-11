import { useCallback, useSyncExternalStore } from 'react';
import { listMedia, getThumbnailUrl, preloadImage } from '../api/media';

// Media state is shared PER SKU across every hook instance. The product page
// mounts this hook several times at once (header primary image, media grid,
// documents section, marketplaces tab) — with per-instance state, a reload()
// after an upload only refreshed the instance that called it and the header
// kept showing "No image yet" until a full page refresh. One store per SKU
// keeps them all in sync.
const EMPTY_STATE = { media: [], loading: false, error: null };
const stores = new Map(); // sku → { state, listeners, loadedOnce, inFlight, fetchId }

function storeFor(sku) {
  if (!stores.has(sku)) {
    stores.set(sku, {
      state: { media: [], loading: true, error: null },
      listeners: new Set(),
      loadedOnce: false,
      inFlight: false,
      fetchId: 0,
    });
  }
  return stores.get(sku);
}

function setState(s, patch) {
  s.state = { ...s.state, ...patch };
  s.listeners.forEach((l) => l());
}

// Fetch into the store. Refetches update silently in the background (no
// skeleton flash) — the skeleton only shows while a SKU loads the first time.
async function load(sku, { silent = false } = {}) {
  const s = storeFor(sku);
  const id = ++s.fetchId;
  s.inFlight = true;
  if (!silent && !s.loadedOnce) setState(s, { loading: true, error: null });
  try {
    const data = await listMedia(sku);
    if (id !== s.fetchId) return; // a newer fetch superseded this one
    s.loadedOnce = true;
    setState(s, { media: data, loading: false, error: null });
    warmGalleryThumbs(data);
  } catch (err) {
    if (id !== s.fetchId) return;
    console.error('useProductMedia:', err);
    setState(s, { loading: false, error: err });
  } finally {
    if (id === s.fetchId) s.inFlight = false;
  }
}

// Fetch the gallery thumbnails in the background as soon as the media list
// is known, instead of when each <img> mounts — by the time the person
// reaches the Media tab (or scrolls the gallery) the thumbs are already in
// the browser cache. Images only: preloading a video URL would download the
// whole file. Idle-scheduled so it never competes with the page render.
function warmGalleryThumbs(media) {
  const urls = media
    .filter((m) => m.media_type === 'image')
    .slice(0, 24)
    .map((m) => getThumbnailUrl(m.storage_path, 400))
    .filter(Boolean);
  if (!urls.length) return;
  const run = () => urls.forEach(preloadImage);
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 300);
}

/**
 * Warm a product's media before its page opens (hover on a catalog row or a
 * search result): loads the media list into the shared store — so the grid
 * renders instantly — which in turn preloads the gallery thumbnails above.
 */
export function prefetchProductMedia(sku) {
  if (!sku) return;
  const s = storeFor(sku);
  if (!s.loadedOnce && !s.inFlight) load(sku);
}

export function useProductMedia(sku) {
  const subscribe = useCallback(
    (onChange) => {
      if (!sku) return () => {};
      const s = storeFor(sku);
      s.listeners.add(onChange);
      // First subscriber triggers the load; later mounts of an already-loaded
      // SKU refresh silently so cached data can't go stale across visits.
      if (!s.inFlight) load(sku, { silent: s.loadedOnce });
      return () => s.listeners.delete(onChange);
    },
    [sku],
  );
  const getSnapshot = useCallback(() => (sku ? storeFor(sku).state : EMPTY_STATE), [sku]);
  const { media, loading, error } = useSyncExternalStore(subscribe, getSnapshot);

  const reload = useCallback(() => {
    if (sku) load(sku, { silent: true });
  }, [sku]);

  // Replace the in-memory media list without hitting the DB.
  // Used for optimistic updates (e.g. drag-to-reorder, bulk delete).
  const mutate = useCallback(
    (next) => {
      if (!sku) return;
      const s = storeFor(sku);
      setState(s, { media: typeof next === 'function' ? next(s.state.media) : next });
    },
    [sku],
  );

  const primary = media.find((m) => m.is_primary && m.media_type === 'image');
  const images = media.filter((m) => m.media_type === 'image');
  const videos = media.filter((m) => m.media_type === 'video');
  const documents = media.filter((m) => m.media_type === 'document');

  return { media, primary, images, videos, documents, loading, error, reload, mutate };
}
