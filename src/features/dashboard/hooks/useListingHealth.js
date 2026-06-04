import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  scoreProduct,
  aggregateStats,
  MARKETPLACES,
  API_MARKETPLACE_KEYS,
} from '../lib/listingHealth';

function extractWixData(wixRaw) {
  if (!wixRaw || typeof wixRaw !== 'object') return null;

  const media = [];
  const mainUrl =
    wixRaw.media?.mainMedia?.image?.url ??
    wixRaw.media?.mainMedia?.thumbnail?.url;
  if (mainUrl) {
    media.push({ media_type: 'image', storage_path: mainUrl, is_primary: true });
  }
  for (const item of wixRaw.media?.items ?? []) {
    const url = item.image?.url ?? item.thumbnail?.url;
    if (!url || url === mainUrl) continue;
    const type = (item.mediaType ?? 'image').toLowerCase();
    media.push({
      media_type: type.includes('video') ? 'video' : 'image',
      storage_path: url,
      is_primary: false,
    });
  }

  return {
    model_name: wixRaw.name ?? null,
    description: wixRaw.description ?? null,
    brand: wixRaw.brand ?? null,
    msrp_cad: typeof wixRaw.price?.price === 'number' ? wixRaw.price.price : null,
    additional_info_sections: Array.isArray(wixRaw.additionalInfoSections)
      ? wixRaw.additionalInfoSections.map((s) => ({
          title: s.title ?? '',
          description: s.description ?? '',
        }))
      : [],
    _wix_media: media,
    _wix_fetched_at: wixRaw._fetched_at ?? null,
  };
}

export function useListingHealth() {
  const [products, setProducts] = useState([]);
  const [byMarketplace, setByMarketplace] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const { data: dbProducts, error: prodErr } = await supabase
          .from('products')
          .select(`
            *,
            product_media (id, storage_path, media_type, is_primary, display_order)
          `);
        if (prodErr) throw prodErr;

        const list = dbProducts ?? [];

        // Enrich each product once with parsed Wix data + base fields
        const enriched = list.map((p) => {
          const wixData = extractWixData(p.wix_raw);
          return {
            sku: p.sku,
            model_name: p.model_name,
            brand: p.brand,
            category: p.category,
            workflow_status: p.workflow_status,
            wix_product_id: p.wix_product_id,
            raw: p,
            wixData,
            hasWixCache: Boolean(wixData),
            pimMedia: p.product_media ?? [],
          };
        });

        // Per-marketplace scoring — only API-connected marketplaces
        const perMarketplaceData = {};
        for (const mkt of API_MARKETPLACE_KEYS) {
          const def = MARKETPLACES[mkt];
          const scores = enriched.map((e) => {
            let product;
            let media;
            if (def.dataSource === 'wix_cache' && e.wixData) {
              product = { ...e.raw, ...e.wixData };
              media = e.wixData._wix_media;
            } else {
              product = e.raw;
              media = e.pimMedia;
            }
            const result = scoreProduct(product, media, mkt);
            return {
              sku: e.sku,
              model_name: e.model_name,
              brand: e.brand,
              category: e.category,
              workflow_status: e.workflow_status,
              wix_product_id: e.wix_product_id,
              has_wix_cache: e.hasWixCache,
              source:
                def.dataSource === 'wix_cache'
                  ? e.hasWixCache ? 'wix_cache' : (e.wix_product_id ? 'pim_fallback' : 'not_linked')
                  : 'pim',
              result,
            };
          });
          const stats = aggregateStats(scores);
          const cachedCount = scores.filter((s) => s.has_wix_cache).length;
          const linkedCount = scores.filter((s) => s.wix_product_id).length;
          perMarketplaceData[mkt] = { products: scores, stats, cachedCount, linkedCount };
        }

        if (active) {
          setProducts(enriched);
          setByMarketplace(perMarketplaceData);
          setLoading(false);
        }
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
