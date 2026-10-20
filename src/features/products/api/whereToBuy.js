// A product's WHERE TO BUY links (table product_where_to_buy — one address per
// store, the source of both Stylish pages' section), what the Listing Health
// audit last found on each, and the publish to Wix.

import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { WIX_SITES, wixSiteSells } from '@/features/syndication/lib/wixSites';
import { WTB_SITES, cleanWtbUrl, wtbUrlProblem } from '../lib/whereToBuy';

/**
 * { links: { [retailer]: url }, checks: { [retailer]: { verdict, note, checked_at, checked_via } },
 *   sites: [{ key, label, linked }] } — `sites` are the Stylish sites the product's brand
 *   is sold on; `linked` = the PIM knows its Wix product there (it can be published).
 */
export async function loadProductWhereToBuy(product) {
  const sku = product.sku;
  const [{ data: rows, error }, { data: checks, error: e2 }, { data: wix, error: e3 }] = await Promise.all([
    supabase.from('product_where_to_buy').select('retailer, url, source, updated_at').eq('sku', sku),
    supabase.from('where_to_buy_links').select('site, retailer, url, verdict, note, checked_at, checked_via').eq('sku', sku).not('url', 'is', null),
    supabase.from('wix_links').select('site').eq('sku', sku).in('site', WTB_SITES.map((s) => s.key)),
  ]);
  if (error) throw error;
  if (e2) throw e2;
  if (e3) throw e3;
  const links = Object.fromEntries((rows ?? []).map((r) => [r.retailer, r.url]));
  // The audit keeps one row per site; both carry the same address and answer.
  // Only an answer about the address the PIM has now counts.
  const checksBy = {};
  for (const c of checks ?? []) {
    if (links[c.retailer] !== c.url) continue;
    const prev = checksBy[c.retailer];
    if (!prev || (c.checked_at ?? '') > (prev.checked_at ?? '')) checksBy[c.retailer] = c;
  }
  const linkedSites = new Set((wix ?? []).map((w) => w.site));
  const sites = WTB_SITES.filter((s) => wixSiteSells(s.key, product)).map((s) => ({ key: s.key, label: s.label, linked: linkedSites.has(s.key) }));
  return { links, checks: checksBy, sites };
}

/**
 * Save the product's links ({ [retailer]: url | '' }) and publish them to its
 * Stylish pages. Returns { changed, published: [{ site, label, status, error? }] }.
 */
export async function saveProductWhereToBuy(product, draft, current) {
  const sku = product.sku;
  const upserts = [];
  const removed = [];
  for (const [retailer, raw] of Object.entries(draft)) {
    const url = raw?.trim() ? cleanWtbUrl(raw) : '';
    const before = current[retailer] ?? '';
    if (url === before) continue;
    if (!url) { removed.push(retailer); continue; }
    const problem = wtbUrlProblem(retailer, url);
    if (problem) throw new Error(`${retailer}: ${problem}`);
    upserts.push({ sku, retailer, url, source: 'manual', updated_at: new Date().toISOString() });
  }
  if (!upserts.length && !removed.length) return { changed: 0, published: await publishWhereToBuy(product) };
  if (upserts.length) {
    const { error } = await supabase.from('product_where_to_buy').upsert(upserts, { onConflict: 'sku,retailer' });
    if (error) throw error;
  }
  if (removed.length) {
    const { error } = await supabase.from('product_where_to_buy').delete().eq('sku', sku).in('retailer', removed);
    if (error) throw error;
  }
  logActivity({
    action: 'update',
    entityType: 'product',
    entityId: sku,
    target: 'pim',
    summary: `Where to Buy links of ${sku}: ${upserts.length} set, ${removed.length} removed`,
    metadata: { set: upserts.map((u) => ({ retailer: u.retailer, url: u.url })), removed },
  });
  const published = await publishWhereToBuy(product);
  return { changed: upserts.length + removed.length, published };
}

/**
 * Write the PIM's list into the WHERE TO BUY section of each Stylish page the
 * product is on — the audit's `sync` mode does it server side: it rebuilds the
 * product's audit rows, writes the pages (every link but the broken ones;
 * only that section changes, dimensions, documents, videos… stay as they
 * are) and checks the new addresses; one that turns out broken leaves the
 * pages by itself a few minutes later.
 */
export async function publishWhereToBuy(product) {
  const { data, error } = await supabase.functions.invoke('where-to-buy-audit', { body: { mode: 'sync', skus: [product.sku] } });
  if (error) throw new Error(error.message ?? 'Publishing failed');
  if (data?.error) throw new Error(data.error);
  return (data?.published ?? []).map((r) => ({
    site: r.site,
    label: WIX_SITES[r.site]?.label ?? WTB_SITES.find((s) => s.key === r.site)?.label ?? r.site,
    status: r.status,
    error: r.error,
  }));
}
