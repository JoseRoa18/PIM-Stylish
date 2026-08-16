import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { pushProductToWix, refreshWixCatalog } from '@/features/syndication/api/wixSync';
import { refreshBestBuyOffers } from '@/features/syndication/api/bestbuySync';
import { WIX_SITES, DEFAULT_WIX_SITE } from '@/features/syndication/lib/wixSites';

/**
 * Price Alignment Analyzer — the four Wix sites plus Best Buy.
 *
 * Expected price per site: SinksDirect sites follow the monthly promo (a SKU
 * in an ACTIVE promotion is expected at its market's promo price, everything
 * else at MAP, and the discounted price counts as the live price). Stylish
 * brand sites run their own storefront sales, so only the BASE price is
 * compared against MSRP — a percent-off sale there is not drift. Only PIM
 * products count — Wix-only orphans are out of scope by the source-of-truth
 * rule.
 *
 * Best Buy sells at the Canadian MAP (verified 2026-08-16: 252/275 offers
 * exactly at map_cad) and follows the monthly promo, so its expected price
 * is promo ?? MAP — computed here from the offers snapshot, which is raw
 * Mirakl data. ANALYSIS ONLY for now: the no-price-push rule was lifted
 * 2026-08-16 but the push isn't built yet, so fixes go through the Mirakl
 * portal by hand.
 *
 * Reports are PERSISTED: the analysis reads each site's latest channel_health
 * snapshot — written by the twice-daily cron AND by "Run analysis" (which is
 * just a fresh pull + snapshot). Opening the tab shows the last report
 * without running anything.
 *
 * Classifications:
 *   promo_ok      — live price = active promo price ✓ (SinksDirect sites)
 *   map_ok        — live price = the site's regular price ✓
 *   promo_missing — promo member still at the regular price ⚠
 *   misaligned    — neither promo nor the regular price 🔴
 *   no_map        — nothing to compare against (no price in the PIM) ⚪
 *   missing       — linked but the Wix product no longer exists 🔴
 */

// Everything the alignment tab can point at: the four Wix sites (fixable
// with one click) plus Best Buy (analysis only until its push is built).
export const ALIGN_TARGETS = {
  ...Object.fromEntries(
    Object.entries(WIX_SITES).map(([key, cfg]) => [key, { ...cfg, kind: 'wix', canFix: true }]),
  ),
  bestbuy: {
    key: 'bestbuy',
    kind: 'bestbuy',
    canFix: false,
    channel: 'bestbuy',
    label: 'Best Buy Canada',
    short: 'Best Buy',
    symbol: 'C$',
    priceField: 'map_cad',
    priceShort: 'MAP (CAD)',
    promoAware: true,
    market: 'ca',
  },
};
export const ALIGN_TARGET_KEYS = Object.keys(ALIGN_TARGETS);

const eq = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.01;

function classifySnapshot(snapshot) {
  const counts = { promo_ok: 0, map_ok: 0, promo_missing: 0, misaligned: 0, no_map: 0, missing: 0 };
  const problems = [];
  let total = 0;
  let legacy = false;

  for (const r of snapshot.results ?? []) {
    if (r.state === 'not_in_pim') continue; // Wix orphans — out of scope
    total += 1;
    if (r.state === 'missing') {
      counts.missing += 1;
      problems.push({ sku: r.sku, status: 'missing', live: null, expected: null, source: null });
      continue;
    }
    // Snapshots older than the expected-price rollout can't be classified.
    if (!('expected' in r)) { legacy = true; continue; }

    if (r.expected == null) {
      counts.no_map += 1;
      problems.push({ sku: r.sku, status: 'no_map', live: r.price ?? null, expected: null, source: null });
    } else if (!r.price_diff) {
      counts[r.expected_source === 'promo' ? 'promo_ok' : 'map_ok'] += 1;
    } else if (r.expected_source === 'promo' && eq(r.price, r.map)) {
      counts.promo_missing += 1;
      problems.push({ sku: r.sku, status: 'promo_missing', live: r.price, expected: r.expected, source: 'promo' });
    } else {
      counts.misaligned += 1;
      problems.push({ sku: r.sku, status: 'misaligned', live: r.price, expected: r.expected, source: r.expected_source });
    }
  }

  problems.sort((a, b) => a.sku.localeCompare(b.sku));
  return { ranAt: snapshot.run_at, total, counts, problems, legacy };
}

