import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { pushProductToWix, refreshWixCatalog } from '@/features/syndication/api/wixSync';
import { refreshBestBuyOffers, pushBestBuyPrices } from '@/features/syndication/api/bestbuySync';
import { refreshWalmartItems } from '@/features/syndication/api/walmartSync';
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
 * Mirakl data. Fixes go through bestbuy-push-price (OF24, price-only):
 * a stale MAP updates the offer price; a missing promo becomes a SCHEDULED
 * discount for the promo month (price stays at MAP, discount_price = promo
 * with the month's start/end dates), so it expires on its own.
 *
 * Walmart US sells at the US MAP (verified 2026-08-16: 158/205 items exactly
 * at map_usd) and follows the monthly promo. ANALYSIS ONLY: the Walmart
 * connection is read-only by design, so fixes go through Seller Center until
 * a price push is built.
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
    canFix: true,
    channel: 'bestbuy',
    label: 'Best Buy Canada',
    short: 'Best Buy',
    symbol: 'C$',
    priceField: 'map_cad',
    priceShort: 'MAP (CAD)',
    promoAware: true,
    market: 'ca',
  },
  walmart_us: {
    key: 'walmart_us',
    kind: 'walmart',
    canFix: false,
    channel: 'walmart_us',
    label: 'Walmart US',
    short: 'Walmart US',
    symbol: '$',
    priceField: 'map_usd',
    priceShort: 'MAP (USD)',
    promoAware: true,
    market: 'us',
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
      problems.push({ sku: r.sku, status: 'promo_missing', live: r.price, expected: r.expected, source: 'promo', map: r.map ?? null, promo_period: r.promo_period ?? null });
    } else {
      counts.misaligned += 1;
      problems.push({ sku: r.sku, status: 'misaligned', live: r.price, expected: r.expected, source: r.expected_source, map: r.map ?? null, promo_period: r.promo_period ?? null });
    }
  }

  problems.sort((a, b) => a.sku.localeCompare(b.sku));
  return { ranAt: snapshot.run_at, total, counts, problems, legacy };
}

/**
 * Best Buy / Walmart snapshots are raw channel data (sku, price, …), so the
 * expected price is joined in here: the market's active promo price for
 * members, the site's regular MAP for everyone else. Rows whose SKU isn't in
 * the PIM are out of scope (source-of-truth rule), mirroring the Wix orphan
 * handling.
 */
