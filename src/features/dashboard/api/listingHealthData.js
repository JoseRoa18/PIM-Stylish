import { supabase } from '@/lib/supabase';
import {
  scoreProduct,
  aggregateStats,
  MARKETPLACES,
  API_MARKETPLACE_KEYS,
} from '../lib/listingHealth';

/**
 * Shared listing-health computation: pulls the catalog (with media and the
 * latest channel snapshots) and scores every product per marketplace.
 * Used by the Listing Health page (full detail) and by the Dashboard's
 * background revalidation (summaries only) — one implementation, two callers.
 */

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

export async function computeListingHealth() {
  const { data: dbProducts, error: prodErr } = await supabase
    .from('products')
    .select(`
      *,
      product_media (id, storage_path, media_type, is_primary, display_order)
    `);
  if (prodErr) throw prodErr;

  const list = dbProducts ?? [];

  // Latest channel snapshots → per-SKU maps. null map = no snapshot yet
  // (the channel checks treat unknown as pass).
  async function latestSnapshotMap(channel) {
    try {
      const { data: snap } = await supabase
        .from('channel_health')
        .select('results')
        .eq('channel', channel)
        .order('run_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (Array.isArray(snap?.results)) {
        return new Map(snap.results.map((r) => [r.sku, r]));
      }
    } catch {
      // score without sync data rather than failing the page
    }
    return null;
  }
  const wayfairMap = await latestSnapshotMap('wayfair');
  const bestbuyMap = await latestSnapshotMap('bestbuy');
  const walmartMaps = {
    walmart_us: await latestSnapshotMap('walmart_us'),
    walmart_ca: await latestSnapshotMap('walmart_ca'),
  };

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
      } else if (def.dataSource === 'wayfair') {
        product = {
          ...e.raw,
          _wayfairAudit: wayfairMap ? (wayfairMap.get(e.sku) ?? null) : undefined,
        };
        media = e.pimMedia;
      } else if (def.dataSource === 'bestbuy') {
        product = {
          ...e.raw,
          _bbOffer: bestbuyMap ? (bestbuyMap.get(e.sku) ?? null) : undefined,
        };
        media = e.pimMedia;
      } else if (def.dataSource in walmartMaps) {
        const wm = walmartMaps[def.dataSource];
        product = {
          ...e.raw,
          _wmItem: wm ? (wm.get(e.sku) ?? null) : undefined,
        };
        media = e.pimMedia;
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
            : def.dataSource === 'wayfair'
              ? e.raw.wayfair_item_group_id ? 'pim' : 'not_linked'
              : def.dataSource === 'bestbuy'
                ? (bestbuyMap && bestbuyMap.get(e.sku) ? 'offer' : 'not_linked')
                : def.dataSource in walmartMaps
                  ? (walmartMaps[def.dataSource]?.get(e.sku) ? 'offer' : 'not_linked')
                  : 'pim',
        // Which spec attributes differ at Wayfair (from the audit),
        // so the breakdown can name them.
        wayfair_audit:
          def.dataSource === 'wayfair' && wayfairMap ? wayfairMap.get(e.sku) ?? null : undefined,
        // The live Best Buy offer (price/stock/msrp), for the breakdown.
        bb_offer:
          def.dataSource === 'bestbuy' && bestbuyMap ? bestbuyMap.get(e.sku) ?? null : undefined,
        // The live Walmart item (US: published/lifecycle/price USD;
        // CA: feed presence).
        wm_item:
          def.dataSource in walmartMaps && walmartMaps[def.dataSource]
            ? walmartMaps[def.dataSource].get(e.sku) ?? null
            : undefined,
        result,
      };
    });
    const stats = aggregateStats(scores);
    const cachedCount = scores.filter((s) => s.has_wix_cache).length;
    const linkedCount =
      def.dataSource === 'wayfair'
        ? enriched.filter((e) => e.raw.wayfair_item_group_id).length
        : scores.filter((s) => s.wix_product_id).length;
    perMarketplaceData[mkt] = { products: scores, stats, cachedCount, linkedCount };
  }

  return { enriched, perMarketplaceData };
}

/**
 * Collapse full per-marketplace data into the light summary shape the
 * Dashboard consumes — the same shape `latestHealthSummaries` reads back
 * from the persisted snapshots.
 */
export function summarizeForDashboard(perMarketplaceData) {
  const runAt = new Date().toISOString();
  const summaries = {};
  for (const [mkt, data] of Object.entries(perMarketplaceData)) {
    summaries[mkt] = {
      runAt,
      total: data.products.length,
      avgScore: data.stats.avgScore,
      distribution: data.stats.distribution,
      linkedCount: data.linkedCount,
      topIssues: data.stats.topIssues.slice(0, 10).map((i) => ({
        key: i.key,
        label: i.label,
        category: i.category,
        severity: i.severity,
        count: i.count,
      })),
    };
  }
  return summaries;
}

/**
 * Persist per-marketplace aggregates as `channel_health` rows with
 * channel = 'listing_health' / target = <mkt>, so the Dashboard can read
 * them without re-scoring the catalog.
 *
 * Best-effort and throttled: a new row is written only when the numbers
 * changed or the latest one is older than 12 h (so "updated X ago" stays
 * honest without growing the table on every page load).
 */
export async function persistHealthSummaries(perMarketplaceData) {
  try {
    const { data: recent } = await supabase
      .from('channel_health')
      .select('target, run_at, total, in_sync, with_diffs, errors')
      .eq('channel', 'listing_health')
      .order('run_at', { ascending: false })
      .limit(40);

    const latestByTarget = new Map();
    for (const row of recent ?? []) {
      if (!latestByTarget.has(row.target)) latestByTarget.set(row.target, row);
    }

    const MAX_AGE_MS = 12 * 60 * 60 * 1000;
    const summaries = summarizeForDashboard(perMarketplaceData);
    const rows = [];
    for (const [mkt, summary] of Object.entries(summaries)) {
      const d = summary.distribution;
      const row = {
        channel: 'listing_health',
        target: mkt,
        total: summary.total,
        in_sync: d.excellent + d.good,
        with_diffs: d.needs_work,
        errors: d.critical,
        partial: false,
        top_offenders: {
          avgScore: summary.avgScore,
          distribution: d,
          linkedCount: summary.linkedCount,
          topIssues: summary.topIssues,
        },
      };

      const prev = latestByTarget.get(mkt);
      const unchanged =
        prev &&
        prev.total === row.total &&
        prev.in_sync === row.in_sync &&
        prev.with_diffs === row.with_diffs &&
        prev.errors === row.errors;
      const fresh = prev && Date.now() - new Date(prev.run_at).getTime() < MAX_AGE_MS;
      if (unchanged && fresh) continue;
      rows.push(row);
    }

    if (rows.length > 0) await supabase.from('channel_health').insert(rows);
  } catch {
    // summaries are a cache — never let them break the caller
  }
}