/**
 * The Best Buy offers snapshot is raw Mirakl data (sku, price, active…), so
 * the expected price is joined in here: active promo CAD price for members,
 * the regular MAP for everyone else. Offers whose SKU isn't in the PIM are
 * out of scope (source-of-truth rule), mirroring the Wix orphan handling.
 */
async function loadBestBuyAlignment() {
  const { data, error } = await supabase
    .from('channel_health')
    .select('run_at, results')
    .eq('channel', 'bestbuy')
    .order('run_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data?.length) return null;
  const snapshot = data[0];

  const { data: prods, error: prodErr } = await supabase
    .from('products')
    .select('sku, map_cad');
  if (prodErr) throw prodErr;
  const mapBySku = new Map((prods ?? []).map((p) => [p.sku, p.map_cad]));

  const { data: activePromos, error: promoErr } = await supabase
    .from('promotions')
    .select('period, promotion_prices(sku, promo_price_cad)')
    .eq('status', 'active')
    .order('period', { ascending: true });
  if (promoErr) throw promoErr;
  const promoBySku = new Map();
  for (const promo of activePromos ?? []) {
    for (const row of promo.promotion_prices ?? []) {
      if (row.promo_price_cad != null) promoBySku.set(row.sku, row.promo_price_cad);
    }
  }

  const results = [];
  for (const o of snapshot.results ?? []) {
    if (!mapBySku.has(o.sku)) continue; // Best Buy shop SKU not in the PIM
    const map = mapBySku.get(o.sku) ?? null;
    const promoPrice = promoBySku.get(o.sku);
    const expected = promoPrice ?? map;
    results.push({
      sku: o.sku,
      state: 'live',
      price: o.price ?? null,
      expected: expected ?? null,
      expected_source: promoPrice != null ? 'promo' : 'map',
      map,
      price_diff: expected != null && o.price != null && Math.abs(o.price - expected) > 0.01,
    });
  }
  return classifySnapshot({ run_at: snapshot.run_at, results });
}

/** Latest saved report for a target (cron or manual) — instant, no live pull. */
export async function loadLatestAlignment(target = DEFAULT_WIX_SITE) {
  const cfg = ALIGN_TARGETS[target];
  if (cfg.kind === 'bestbuy') return loadBestBuyAlignment();
  const { data, error } = await supabase
    .from('channel_health')
    .select('run_at, results')
    .eq('channel', cfg.channel)
    .order('run_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data?.length) return null;
  return classifySnapshot(data[0]);
}

/** Fresh live analysis — pulls the channel now and PERSISTS the snapshot. */
export async function runPriceAlignment(target = DEFAULT_WIX_SITE) {
  const cfg = ALIGN_TARGETS[target];
  if (cfg.kind === 'bestbuy') await refreshBestBuyOffers();
  else await refreshWixCatalog(target);
  return loadLatestAlignment(target);
}

/**
 * Push ONE product's expected price to a Wix site — priceData only, so a fix
 * can never touch visibility or content. `expected` comes from the analysis
 * (promo price or the site's regular price) and lands on the site's own
 * price column.
 */
export async function pushExpectedPrice(sku, expected, site = DEFAULT_WIX_SITE) {
  const cfg = WIX_SITES[site];
  await pushProductToWix(sku, { [cfg.priceField]: expected }, ['priceData'], site);
}

/**
 * Fix a batch of analysis problems (the fixable ones), one by one.
 */
export async function fixAlignment(problems, onProgress, site = DEFAULT_WIX_SITE) {
  const cfg = WIX_SITES[site];
  const fixable = problems.filter((p) => p.expected != null);
  let done = 0;
  const failures = [];
  for (const p of fixable) {
    try {
      await pushExpectedPrice(p.sku, p.expected, site);
    } catch (err) {
      failures.push(`${p.sku}: ${err.message}`);
    }
    done += 1;
    onProgress?.({ done, total: fixable.length });
  }
  logActivity({
    action: 'push',
    entityType: 'product',
    target: 'wix',
    summary: `Price alignment: pushed ${fixable.length - failures.length} corrected price${fixable.length - failures.length === 1 ? '' : 's'} to ${cfg.label}`,
    metadata: { site, fixed: fixable.length - failures.length, failures: failures.length },
  });
  return { fixed: fixable.length - failures.length, failures };
}
