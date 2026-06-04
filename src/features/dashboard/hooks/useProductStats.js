import { useState, useEffect } from 'react';
import { fetchProductStats } from '../api/dashboardQueries';

export function useProductStats() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;

    fetchProductStats()
      .then((data) => {
        if (mounted) {
          setStats(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err);
          setLoading(false);
          console.error('useProductStats:', err);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  return { stats, loading, error };
}