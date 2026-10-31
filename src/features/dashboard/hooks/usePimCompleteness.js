import { useCallback, useEffect, useRef, useState } from 'react';
import { startTask } from '@/lib/taskProgress';
import { computePimCompleteness } from '../api/pimCompleteness';

// Live PIM completeness: recomputed from the catalog on mount and on demand.
export function usePimCompleteness(enabled = true) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  // The task card of the computation running now (removed when the panel
  // goes away before it ends).
  const running = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const task = startTask('PIM completeness', { silent: true, detail: 'Reading the catalog…' });
    running.current = task;
    try {
      const result = await computePimCompleteness({ task });
      setData(result);
      task.finish(`${result.rows.length} products scored`);
    } catch (err) {
      setError(err);
      task.fail(err);
    } finally {
      if (running.current === task) running.current = null;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled && !data) load();
  }, [enabled, data, load]);

  useEffect(() => () => {
    running.current?.cancel();
    running.current = null;
  }, []);

  return { data, loading, error, reload: load };
}
