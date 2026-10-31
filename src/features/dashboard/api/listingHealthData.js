import { supabase } from '@/lib/supabase';
import { loadCatalogWithMedia } from './catalogWithMedia';
import {
  buildListingHealthData,
  buildSummaryRows,
  summarizeForDashboard,
} from '../lib/listingHealth';

export { summarizeForDashboard };

// One computation is shared for half a minute by every caller (Listing
// Health, the Dashboard's stale re-score, Analytics, React's double effect in
// development): each run reads the nine channel snapshots in full plus the
// catalog, and on 2026-10-20 twenty-five runs in four minutes left the
// database (then the smallest Supabase size) without memory — it froze until
// restarted. Short, so a fix made on the product page shows on return.
const SHARE_MS = 30 * 1000;
let shared = null; // { at, promise, hub }

// One run's progress, sent to every task card waiting on it: the caller that
// started the run and any that join it while it is shared (a remount, React's
// double effect in development — by then the first card is gone, so the run
// still has a card that moves). A joining card starts at the last reading.
function progressHub() {
  const cards = new Set();
  let last = null;
  const hub = {
    watch(task) {
      if (!task) return;
      cards.add(task);
      if (last) task.progress(last.share, last.detail);
    },
    progress(share, detail) {
      last = { share, detail };
      for (const t of cards) t.progress(share, detail);
    },
    // The reading, then a paint, before work that blocks the page.
    async step(share, detail) {
      hub.progress(share, detail);
      const [first] = cards;
      if (first) await first.paint();
    },
  };
  return hub;
}

/**
 * Browser-side listing-health computation: fetch the catalog (with media)
 * and the latest channel snapshots, then run the shared scoring pipeline.
 * The scheduled `health-refresh` edge function runs the same pipeline
 * server-side twice a day. `task` (optional taskProgress reporter) follows
 * the run — the one this call starts or the shared one it joins: the reads
 * up to 85%, then the scoring.
 */
export function computeListingHealth({ task = null } = {}) {
  if (shared && Date.now() - shared.at < SHARE_MS) {
    shared.hub.watch(task);
    return shared.promise;
  }
  const hub = progressHub();
  hub.watch(task);
  const promise = computeListingHealthNow(hub);
  shared = { at: Date.now(), promise, hub };
  promise.catch(() => { if (shared?.promise === promise) shared = null; });
  return promise;
}

async function computeListingHealthNow(hub) {
  // The catalog load is shared with the PIM completeness panel (both run on
  // the Listing Health page), and the ten snapshots load at the same time.
  const catalog = loadCatalogWithMedia();

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

  const reads = [
    catalog,
    latestSnapshotMap('wayfair'),
    latestSnapshotMap('wayfair_usa'),
    latestSnapshotMap('bestbuy'),
    latestSnapshotMap('walmart_us'),
    latestSnapshotMap('walmart_ca'),
    latestSnapshotMap('wix_sinksdirect_us'),
    latestSnapshotMap('wix_stylish_ca'),
    latestSnapshotMap('wix_stylish_us'),
    latestSnapshotMap('wix_azuni_ca'),
  ];
  let read = 0;
  const [
    dbProducts,
    wayfairMap, wayfairUsaMap, bestbuyMap, walmartUs, walmartCa,
    wixSinksdirectUs, wixStylishCa, wixStylishUs, wixAzuniCa,
  ] = await Promise.all(reads.map((p) => p.then((value) => {
    read += 1;
    hub.progress((read / reads.length) * 0.85, `Reading the catalog and channel snapshots (${read} of ${reads.length})`);
    return value;
  })));

  // The scoring blocks the page: the card shows the step first.
  await hub.step(0.85, `Scoring ${(dbProducts ?? []).length} products on every channel…`);
  return buildListingHealthData(dbProducts ?? [], {
    wayfairMap,
    wayfairUsaMap,
    bestbuyMap,
    walmartMaps: {
      walmart_us: walmartUs,
      walmart_ca: walmartCa,
    },
    // The other three Wix sites score from their own catalog snapshots
    // (the SinksDirect CA card keeps its richer wix_raw cache).
    wixSiteMaps: {
      wix_sinksdirect_us: wixSinksdirectUs,
      wix_stylish_ca: wixStylishCa,
      wix_stylish_us: wixStylishUs,
      wix_azuni_ca: wixAzuniCa,
    },
  });
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
    const rows = buildSummaryRows(perMarketplaceData).filter((row) => {
      const prev = latestByTarget.get(row.target);
      const unchanged =
        prev &&
        prev.total === row.total &&
        prev.in_sync === row.in_sync &&
        prev.with_diffs === row.with_diffs &&
        prev.errors === row.errors;
      const fresh = prev && Date.now() - new Date(prev.run_at).getTime() < MAX_AGE_MS;
      return !(unchanged && fresh);
    });

    if (rows.length > 0) await supabase.from('channel_health').insert(rows);
  } catch {
    // summaries are a cache — never let them break the caller
  }
}
