import { useCallback, useEffect, useRef, useState } from 'react';
import { listActivity } from '../api/activityLog';

/**
 * Load one page of the audit log with the given filters. Re-fetches whenever a
 * filter or the page changes, and resets to page 1 when any filter changes so
 * the user never lands on an out-of-range page. Exposes `count` so the page can
 * render "Showing X–Y of N" and enable/disable the pager.
 */
export function useActivity(filters, page, pageSize) {
  const [events, setEvents] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const { actorId, action, target, search, since } = filters;

  // Monotonic ticket per fetch: when filters change in quick succession the
  // requests race, and a slower stale response must not overwrite the newest.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const { events: rows, count: total } = await listActivity({
        actorId,
        action,
        target,
        search,
        since,
        page,
        pageSize,
      });
      if (ticket !== requestRef.current) return;
      setEvents(rows);
      setCount(total);
    } catch (err) {
      if (ticket !== requestRef.current) return;
      setError(err);
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  }, [actorId, action, target, search, since, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  return { events, count, loading, error, reload: load };
}
