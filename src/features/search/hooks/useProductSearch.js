import { useEffect, useState } from 'react';
import { searchProducts } from '@/features/products/api/products';

/**
 * Debounced product search. Returns latest results for `query`.
 * Pass an empty string to clear and skip the request.
 */
export function useProductSearch(query, { debounceMs = 180, limit = 8 } = {}) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const trimmed = (query ?? '').trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      setError(null);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const handle = setTimeout(async () => {
      try {
        const data = await searchProducts(trimmed, limit);
        if (!cancelled) {
          setResults(data);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err);
          setLoading(false);
          console.error('useProductSearch:', err);
        }
      }
    }, debounceMs);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, debounceMs, limit]);

  return { results, loading, error };
}
