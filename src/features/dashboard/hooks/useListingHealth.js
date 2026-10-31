import { useEffect, useState } from 'react';
import { startTask } from '@/lib/taskProgress';
import {
  computeListingHealth,
  persistHealthSummaries,
} from '../api/listingHealthData';

export function useListingHealth() {
  const [products, setProducts] = useState([]);
  const [byMarketplace, setByMarketplace] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    // The page's task card: the reads and the scoring (a run shared with
    // another caller moves the same card). Leaving the page removes it.
    const task = startTask('Listing Health', { silent: true, detail: 'Reading the catalog and channel snapshots…' });
    let settled = false;

    (async () => {
      try {
        const { enriched, perMarketplaceData } = await computeListingHealth({ task });
        settled = true;
        task.finish('Loaded');

        if (active) {
          setProducts(enriched);
          setByMarketplace(perMarketplaceData);
          setLoading(false);
        }

        // Fire-and-forget: keep the Dashboard's summary cache up to date.
        persistHealthSummaries(perMarketplaceData);
      } catch (err) {
        settled = true;
        task.fail(err);
        if (active) {
          setError(err);
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
      if (!settled) task.cancel();
    };
  }, []);

  return { products, byMarketplace, loading, error };
}
