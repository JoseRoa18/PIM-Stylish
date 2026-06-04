import { useEffect, useState } from 'react';
import { listWixCollections } from '../api/wixSync';

// Module-level cache: collections rarely change and we don't want every
// product detail page to hit the Edge Function. Cleared on hard reload.
let cachedCollections = null;
let inflight = null;

export function useWixCollections() {
  const [collections, setCollections] = useState(cachedCollections ?? []);
  const [loading, setLoading] = useState(!cachedCollections);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (cachedCollections) return;
    let active = true;

    (async () => {
      try {
        // Multiple consumers can mount concurrently — coalesce into one fetch.
        if (!inflight) inflight = listWixCollections();
        const data = await inflight;
        cachedCollections = data;
        if (active) {
          setCollections(data);
          setLoading(false);
        }
      } catch (err) {
        inflight = null;
        if (active) {
          setError(err);
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  return { collections, loading, error };
}

export function invalidateWixCollections() {
  cachedCollections = null;
  inflight = null;
}
