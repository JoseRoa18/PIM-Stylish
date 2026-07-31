import { useEffect, useState } from 'react';
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

    (async () => {
      try {
        const { enriched, perMarketplaceData } = await computeListingHealth();

        if (active) {
          setProducts(enriched);
          setByMarketplace(perMarketplaceData);
          setLoading(false);
        }

        // Fire-and-forget: keep the Dashboard's summary cache up to date.
        persistHealthSummaries(perMarketplaceData);
      } catch (err) {
        if (active) {
          setError(err);
          setLoading(false);
        }
      }
    })();

    return () => { active = false; };
  }, []);

  return { products, byMarketplace, loading, error };
}
