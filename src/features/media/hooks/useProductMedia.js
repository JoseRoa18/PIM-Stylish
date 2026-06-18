import { useState, useEffect, useCallback, useRef } from 'react';
import { listMedia } from '../api/media';

export function useProductMedia(sku) {
  const [media, setMedia] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Tracks which sku we've already loaded, so reload()-triggered refetches
  // (after reorder, set-primary, edits) update silently in the background
  // instead of flashing the skeleton. The skeleton only shows on the first
  // load and when navigating to a different product.
  const loadedSkuRef = useRef(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!sku) return;

    let mounted = true;
    if (loadedSkuRef.current !== sku) setLoading(true);
    setError(null);

    listMedia(sku)
      .then((data) => {
        if (mounted) {
          setMedia(data);
          setLoading(false);
          loadedSkuRef.current = sku;
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err);
          setLoading(false);
          console.error('useProductMedia:', err);
        }
      });

    return () => {
      mounted = false;
    };
  }, [sku, reloadKey]);

  // Replace the in-memory media list without hitting the DB.
  // Used for optimistic updates (e.g. drag-to-reorder, bulk delete).
  const mutate = useCallback((next) => {
    setMedia((prev) => (typeof next === 'function' ? next(prev) : next));
  }, []);

  const primary = media.find((m) => m.is_primary && m.media_type === 'image');
  const images = media.filter((m) => m.media_type === 'image');
  const videos = media.filter((m) => m.media_type === 'video');
  const documents = media.filter((m) => m.media_type === 'document');

  return { media, primary, images, videos, documents, loading, error, reload, mutate };
}