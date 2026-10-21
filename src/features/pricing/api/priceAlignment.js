import { supabase } from '@/lib/supabase';
import { etToday, promoWindow } from '../lib/promoCalendar';
import { sharedLoad, loadExpectedPrices, loadPriceChangeDays, dropShared } from './expectedPrices';
import { PAGE_STORES } from '../lib/pageStores';
import { NLP_MIN_DISCOUNT, NLP_CATEGORIES, nlpDiscount } from '../lib/homeDepotCaNlp';
import { logActivity } from '@/features/activity/api/activityLog';
import { pushProductToWix, refreshWixCatalog } from '@/features/syndication/api/wixSync';
import { refreshBestBuyOffers, pushBestBuyPrices } from '@/features/syndication/api/bestbuySync';
import { refreshWalmartItems } from '@/features/syndication/api/walmartSync';
import { WIX_SITES, DEFAULT_WIX_SITE, wixSiteSells } from '@/features/syndication/lib/wixSites';

// The latest snapshot of a channel (run_at + per-SKU results), shared.
function latestChannelSnapshot(channel) {
  return sharedLoad(`snapshot:${channel}`, async () => {
    const { data, error } = await supabase
      .from('channel_health')
      .select('run_at, results')
      .eq('channel', channel)
      .order('run_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return data ?? [];
  });
}

/**
 * Price Alignment Analyzer — the Wix sites, Best Buy, the two Walmarts and,
 * since 2026-10-20, the stores read from their own product pages (Wayfair,
 * Amazon, Home Depot, Rona, Lowe's, Menards, BB&B, Overstock and the dealers —
 * PAGE_STORES below).
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
// with one click), Best Buy, the two Walmarts and the stores read from their
// pages (analysis only — PAGE_STORES in lib/pageStores.js).
export const ALIGN_TARGETS = {
  ...Object.fromEntries(
    Object.entries(WIX_SITES).map(([key, cfg]) => [key, { ...cfg, kind: 'wix', canFix: true, promoChannel: `wix_${key}` }]),
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
    promoChannel: 'bestbuy',
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
    promoChannel: 'walmart_us',
  },
  // Walmart Canada exposes prices only while a promotion exists on the SKU
  // (the promo read carries the regular price next to it), so the analysis
  // covers promo compliance; SKUs without any price on file are left out.
  walmart_ca: {
    key: 'walmart_ca',
    kind: 'walmart',
    canFix: false,
    channel: 'walmart_ca',
    label: 'Walmart Canada',
    short: 'Walmart CA',
    symbol: 'C$',
    priceField: 'map_cad',
    priceShort: 'MAP (CAD)',
    promoAware: true,
    market: 'ca',
    promoChannel: 'walmart_ca',
  },
  ...Object.fromEntries(PAGE_STORES.map((s) => [s.key, {
    ...s,
    kind: 'page',
    canFix: false,
    retailer: s.key,
    symbol: s.market === 'us' ? '$' : 'C$',
    priceField: s.market === 'us' ? 'map_usd' : 'map_cad',
    priceShort: s.market === 'us' ? 'MAP (USD)' : 'MAP (CAD)',
    promoAware: true,
  }])),
};
export const ALIGN_TARGET_KEYS = Object.keys(ALIGN_TARGETS);

const eq = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.01;

function classifySnapshot(snapshot, outOfScope = null) {
  const counts = { promo_ok: 0, map_ok: 0, promo_missing: 0, misaligned: 0, no_map: 0, missing: 0 };
  const problems = [];
  let total = 0;
  let notOnStore = 0;
  let legacy = false;

  for (const r of snapshot.results ?? []) {
    if (r.state === 'not_in_pim') continue; // Wix orphans — out of scope
    if (outOfScope?.has(r.sku)) continue; // brand the store never carries
    // Rule (user, 2026-09-23): a product the store does not carry is not a
    // price problem — it stays out of the report and its score.
    if (r.state === 'missing') { notOnStore += 1; continue; }
    total += 1;
    // Snapshots older than the expected-price rollout can't be classified.
    if (!('expected' in r)) { legacy = true; continue; }
    // A price read from the store's page carries where and when it was read.
    const page = r.url ? { url: r.url, read_at: r.read_at ?? null, unconfirmed: r.sku_check !== 'match', in_stock: r.in_stock ?? null, page_note: r.page_note ?? null } : {};

    if (r.expected == null) {
      counts.no_map += 1;
      problems.push({ sku: r.sku, status: 'no_map', live: r.price ?? null, expected: null, source: null, ...page });
    } else if (!r.price_diff) {
      counts[r.expected_source === 'promo' ? 'promo_ok' : 'map_ok'] += 1;
    } else if (r.expected_source === 'promo' && (r.no_promo || eq(r.price, r.map))) {
      counts.promo_missing += 1;
      problems.push({ sku: r.sku, status: 'promo_missing', live: r.price ?? null, expected: r.expected, source: 'promo', map: r.map ?? null, promo_period: r.promo_period ?? null, promo_kind: r.promo_kind ?? null, promo_window: r.promo_window ?? null, ...page });
    } else {
      counts.misaligned += 1;
      problems.push({ sku: r.sku, status: 'misaligned', live: r.price, expected: r.expected, source: r.expected_source, map: r.map ?? null, promo_period: r.promo_period ?? null, promo_kind: r.promo_kind ?? null, promo_window: r.promo_window ?? null, ...page });
    }
  }

  problems.sort((a, b) => a.sku.localeCompare(b.sku));
  return { ranAt: snapshot.run_at, total, counts, problems, legacy, notOnStore };
}

/**
 * Best Buy / Walmart snapshots are raw channel data (sku, price, …), so the
 * expected price is joined in here: the market's active promo price for
 * members, the site's regular MAP for everyone else. Rows whose SKU isn't in
 * the PIM are out of scope (source-of-truth rule), mirroring the Wix orphan
 * handling.
 */
async function loadOfferAlignment(cfg) {
  const data = await latestChannelSnapshot(cfg.channel);
  if (!data?.length) return null;
  const snapshot = data[0];
  const { baseBySku, promoBySku } = await loadExpectedPrices(cfg);

  // Mirakl keeps the promo as a discount next to the regular price: the live
  // selling price is the discount while its window is open, and a discount
  // scheduled for the promo month already counts as the promo being in place.
  const today = etToday();
  const day = (v) => (typeof v === 'string' ? v.slice(0, 10) : null);
  const livePrice = (o, promo) => {
    if (o.discount_price == null) return o.price ?? null;
    const start = day(o.discount_start);
    const end = day(o.discount_end);
    const active = (!start || start <= today) && (!end || end >= today);
    if (active) return o.discount_price;
    const scheduledForPromo = promo && (!start || start <= promo.windowStart) && (!end || end >= promo.windowStart)
      && Math.abs(o.discount_price - promo.price) < 0.01;
    return scheduledForPromo ? o.discount_price : (o.price ?? null);
  };

  const results = [];
  for (const o of snapshot.results ?? []) {
    if (!baseBySku.has(o.sku)) continue; // channel SKU not in the PIM
    const base = baseBySku.get(o.sku) ?? null;
    const promo = promoBySku.get(o.sku);
    // No price on file: Walmart CA shows prices only through a promo. A SKU
    // that should be on promo and was read with none is a missing promo;
    // any other has no price to compare and stays out.
    const noPromo = o.price == null && o.discount_price == null;
    if (noPromo && !(promo && o.promo_checked_at)) continue;
    const expected = promo?.price ?? base;
    const price = noPromo ? null : livePrice(o, promo);
    results.push({
      sku: o.sku,
      state: 'live',
      price,
      expected: expected ?? null,
      expected_source: promo != null ? 'promo' : 'map',
      map: base,
      promo_period: promo?.period ?? null,
      promo_kind: promo?.kind ?? null,
      promo_window: promo ? { start: promo.windowStart, end: promo.windowEnd } : null,
      no_promo: noPromo,
      price_diff: noPromo || (expected != null && price != null && Math.abs(price - expected) > 0.01),
    });
  }
  return classifySnapshot({ run_at: snapshot.run_at, results });
}

// Every store link's last reading, read ONCE for all the page targets of a
// view and kept 5 minutes (a reading changes every few hours at most; the
// database is small — a Dashboard visit must not fire one read per store):
// the view where_to_buy_readings gives one row per store and product, the
// links already read and the broken ones (not on the store). The pages past
// the first 1,000 rows are read at the same time.
const PAGE_RETAILERS = PAGE_STORES.map((s) => s.key);
const READINGS_TTL_MS = 5 * 60 * 1000;
let readings = null; // { at, promise }
const dropPageReadings = () => { readings = null; };
function pageReadings() {
  if (readings && Date.now() - readings.at < READINGS_TTL_MS) return readings.promise;
  const query = () => supabase
    .from('where_to_buy_readings')
    .select('sku, retailer, url, verdict, sku_check, page_model, page_note, price, currency, in_stock, read_at', { count: 'exact' })
    .in('retailer', PAGE_RETAILERS)
    .order('retailer')
    .order('sku');
  const promise = (async () => {
    const first = await query().range(0, 999);
    if (first.error) throw first.error;
    const rest = [];
    for (let from = 1000; from < (first.count ?? 0); from += 1000) rest.push(query().range(from, from + 999));
    const pages = await Promise.all(rest);
    for (const p of pages) if (p.error) throw p.error;
    return [first, ...pages].flatMap((p) => p.data ?? []);
  })();
  readings = { at: Date.now(), promise };
  promise.catch(() => { if (readings?.promise === promise) readings = null; });
  return promise;
}

// Every product's category, shared (Home Depot Canada's NLP rule).
function productCategories() {
  return sharedLoad('products:category', async () => {
    const { data, error } = await supabase.from('products').select('sku, category').range(0, 4999);
    if (error) throw error;
    return new Map((data ?? []).map((p) => [p.sku, p.category]));
  });
}

// The Eastern-time day a page was read ('YYYY-MM-DD').
const etDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

/**
 * A store read from its own product pages: the last price the Where to Buy
 * check read on each product's link (both Stylish sites carry the same
 * link — the newest reading counts). Left out of the comparison: a broken
 * link (the product is not on the store), a page on another product or
 * option — or naming a model that is not this SKU —, a page read before the
 * product's expected price last changed (a promotion started or ended since:
 * it is read again within 3 days), a page that showed no price, and a price
 * in the other market's currency. A page that names no model at all is
 * compared but marked unconfirmed. Home Depot Canada keeps a kitchen sink at
 * MAP when its promo is under the 5% NLP minimum (the PIM's NLP workbook
 * leaves it out).
 */
async function loadPageAlignment(cfg) {
  const rows = (await pageReadings()).filter((r) => r.retailer === cfg.retailer);
  if (!rows.some((r) => r.read_at)) return null;
  const [{ baseBySku, promoBySku }, changedOn, categories] = await Promise.all([
    loadExpectedPrices(cfg),
    loadPriceChangeDays(cfg),
    cfg.nlpMinimum ? productCategories() : null,
  ]);
  const currency = cfg.market === 'us' ? 'USD' : 'CAD';
  const bySku = new Map();
  for (const r of rows) {
    const prev = bySku.get(r.sku);
    if (!prev || (r.read_at ?? '') > (prev.read_at ?? '')) bySku.set(r.sku, r);
  }
  const results = [];
  const left = { noPrice: 0, soldOut: 0, otherProduct: 0, otherCurrency: 0, readBeforeChange: 0 };
  let readFrom = null;
  let readTo = null;
  for (const [sku, r] of bySku) {
    if (!baseBySku.has(sku)) continue; // not a PIM product
    if (r.verdict === 'broken' && r.sku_check !== 'other') { results.push({ sku, state: 'missing' }); continue; }
    // 'listing' (the right listing on its default option): the price read is the default finish's.
    if (r.sku_check === 'other' || r.sku_check === 'variant' || r.sku_check === 'listing' || (r.sku_check === 'unknown' && r.page_model)) { left.otherProduct += 1; continue; }
    if (r.price == null || !r.read_at) { left[r.in_stock === false ? 'soldOut' : 'noPrice'] += 1; continue; }
    if (r.currency && r.currency !== currency) { left.otherCurrency += 1; continue; }
    if (changedOn.has(sku) && etDay(r.read_at) < changedOn.get(sku)) { left.readBeforeChange += 1; continue; }
    if (!readFrom || r.read_at < readFrom) readFrom = r.read_at;
    if (!readTo || r.read_at > readTo) readTo = r.read_at;
    const base = baseBySku.get(sku) ?? null;
    let promo = promoBySku.get(sku);
    if (promo && categories && base != null && NLP_CATEGORIES.has(categories.get(sku)) && nlpDiscount(base, promo.price) < NLP_MIN_DISCOUNT) promo = undefined;
    const expected = promo?.price ?? base;
    results.push({
      sku,
      state: 'live',
      price: r.price,
      expected: expected ?? null,
      expected_source: promo != null ? 'promo' : 'map',
      map: base,
      promo_period: promo?.period ?? null,
      promo_kind: promo?.kind ?? null,
      promo_window: promo ? { start: promo.windowStart, end: promo.windowEnd } : null,
      price_diff: expected != null && Math.abs(r.price - expected) > 0.01,
      url: r.url,
      read_at: r.read_at,
      sku_check: r.sku_check,
      in_stock: r.in_stock,
      page_note: r.page_note,
    });
  }
  return { ...classifySnapshot({ run_at: readTo, results }), readFrom, readTo, ...left };
}

/** Latest saved report for a target (cron or manual) — instant, no live pull. */
export async function loadLatestAlignment(target = DEFAULT_WIX_SITE) {
  const cfg = ALIGN_TARGETS[target];
  if (cfg.kind === 'page') return loadPageAlignment(cfg);
  if (cfg.kind === 'bestbuy' || cfg.kind === 'walmart') return loadOfferAlignment(cfg);
  const data = await latestChannelSnapshot(cfg.channel);
  if (!data?.length) return null;
  // Brand scope applies to older snapshots too: products of a brand the site
  // never carries are dropped before classifying (Azuni on the Stylish sites).
  let outOfScope = null;
  if (cfg.excludedBrands?.length) {
    const prods = await sharedLoad('products:brand', async () => {
      const { data, error } = await supabase.from('products').select('sku, brand');
      if (error) throw error;
      return data ?? [];
    });
    outOfScope = new Set(prods.filter((p) => !wixSiteSells(cfg, p)).map((p) => p.sku));
  }
  // The snapshot's expected prices are as old as the pull; the PIM's are
  // read now, so a price changed today is judged today. Live prices stay
  // as pulled.
  const { baseBySku, promoBySku } = await loadExpectedPrices(cfg);
  const results = (data[0].results ?? []).map((r) => {
    if (r.state !== 'live' || !baseBySku.has(r.sku)) return r;
    const base = baseBySku.get(r.sku) ?? null;
    const promo = promoBySku.get(r.sku);
    const expected = promo?.price ?? base;
    return {
      ...r,
      expected: expected ?? null,
      expected_source: promo != null ? 'promo' : 'map',
      map: base,
      promo_period: promo?.period ?? null,
      promo_kind: promo?.kind ?? null,
      price_diff: expected != null && r.price != null && Math.abs(r.price - expected) > 0.01,
    };
  });
  return classifySnapshot({ run_at: data[0].run_at, results }, outOfScope);
}

/**
 * Fresh live analysis — pulls the channel now and PERSISTS the snapshot. A
 * store read from its pages is not pulled (each page read costs a paid
 * unlocker request): its readings are read again as they are.
 */
export async function runPriceAlignment(target = DEFAULT_WIX_SITE) {
  const cfg = ALIGN_TARGETS[target];
  if (cfg.kind === 'page') {
    dropPageReadings();
    return loadLatestAlignment(target);
  }
  if (cfg.kind === 'bestbuy') await refreshBestBuyOffers();
  else if (cfg.kind === 'walmart') await refreshWalmartItems(cfg.market);
  else await refreshWixCatalog(target);
  dropShared(`snapshot:${cfg.channel}`); // the pull just wrote a new one
  return loadLatestAlignment(target);
}

/**
 * One analysis problem → one OF24 price update. A promo fix keeps the offer
 * at its regular MAP and adds the promo as a scheduled discount for exactly
 * the promo month; a plain misalignment just corrects the price.
 */
function buildBestBuyUpdate(p) {
  if (p.source === 'promo' && p.promo_period) {
    // The discount covers the CANADA window (first Thursday → day before the
    // next first Thursday). Mirakl drops a discount whose start date is not
    // in the future, so a window that already began is scheduled from
    // tomorrow.
    const w = p.promo_window ?? promoWindow({ period: p.promo_period }, 'ca');
    return {
      sku: p.sku,
      ...(p.map != null ? { price: p.map } : {}),
      discount_price: p.expected,
      discount_start_date: w.start > etToday() ? w.start : etToday(1),
      discount_end_date: w.end,
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
