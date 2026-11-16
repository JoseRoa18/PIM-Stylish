import { supabase } from '@/lib/supabase';
import { etToday, promoWindow } from '../lib/promoCalendar';
import { dropShared, latestReport, dropPageReadings } from './expectedPrices';
import { alignTargets } from '../../../../supabase/functions/_shared/priceAlignmentReport.js';
import { logActivity } from '@/features/activity/api/activityLog';
import { pushProductToWix, refreshWixCatalog } from '@/features/syndication/api/wixSync';
import { refreshBestBuyOffers, pushBestBuyPrices } from '@/features/syndication/api/bestbuySync';
import { refreshWalmartItems } from '@/features/syndication/api/walmartSync';
import { WIX_SITES, DEFAULT_WIX_SITE } from '@/features/syndication/lib/wixSites';

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
export const ALIGN_TARGETS = alignTargets(WIX_SITES);
export const ALIGN_TARGET_KEYS = Object.keys(ALIGN_TARGETS);

/** Latest saved report for a target (cron or manual): instant, no live pull. */
export function loadLatestAlignment(target = DEFAULT_WIX_SITE, { task = null } = {}) {
  return latestReport(ALIGN_TARGETS[target], { task });
}

/**
 * Fresh live analysis — pulls the channel now and PERSISTS the snapshot. A
 * store read from its pages is not pulled (each page read costs a paid
 * unlocker request): its readings are read again as they are. `task`
 * (optional taskProgress reporter): the pull (one call, no share to
 * measure) up to 70%, then the report read again.
 */
export async function runPriceAlignment(target = DEFAULT_WIX_SITE, { task = null } = {}) {
  const cfg = ALIGN_TARGETS[target];
  if (cfg.kind === 'page') {
    dropPageReadings();
    return loadLatestAlignment(target, { task });
  }
  task?.step(`Pulling the live prices from ${cfg.label}…`);
  if (cfg.kind === 'bestbuy') await refreshBestBuyOffers();
  else if (cfg.kind === 'walmart') await refreshWalmartItems(cfg.market);
  else await refreshWixCatalog(target);
  task?.progress(0.7);
  dropShared(`snapshot:${cfg.channel}`); // the pull just wrote a new one
  return loadLatestAlignment(target, { task: task?.part(0.7, 1) });
}

// "Read again" asks the Where to Buy check for a few products a call (each
// page takes 10–60 s to open) and a few calls at a time.
const REREAD_PER_CALL = 3;
const REREAD_CALLS = 4;

/**
 * "Read again" (user, 2026-11-16: a store had changed a price hours after its
 * page was read — C233 on Wayfair.ca — and the list still showed the old one).
 * Opens NOW the pages of these products on a store read from its pages
 * (where-to-buy-audit, mode "reread": admins and editors) and keeps what each
 * one shows, so the report read after it compares today's price. Each page is
 * a paid request: only what a person asks for goes through here.
 * `task` (optional taskProgress reporter) counts the products asked.
 * → { asked, bySku: { [sku]: { state, price, note } }, read, waiting, broken, unanswered }
 *   state: 'read' (the page was opened), 'waiting' (Lowe's and Menards answer
 *   in a few minutes), 'broken' (the link no longer opens the product),
 *   'unanswered' (the store gave no answer: the check tries it again by itself).
 */
export async function rereadStorePages(target, skus, { task = null } = {}) {
  const cfg = ALIGN_TARGETS[target];
  if (cfg?.kind !== 'page') throw new Error('Only a store read from its pages can be read again');
  const list = [...new Set(skus)];
  const parts = [];
  for (let i = 0; i < list.length; i += REREAD_PER_CALL) parts.push(list.slice(i, i + REREAD_PER_CALL));
  const bySku = Object.fromEntries(list.map((sku) => [sku, { state: 'unanswered', price: null, note: null }]));
  // The best answer among a product's links to the store (its pages can carry two).
  const RANK = { read: 3, waiting: 2, broken: 1, unanswered: 0 };
  const stateOf = (l) => (l.kind === 'ok' ? 'read' : l.kind === 'submitted' || l.kind === 'waiting' ? 'waiting' : l.kind === 'broken' ? 'broken' : 'unanswered');
  let refused = null;
  let done = 0;
  let next = 0;
  task?.count(0, list.length, `Opening ${list.length === 1 ? 'the page' : `${list.length} pages`} on ${cfg.short}…`);
  const lane = async () => {
    while (next < parts.length && !refused) {
      const part = parts[next++];
      try {
        const { data, error } = await supabase.functions.invoke('where-to-buy-audit', { body: { mode: 'reread', retailer: cfg.retailer, skus: part } });
        if (error) {
          // The function's own words (a role that may not ask, a wrong store).
          const said = await error.context?.json?.().catch(() => null);
          if (said?.error) { refused = new Error(said.error); break; }
          throw error;
        }
        if (data?.error) { refused = new Error(data.error); break; }
        for (const l of data?.links ?? []) {
          const state = stateOf(l);
          if (bySku[l.sku] && RANK[state] >= RANK[bySku[l.sku].state]) bySku[l.sku] = { state, price: l.page?.price ?? null, note: l.note ?? null };
        }
      } catch {
        // No answer to this call (a timeout, the network): its pages stay
        // "unanswered" — the check's own batches read them within minutes.
      }
      done += part.length;
      task?.count(done, list.length, `${done} of ${list.length} ${list.length === 1 ? 'page' : 'pages'} on ${cfg.short}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(REREAD_CALLS, parts.length) }, lane));
  dropPageReadings(); // what was just read is read fresh
  if (refused) throw refused;
  const count = (state) => list.filter((sku) => bySku[sku].state === state).length;
  const out = { asked: list.length, bySku, read: count('read'), waiting: count('waiting'), broken: count('broken'), unanswered: count('unanswered') };
  logActivity({
    action: 'sync',
    entityType: 'channel',
    entityId: cfg.key,
    target: 'pim',
    summary: `Price Alignment: ${list.length === 1 ? `the ${cfg.label} page of ${list[0]}` : `${list.length} ${cfg.label} pages`} read again (${out.read} read${out.waiting ? `, ${out.waiting} answering later` : ''}${out.broken ? `, ${out.broken} no longer on the store` : ''}${out.unanswered ? `, ${out.unanswered} without an answer` : ''})`,
    metadata: { store: cfg.key, asked: list.length, read: out.read, waiting: out.waiting, broken: out.broken, unanswered: out.unanswered, skus: list.slice(0, 200) },
  });
  return out;
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
