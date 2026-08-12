import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { pushProductToWix, refreshWixCatalog } from '@/features/syndication/api/wixSync';

/**
 * Price Alignment Analyzer — Wix (SinksDirect) phase.
 *
 * Expected price rule: a SKU in an ACTIVE promotion is expected at its CAD
 * promo price; everything else at its regular MAP (the store's selling
 * price). Only PIM products count — Wix-only orphans are out of scope by
 * the source-of-truth rule.
 *
 * Reports are PERSISTED: the analysis reads the latest channel_health 'wix'
 * snapshot — written by the twice-daily cron AND by "Run analysis" (which
 * is just a fresh pull + snapshot). Opening the tab shows the last report
 * without running anything.
 *
 * Classifications:
 *   promo_ok      — live price = active promo price ✓
 *   map_ok        — live price = regular MAP ✓ (not in a promo)
 *   promo_missing — promo member still at the regular MAP ⚠
 *   misaligned    — neither promo nor MAP 🔴
 *   no_map        — nothing to compare against (no MAP in the PIM) ⚪
 *   missing       — linked but the Wix product no longer exists 🔴
 */

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

/** Latest saved report (cron or manual) — instant, no live pull. */
export async function loadLatestAlignment() {
  const { data, error } = await supabase
    .from('channel_health')
    .select('run_at, results')
    .eq('channel', 'wix')
    .order('run_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data?.length) return null;
  return classifySnapshot(data[0]);
}

/** Fresh live analysis — pulls Wix now and PERSISTS the snapshot. */
export async function runPriceAlignment() {
  await refreshWixCatalog();
  return loadLatestAlignment();
}

/**
 * Push ONE product's expected price to Wix — priceData only, so a fix can
 * never touch visibility or content. `expected` comes from the analysis
 * (promo price or regular MAP).
 */
export async function pushExpectedPrice(sku, expected) {
  await pushProductToWix(sku, { map_cad: expected }, ['priceData']);
}

/**
 * Fix a batch of analysis problems (the fixable ones), one by one.
 */
export async function fixAlignment(problems, onProgress) {
  const fixable = problems.filter((p) => p.expected != null);
  let done = 0;
  const failures = [];
  for (const p of fixable) {
    try {
      await pushExpectedPrice(p.sku, p.expected);
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
    summary: `Price alignment: pushed ${fixable.length - failures.length} corrected price${fixable.length - failures.length === 1 ? '' : 's'} to Wix`,
    metadata: { fixed: fixable.length - failures.length, failures: failures.length },
  });
  return { fixed: fixable.length - failures.length, failures };
}
