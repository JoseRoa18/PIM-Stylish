import { useState, useEffect, useCallback } from 'react';
import { listProducts } from '../api/products';

export function useProducts() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadCount, setReloadCount] = useState(0);

  const reload = useCallback(() => {
    setReloadCount((n) => n + 1);
  }, []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);

    listProducts()
      .then((data) => {
        if (mounted) {
          setProducts(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err);
          setLoading(false);
          console.error('useProducts:', err);
        }
      });

    return () => {
      mounted = false;
    };
  }, [reloadCount]);

  return { products, loading, error, reload };
}