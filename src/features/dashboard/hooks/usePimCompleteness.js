import { useCallback, useEffect, useState } from 'react';
import { computePimCompleteness } from '../api/pimCompleteness';

// Live PIM completeness: recomputed from the catalog on mount and on demand.
export function usePimCompleteness(enabled = true) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await computePimCompleteness());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled && !data) load();
  }, [enabled, data, load]);

  return { data, loading, error, reload: load };
}
