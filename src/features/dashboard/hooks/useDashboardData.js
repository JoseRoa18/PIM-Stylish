import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { MARKETPLACES, API_MARKETPLACE_KEYS } from '../lib/listingHealth';
import {
  computeListingHealth,
  persistHealthSummaries,
  summarizeForDashboard,
} from '../api/listingHealthData';

// Channels whose read-only pulls / audits write channel_health snapshots the
// action strip can turn into discrepancy counts.
const SYNC_CHANNELS = ['wayfair', 'bestbuy', 'walmart_us', 'walmart_ca'];

// Summaries older than this trigger a background re-score on Dashboard
// visits — the first visitor of the day refreshes the scores for everyone.
const SUMMARY_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function summariesAreStale(summaries) {
  return API_MARKETPLACE_KEYS.some((k) => {
    const s = summaries[k];
    return !s || Date.now() - new Date(s.runAt).getTime() > SUMMARY_MAX_AGE_MS;
  });
}

// Lightweight snapshot read — never select `results` here: full per-SKU
// payloads are hundreds of KB and the Dashboard only needs the counters.
async function latestSnapshotLite(channel) {
  const { data } = await supabase
    .from('channel_health')
    .select('channel, target, run_at, total, in_sync, with_diffs, errors, partial')
    .eq('channel', channel)
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

// Latest listing-health summary per marketplace (written by useListingHealth).
async function latestHealthSummaries() {
  const { data } = await supabase
    .from('channel_health')
    .select('target, run_at, total, top_offenders')
    .eq('channel', 'listing_health')
    .order('run_at', { ascending: false })
    .limit(40);

  const byMarketplace = {};
  for (const row of data ?? []) {
    if (!byMarketplace[row.target] && row.top_offenders) {
      byMarketplace[row.target] = {
        runAt: row.run_at,
        total: row.total,
        avgScore: row.top_offenders.avgScore ?? 0,
        distribution: row.top_offenders.distribution ?? null,
        linkedCount: row.top_offenders.linkedCount ?? 0,
        topIssues: row.top_offenders.topIssues ?? [],
      };
    }
  }
  return byMarketplace;
}

// Channel-side checks that can't be fixed by editing PIM content — everything
// else in topIssues is a genuine content gap (missing field/image/section).
const CHANNEL_ONLY_ISSUE = /^(linked_to_|listed_on_|bb_|wm_|wayfair_)/;

function buildContentGaps(summaries) {
  const bySeverity = { critical: 3, major: 2, minor: 1 };
  const merged = new Map();

  for (const [mkt, summary] of Object.entries(summaries)) {
    const label = MARKETPLACES[mkt]?.label ?? mkt;
    for (const issue of summary.topIssues) {
      if (CHANNEL_ONLY_ISSUE.test(issue.key)) continue;
      let entry = merged.get(issue.key);
      if (!entry) {
        entry = { ...issue, count: 0, marketplaces: [] };
        merged.set(issue.key, entry);
      }
      // Same underlying product data scored per marketplace — keep the
      // largest count rather than summing duplicates.
      entry.count = Math.max(entry.count, issue.count);
      if (!entry.marketplaces.includes(label)) entry.marketplaces.push(label);
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.count * bySeverity[b.severity] - a.count * bySeverity[a.severity])
    .slice(0, 6);
}

// Titles never repeat the count — the card renders it in the chip. `tone`
// grades each chip: 'error' only for genuine channel failures, 'warning' for
// PIM↔channel desyncs, 'neutral' for informational rows.
function buildActions({ channelSnapshots, unlinkedWix }) {
  const actions = [];
  const plural = (n, word) => (n === 1 ? word : `${word}s`);

  const wayfair = channelSnapshots.wayfair;
  if (wayfair?.with_diffs > 0) {
    actions.push({
      key: 'wayfair',
      count: wayfair.with_diffs,
      tone: 'warning',
      title: `${plural(wayfair.with_diffs, 'SKU')} with spec attributes out of sync`,
      detail: 'Wayfair — push attributes from the PIM to fix',
      to: '/syndication/wayfair',
      runAt: wayfair.run_at,
    });
  }

  const bestbuy = channelSnapshots.bestbuy;
  if (bestbuy?.with_diffs > 0) {
    actions.push({
      key: 'bestbuy',
      count: bestbuy.with_diffs,
      tone: 'warning',
      title: `${plural(bestbuy.with_diffs, 'Offer')} priced differently than the PIM MSRP`,
      detail: 'Best Buy Canada — PIM pricing is the source of truth',
      to: '/syndication/bestbuy',
      runAt: bestbuy.run_at,
    });
  }

  const walmartUs = channelSnapshots.walmart_us;
  if (walmartUs?.with_diffs > 0) {
    actions.push({
      key: 'walmart_us',
      count: walmartUs.with_diffs,
      tone: 'warning',
      title: `${plural(walmartUs.with_diffs, 'Item')} not published on Walmart US`,
      detail: 'Walmart US — unpublished or retired listings',
      to: '/syndication/walmart_us',
      runAt: walmartUs.run_at,
    });
  }

  const walmartCa = channelSnapshots.walmart_ca;
  if (walmartCa?.with_diffs > 0) {
    actions.push({
      key: 'walmart_ca',
      count: walmartCa.with_diffs,
      tone: 'error',
      title: `${plural(walmartCa.with_diffs, 'SKU')} with errors in the inventory feed`,
      detail: 'Walmart Canada — failed feed ingestion',
      to: '/syndication/walmart_ca',
      runAt: walmartCa.run_at,
    });
  }

  if (unlinkedWix > 0) {
    actions.push({
      key: 'wix',
      count: unlinkedWix,
      tone: 'neutral',
      title: `${plural(unlinkedWix, 'Product')} not linked to the website yet`,
      detail: 'Sinks Direct Canada — link or push from the Wix workspace',
      to: '/syndication/wix',
      runAt: null,
    });
  }

  return actions;
}

/**
 * Everything the Dashboard needs in one parallel round of lightweight reads:
 * a slim product list (status / launch dates / links) plus the persisted
 * channel + listing-health snapshots. No full-catalog scoring here.
 */
export function useDashboardData() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const [productsResult, healthSummaries, ...snapshots] = await Promise.all([
          supabase
            .from('products')
            .select(
              'sku, model_name, workflow_status, wix_product_id, wix_synced_at, ready_to_sell_date, created_at',
            ),
          latestHealthSummaries(),
          ...SYNC_CHANNELS.map((c) => latestSnapshotLite(c)),
        ]);
        if (productsResult.error) throw productsResult.error;

        const list = productsResult.data ?? [];
        const channelSnapshots = Object.fromEntries(
          SYNC_CHANNELS.map((c, i) => [c, snapshots[i]]),
        );

        const today = new Date();
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(today.getDate() - 30);
        const thirtyDaysAhead = new Date(today);
        thirtyDaysAhead.setDate(today.getDate() + 30);

        const byStatus = {};
        let linkedWix = 0;
        for (const p of list) {
          const status = p.workflow_status || 'unknown';
          byStatus[status] = (byStatus[status] ?? 0) + 1;
          if (p.wix_product_id) linkedWix++;
        }

        const upcomingLaunches = list
          .filter((p) => {
            if (!p.ready_to_sell_date) return false;
            const d = new Date(p.ready_to_sell_date);
            return d >= today && d <= thirtyDaysAhead && p.workflow_status !== 'ready_to_sell';
          })
          .sort((a, b) => new Date(a.ready_to_sell_date) - new Date(b.ready_to_sell_date));

        const overdueLaunches = list.filter((p) => {
          if (!p.ready_to_sell_date) return false;
          const d = new Date(p.ready_to_sell_date);
          return d < today && p.workflow_status !== 'ready_to_sell' && p.workflow_status !== 'archived';
        });

        const stalled = list.filter(
          (p) => p.created_at && new Date(p.created_at) < thirtyDaysAgo && p.workflow_status === 'new',
        );

        // Fallback feed for RecentActivityCard when the audit log is empty
        // or RLS hides it from the current role.
        const recentCreated = [...list]
          .filter((p) => p.created_at)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 5);
        const recentPushed = [...list]
          .filter((p) => p.wix_synced_at)
          .sort((a, b) => new Date(b.wix_synced_at) - new Date(a.wix_synced_at))
          .slice(0, 5);

        const stale = summariesAreStale(healthSummaries);

        if (active) {
          setData({
            total: list.length,
            byStatus,
            actions: buildActions({ channelSnapshots, unlinkedWix: list.length - linkedWix }),
            hasChannelSnapshots: Object.values(channelSnapshots).some(Boolean),
            healthSummaries,
            healthRefreshing: stale,
            contentGaps: buildContentGaps(healthSummaries),
            upcomingLaunches,
            overdueLaunches,
            stalled,
            recentCreated,
            recentPushed,
          });
          setLoading(false);
        }

        // Stale-while-revalidate: the cached summaries render instantly;
        // if they're missing or old, re-score the catalog in the background,
        // persist the fresh summaries and swap them into the UI.
        if (stale) {
          try {
            const { perMarketplaceData } = await computeListingHealth();
            persistHealthSummaries(perMarketplaceData);
            const fresh = summarizeForDashboard(perMarketplaceData);
            if (active) {
              setData((prev) =>
                prev
                  ? {
                      ...prev,
                      healthSummaries: fresh,
                      healthRefreshing: false,
                      contentGaps: buildContentGaps(fresh),
                    }
                  : prev,
              );
            }
          } catch {
            // keep showing the cached summaries
            if (active) {
              setData((prev) => (prev ? { ...prev, healthRefreshing: false } : prev));
            }
          }
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

  return { data, loading, error };
}
