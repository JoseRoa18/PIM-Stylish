import { useState, useEffect } from 'react';
import { fetchRecentActivity } from '../api/dashboardQueries';

export function useRecentActivity({ limit = 5 } = {}) {
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;

    fetchRecentActivity({ limit })
      .then((data) => {
        if (mounted) {
          setActivity(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err);
          setLoading(false);
          console.error('useRecentActivity:', err);
        }
      });

    return () => {
      mounted = false;
    };
  }, [limit]);

  return { activity, loading, error };
}