import { useCallback, useEffect, useState } from 'react';
import { listVariants } from '../api/products';

export function useVariants(sku, familyNumber) {
  const [variants, setVariants] = useState([]);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (familyNumber == null) {
      setVariants([]);
      return;
    }
    let active = true;
    setLoading(true);
    listVariants(familyNumber, sku)
      .then((data) => { if (active) setVariants(data); })
      .catch((err) => { console.error('useVariants:', err); if (active) setVariants([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sku, familyNumber, reloadKey]);

  return { variants, loading, reload };
}
