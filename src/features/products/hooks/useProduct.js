import { useState, useEffect, useCallback } from 'react';
import { getProduct } from '../api/products';

export function useProduct(sku) {
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const data = await getProduct(sku);
      if (data === null) setNotFound(true);
      else setProduct(data);
    } catch (err) {
      setError(err);
      console.error('useProduct:', err);
    } finally {
      setLoading(false);
    }
  }, [sku]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await getProduct(sku);
        if (!active) return;
        if (data === null) setNotFound(true);
        else setProduct(data);
      } catch (err) {
        if (!active) return;
        setError(err);
        console.error('useProduct:', err);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [sku]);

  // Optimistically merge a patch into the in-memory product without a refetch.
  const mergeProduct = useCallback((patch) => {
    setProduct((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  return { product, loading, error, notFound, refetch: load, mergeProduct };
}