async function loadOfferAlignment(cfg) {
  const { data, error } = await supabase
    .from('channel_health')
    .select('run_at, results')
    .eq('channel', cfg.channel)
    .order('run_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data?.length) return null;
  const snapshot = data[0];

  const { data: prods, error: prodErr } = await supabase
    .from('products')
    .select(`sku, base:${cfg.priceField}`);
  if (prodErr) throw prodErr;
  const baseBySku = new Map((prods ?? []).map((p) => [p.sku, p.base]));

  const promoField = cfg.market === 'us' ? 'promo_price_usd' : 'promo_price_cad';
  const { data: activePromos, error: promoErr } = await supabase
    .from('promotions')
    .select(`period, promotion_prices(sku, ${promoField})`)
    .eq('status', 'active')
    .order('period', { ascending: true });
  if (promoErr) throw promoErr;
  const promoBySku = new Map();
  for (const promo of activePromos ?? []) {
    for (const row of promo.promotion_prices ?? []) {
      // The period rides along so a promo fix can be pushed as a SCHEDULED
      // discount covering exactly that month (Best Buy).
      if (row[promoField] != null) promoBySku.set(row.sku, { price: row[promoField], period: promo.period });
    }
  }

  const results = [];
  for (const o of snapshot.results ?? []) {
    if (!baseBySku.has(o.sku)) continue; // channel SKU not in the PIM
    const base = baseBySku.get(o.sku) ?? null;
    const promo = promoBySku.get(o.sku);
    const expected = promo?.price ?? base;
    results.push({
      sku: o.sku,
      state: 'live',
      price: o.price ?? null,
      expected: expected ?? null,
      expected_source: promo != null ? 'promo' : 'map',
      map: base,
      promo_period: promo?.period ?? null,
      price_diff: expected != null && o.price != null && Math.abs(o.price - expected) > 0.01,
    });
  }
  return classifySnapshot({ run_at: snapshot.run_at, results });
}

/** Latest saved report for a target (cron or manual) — instant, no live pull. */
export async function loadLatestAlignment(target = DEFAULT_WIX_SITE) {
  const cfg = ALIGN_TARGETS[target];
  if (cfg.kind === 'bestbuy' || cfg.kind === 'walmart') return loadOfferAlignment(cfg);
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
  else if (cfg.kind === 'walmart') await refreshWalmartItems('us');
  else await refreshWixCatalog(target);
  return loadLatestAlignment(target);
}

/** Last day of a promo month, from its period date ('YYYY-MM-01'). */
function promoMonthEnd(period) {
  const d = new Date(`${period}T00:00:00`);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
}

/**
 * One analysis problem → one OF24 price update. A promo fix keeps the offer
 * at its regular MAP and adds the promo as a scheduled discount for exactly
 * the promo month; a plain misalignment just corrects the price.
 */
function buildBestBuyUpdate(p) {
  if (p.source === 'promo' && p.promo_period) {
    return {
      sku: p.sku,
      ...(p.map != null ? { price: p.map } : {}),
      discount_price: p.expected,
      discount_start_date: p.promo_period,
      discount_end_date: promoMonthEnd(p.promo_period),
    };
  }
  return { sku: p.sku, price: p.expected };
}

/**
 * Push ONE product's expected price. Wix sites: priceData only, so a fix can
 * never touch visibility or content. Best Buy: a single-line OF24 import
 * (price / scheduled discount only).
 */
export async function pushExpectedPrice(sku, expected, target = DEFAULT_WIX_SITE, problem = null) {
  const cfg = ALIGN_TARGETS[target];
  if (cfg.kind === 'bestbuy') {
    const res = await pushBestBuyPrices([buildBestBuyUpdate(problem ?? { sku, expected, source: 'map' })]);
    if (res.lines_in_error > 0) {
      throw new Error(`Best Buy rejected the update: ${res.error_report ?? `${res.lines_in_error} line(s) in error`}`);
    }
    return;
  }
  await pushProductToWix(sku, { [cfg.priceField]: expected }, ['priceData'], target);
}

/**
 * Fix a batch of analysis problems (the fixable ones). Wix sites push one by
 * one; Best Buy sends the whole batch as a single OF24 import — Mirakl
 * processes it atomically enough that per-line errors come back in one
 * report instead of N round-trips.
 */
export async function fixAlignment(problems, onProgress, target = DEFAULT_WIX_SITE) {
  const cfg = ALIGN_TARGETS[target];
  const fixable = problems.filter((p) => p.expected != null);

  if (cfg.kind === 'bestbuy') {
    onProgress?.({ done: 0, total: fixable.length });
    const res = await pushBestBuyPrices(fixable.map(buildBestBuyUpdate));
    onProgress?.({ done: fixable.length, total: fixable.length });
    const failures = res.lines_in_error > 0
      ? [`${res.lines_in_error} line(s) rejected by Best Buy${res.error_report ? ` — ${res.error_report.slice(0, 300)}` : ''}`]
      : [];
    if (res.still_processing) {
      failures.push('Import still processing on Best Buy — re-run the analysis in a minute to confirm.');
    }
    return { fixed: res.lines_in_error > 0 ? fixable.length - res.lines_in_error : fixable.length, failures };
  }

  let done = 0;
  const failures = [];
  for (const p of fixable) {
    try {
      await pushExpectedPrice(p.sku, p.expected, target);
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
    metadata: { site: target, fixed: fixable.length - failures.length, failures: failures.length },
  });
  return { fixed: fixable.length - failures.length, failures };
}
