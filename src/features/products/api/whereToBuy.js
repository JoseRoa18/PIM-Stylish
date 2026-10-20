// A product's WHERE TO BUY links (table product_where_to_buy — one address per
// store, the source of both Stylish pages' section), what the Listing Health
// audit last found on each, and the publish to Wix.

import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { WIX_SITES, wixSiteSells } from '@/features/syndication/lib/wixSites';
import { WTB_SITES, cleanWtbUrl, wtbUrlProblem } from '../lib/whereToBuy';

// A suggested link (table where_to_buy_suggestions, found and opened by the
// audit's "suggest" mode — only "ready" ones: their page showed the product).
export const SUGGESTION_COLUMNS = 'id, sku, retailer, url, reason, source, detail, current_url, status, status_note, page_model, price, currency, in_stock, checked_at';

/**
 * { links: { [retailer]: url }, checks: { [retailer]: { verdict, note, checked_at, checked_via,
 *   page_model, sku_check, page_note, price, was_price, currency, in_stock, read_at } },
 *   suggestions: { [retailer]: [suggestion] }, sites: [{ key, label, linked }] } — `sites` are
 *   the Stylish sites the product's brand is sold on; `linked` = the PIM knows its Wix product
 *   there (it can be published).
 */
export async function loadProductWhereToBuy(product) {
  const sku = product.sku;
  const [{ data: rows, error }, { data: checks, error: e2 }, { data: wix, error: e3 }, { data: suggested, error: e4 }] = await Promise.all([
    supabase.from('product_where_to_buy').select('retailer, url, source, updated_at').eq('sku', sku),
    supabase.from('where_to_buy_links').select('site, retailer, url, verdict, note, checked_at, checked_via, page_model, sku_check, page_note, price, was_price, currency, in_stock, read_at').eq('sku', sku).not('url', 'is', null),
    supabase.from('wix_links').select('site').eq('sku', sku).in('site', WTB_SITES.map((s) => s.key)),
    supabase.from('where_to_buy_suggestions').select(SUGGESTION_COLUMNS).eq('sku', sku).eq('status', 'ready').order('checked_at', { ascending: false }),
  ]);
  if (error) throw error;
  if (e2) throw e2;
  if (e3) throw e3;
  if (e4) throw e4;
  const suggestions = {};
  for (const s of suggested ?? []) (suggestions[s.retailer] ??= []).push(s);
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
  return { links, checks: checksBy, suggestions, sites };
}

/**
 * Save the product's links ({ [retailer]: url | '' }) and publish them to its
 * Stylish pages. Returns { changed, published: [{ site, label, status, error? }] }.
 * `suggested` = the retailers whose new address is a suggestion the person used
 * (kept as the link's source).
 */
export async function saveProductWhereToBuy(product, draft, current, { suggested = [] } = {}) {
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
    upserts.push({ sku, retailer, url, source: suggested.includes(retailer) ? 'suggested' : 'manual', updated_at: new Date().toISOString() });
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
    summary: `Where to Buy links of ${sku}: ${upserts.length} set${upserts.some((u) => u.source === 'suggested') ? ` (${upserts.filter((u) => u.source === 'suggested').length} suggested by the PIM)` : ''}, ${removed.length} removed`,
    metadata: { set: upserts.map((u) => ({ retailer: u.retailer, url: u.url, source: u.source })), removed },
  });
  const published = await publishWhereToBuy(product);
  return { changed: upserts.length + removed.length, published };
}

/**
 * Use suggested links: each product's list gets the suggested address for that
 * store and its Stylish pages are published (the audit's sync marks the
 * suggestions used). One product after the other; reports { done, total, errors }.
 */
export async function applyWhereToBuySuggestions(suggestions, onProgress) {
  const bySku = new Map();
  for (const s of suggestions) {
    if (!bySku.has(s.sku)) bySku.set(s.sku, new Map());
    bySku.get(s.sku).set(s.retailer, s.url); // one address per store
  }
  const skus = [...bySku.keys()];
  const [{ data: products, error }, { data: rows, error: e2 }] = await Promise.all([
    supabase.from('products').select('sku, brand').in('sku', skus),
    supabase.from('product_where_to_buy').select('sku, retailer, url').in('sku', skus),
  ]);
  if (error) throw error;
  if (e2) throw e2;
  let done = 0;
  let errors = 0;
  const failures = [];
  for (const product of products ?? []) {
    const current = Object.fromEntries((rows ?? []).filter((r) => r.sku === product.sku).map((r) => [r.retailer, r.url]));
    const chosen = Object.fromEntries(bySku.get(product.sku));
    try {
      const r = await saveProductWhereToBuy(product, { ...current, ...chosen }, current, { suggested: Object.keys(chosen) });
      if (r.published.some((x) => x.status === 'error')) { errors += 1; failures.push(`${product.sku}: ${r.published.find((x) => x.status === 'error').error}`); }
    } catch (err) {
      errors += 1;
      failures.push(`${product.sku}: ${err.message}`);
    }
    done += 1;
    onProgress?.({ done, total: products.length, errors });
  }
  return { done, errors, failures };
}

/** Set a suggestion aside: it is not suggested again. */
export async function dismissWhereToBuySuggestion(suggestion) {
  const { data: { session } } = await supabase.auth.getSession();
  const { error } = await supabase
    .from('where_to_buy_suggestions')
    .update({ status: 'dismissed', decided_at: new Date().toISOString(), decided_by: session?.user?.id ?? null, updated_at: new Date().toISOString() })
    .eq('id', suggestion.id);
  if (error) throw error;
  logActivity({
    action: 'update',
    entityType: 'product',
    entityId: suggestion.sku,
    target: 'pim',
    summary: `Where to Buy: suggested ${suggestion.retailer} link of ${suggestion.sku} dismissed`,
    metadata: { retailer: suggestion.retailer, url: suggestion.url, reason: suggestion.reason },
  });
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
