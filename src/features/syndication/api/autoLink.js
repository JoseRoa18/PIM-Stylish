import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { WIX_SITES } from '../lib/wixSites';
import { createProductOnWix } from './wixSync';
import { getAppSetting } from '@/features/settings/api/appSettings';

/**
 * Auto-link freshly created/imported products to every API-connected channel
 * (requirement 2026-08-20: "cada vez que un producto se suba, se vincula solo").
 *
 *  - Wix (4 sites): SKU-match link via the wix-import-products edge function
 *    in link-only mode — writes wix_links / the legacy CA column, NEVER
 *    writes anything to the Wix stores themselves.
 *  - Wayfair Canada: fetches the item-group id for these SKUs and stores it
 *    on products.wayfair_item_group_id (wayfair-pull-groups, apply mode).
 *  - Best Buy / Walmart US: those channels have no per-product link — the
 *    PIM matches them by SKU against the latest snapshot, so presence is
 *    reported here as information only.
 *
 * Every step is idempotent and a no-op for products that don't exist on the
 * channel yet — a brand-new product simply links later (re-run any time from
 * the product's Marketplaces tab).
 */
export async function autoLinkChannels(skus) {
  const list = [skus].flat().filter(Boolean);
  if (!list.length) return null;

  const summary = { wix: {}, wayfair: 0, bestbuy: 0, walmart_us: 0, errors: [] };

  // --- Wix: one link-only run per site (matches by SKU, idempotent) --------
  await Promise.allSettled(
    Object.keys(WIX_SITES).map(async (site) => {
      try {
        const { data, error } = await supabase.functions.invoke('wix-import-products', {
          body: { dryRun: false, site },
        });
        if (error) throw new Error(error.message);
        if (data?.error) throw new Error(data.error);
      } catch (err) {
        summary.errors.push(`${WIX_SITES[site].label}: ${err.message}`);
      }
    }),
  );
  // Which of OUR skus ended up linked, per site.
  const { data: links } = await supabase
    .from('wix_links')
    .select('site, sku')
    .in('sku', list);
  for (const l of links ?? []) summary.wix[l.site] = (summary.wix[l.site] ?? 0) + 1;

  // --- Wayfair Canada: store the listing's item-group id when it exists ----
  try {
    const { data, error } = await supabase.functions.invoke('wayfair-pull-groups', {
      body: { skus: list, apply: true, supplier: 'CAN' },
    });
    if (error) throw new Error(error.message);
    summary.wayfair = data?.updates?.length ?? data?.applied ?? 0;
  } catch (err) {
    summary.errors.push(`Wayfair: ${err.message}`);
  }

  // --- Snapshot-only channels: report presence, write nothing --------------
  for (const channel of ['bestbuy', 'walmart_us']) {
    try {
      const { data } = await supabase
        .from('channel_health')
        .select('results')
        .eq('channel', channel)
        .order('run_at', { ascending: false })
        .limit(1);
      const listed = new Set((data?.[0]?.results ?? []).map((r) => r.sku));
      summary[channel] = list.filter((s) => listed.has(s)).length;
    } catch {
      // informational only — never block the link run on a snapshot read
    }
  }

  const wixTotal = Object.values(summary.wix).reduce((a, b) => a + b, 0);
  logActivity({
    action: 'update',
    entityType: 'product',
    entityId: list.length === 1 ? list[0] : `${list.length} products`,
    target: 'channels',
    summary:
      `Auto-linked ${list.length === 1 ? list[0] : `${list.length} products`} across channels — ` +
      `Wix links: ${wixTotal}, Wayfair: ${summary.wayfair}` +
      (summary.errors.length ? ` · ${summary.errors.length} channel error(s)` : ''),
    metadata: { skus: list.slice(0, 50), ...summary },
  });
  return summary;
}

/**
 * Ready-to-Sell gate (requirement 2026-08-20): the moment a product reaches
 * that status, link it on the Wix stores where it already exists and CREATE
 * the listing on the enabled stores where it doesn't — content, price rule
 * and images all come from the PIM. Switches live in /settings
 * (app_settings key 'wix_auto_create': { enabled, sites }).
 *
 * The status is the safety gate: per the SOP, Ready to Sell means the data
 * passed review, so nothing half-filled ever goes live on its own.
 */
export async function autoPublishToWix(skus) {
  const list = [skus].flat().filter(Boolean);
  if (!list.length) return null;

  const settings = await getAppSetting('wix_auto_create', { enabled: true, sites: Object.keys(WIX_SITES) });
  if (settings.enabled === false) return { skipped: 'disabled in Settings' };
  const sites = (settings.sites?.length ? settings.sites : Object.keys(WIX_SITES))
    .filter((s) => WIX_SITES[s]);

  // 1. Adopt listings that already exist anywhere (idempotent link pass).
  await autoLinkChannels(list);

  // 2. What is linked now, per (site, sku) — incl. the legacy CA column.
  const { data: links } = await supabase
    .from('wix_links')
    .select('site, sku')
    .in('sku', list);
  const linked = new Set((links ?? []).map((l) => `${l.site}|${l.sku}`));
  const { data: legacy } = await supabase
    .from('products')
    .select('sku')
    .in('sku', list)
    .not('wix_product_id', 'is', null);
  for (const p of legacy ?? []) linked.add(`sinksdirect_ca|${p.sku}`);

  // 3. Create the missing listings on the enabled stores. HARD GATE (user
  // rule 2026-08-20): a product with no price for that store is NEVER
  // published there — it's skipped and reported instead.
  const priceFields = [...new Set(sites.map((s) => WIX_SITES[s].priceField))];
  const { data: prods } = await supabase
    .from('products')
    .select(`sku, ${priceFields.join(', ')}`)
    .in('sku', list);
  const priceBySku = new Map((prods ?? []).map((p) => [p.sku, p]));

  const summary = { created: [], alreadyLinked: 0, noPrice: [], failed: [] };
  for (const sku of list) {
    for (const site of sites) {
      if (linked.has(`${site}|${sku}`)) {
        summary.alreadyLinked += 1;
        continue;
      }
      const cfg = WIX_SITES[site];
      const price = Number(priceBySku.get(sku)?.[cfg.priceField]);
      if (!(price > 0)) {
        summary.noPrice.push(`${sku} → ${cfg.label} (no ${cfg.priceShort ?? cfg.priceField})`);
        continue;
      }
      try {
        await createProductOnWix(sku, site);
        summary.created.push(`${sku} → ${cfg.label}`);
      } catch (err) {
        summary.failed.push(`${sku} → ${cfg.label}: ${err.message}`);
      }
    }
  }

  logActivity({
    action: 'push',
    entityType: 'product',
    entityId: list.length === 1 ? list[0] : `${list.length} products`,
    target: 'wix',
    summary:
      `Ready to Sell auto-publish — created ${summary.created.length} Wix listing(s), ` +
      `${summary.alreadyLinked} already linked` +
      (summary.noPrice.length ? ` · ${summary.noPrice.length} skipped (no price)` : '') +
      (summary.failed.length ? ` · ${summary.failed.length} failed` : ''),
    metadata: { skus: list.slice(0, 50), sites, ...summary },
  });
  return summary;
}
