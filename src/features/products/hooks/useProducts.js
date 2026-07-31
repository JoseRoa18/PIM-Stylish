import { useState, useEffect, useCallback } from 'react';
import { listProducts } from '../api/products';

// Stale-while-revalidate cache for the catalog list. Re-entering the Catalog
// (or reloading the tab) paints instantly with the last known list while a
// background refetch brings it up to date. Memory covers in-app navigation;
// sessionStorage survives a tab refresh. Cleared when the tab closes.
const CACHE_KEY = 'pim.catalog.products.v1';
let memoryCache = null;

function readCache() {
  if (memoryCache) return memoryCache;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    memoryCache = parsed;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(data) {
  memoryCache = data;
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    // Quota exceeded / private mode — the in-memory cache still works.
  }
}

export function useProducts() {
  const [products, setProducts] = useState(() => readCache() ?? []);
  const [loading, setLoading] = useState(() => readCache() == null);
  const [error, setError] = useState(null);
  const [reloadCount, setReloadCount] = useState(0);

  const reload = useCallback(() => {
    setReloadCount((n) => n + 1);
  }, []);

  // The blocking skeleton only shows on the very first visit of the session
  // (no cache yet, `loading` initialized true). Every later mount or reload()
  // refetches silently behind the already-painted list.
  useEffect(() => {
    let mounted = true;

    listProducts()
      .then((data) => {
        if (!mounted) return;
        writeCache(data);
        setProducts(data);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (!mounted) return;
        console.error('useProducts:', err);
        // With cached data on screen, a failed background refresh shouldn't
        // replace the whole table with an error state — keep showing the list.
        if (readCache() == null) setError(err);
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [reloadCount]);

  return { products, loading, error, reload };
}
