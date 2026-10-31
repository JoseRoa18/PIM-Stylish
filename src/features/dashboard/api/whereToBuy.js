// "Where to Buy" audit — reads the rows the where-to-buy-audit edge function
// keeps, and drives its scan / check modes from the UI.

import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

const PAGE = 1000;

/**
 * All link rows of one Stylish site (paged past the 1,000-row REST cap).
 * `task` (optional taskProgress reporter): page N of M — with a task the
 * first page also asks for the row count, so the number of pages is known.
 */
export async function loadWhereToBuy(site, { task = null } = {}) {
  const rows = [];
  let pages = null;
  for (let from = 0, page = 1; ; from += PAGE, page += 1) {
    const { data, error, count } = await supabase
      .from('where_to_buy_links')
      .select('id, site, sku, wix_product_id, section, market, retailer, label, url, host, retailer_id, expected_id, verdict, http_status, final_url, note, scanned_at, checked_at, checked_via, next_check_at, page_model, sku_check, page_note, price, was_price, currency, in_stock, read_at', task && page === 1 ? { count: 'exact' } : undefined)
      .eq('site', site)
      .order('sku')
      .order('section')
      .order('retailer')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (page === 1 && count != null) pages = Math.max(1, Math.ceil(count / PAGE));
    if (pages) task?.count(Math.min(page, pages), pages, `Loading the links (page ${Math.min(page + 1, pages)} of ${pages})…`);
    if (!data || data.length < PAGE) break;
  }
  task?.progress(1, `${rows.length.toLocaleString()} links loaded`);
  return rows;
}

async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('where-to-buy-audit', { body });
  if (error) throw new Error(error.message ?? 'Audit call failed');
  if (data?.error) throw new Error(data.error);
  return data;
}

/** Re-read both Stylish sites' sections and rebuild the rows. */
export async function scanWhereToBuy(sites) {
  const r = await invoke({ mode: 'scan', sites });
  logActivity({
    action: 'audit',
    entityType: 'channel',
    entityId: 'where_to_buy',
    target: 'stylish',
    summary: `Where to Buy scan: ${r.sites.map((s) => `${s.label} ${s.links} links, ${s.missing} links to add, ${s.broken} broken addresses`).join(' · ')}`,
    metadata: r,
  });
  return r;
}

/**
 * Check the links that are due, batch after batch (each call takes up to
 * ~2 minutes: stores that block the PIM are opened through Bright Data or
 * ScraperAPI), until none remain or `maxCalls` batches ran — the automatic
 * pass (every 10 minutes) picks up the rest. Reports progress after every batch.
 * `task` (optional taskProgress reporter) moves by the links checked of `due`
 * (whereToBuyStatus' count, when known) or by the calls of `maxCalls`,
 * whichever is further: the run stops at `maxCalls` either way.
 */
export async function checkWhereToBuy({ onProgress, maxCalls = 10, task = null, due = null } = {}) {
  let total = 0;
  const share = (calls) => Math.max(calls / maxCalls, due > 0 ? Math.min(1, total / due) : 0);
  const checkedText = () => `${total.toLocaleString()}${due > 0 ? ` of ${due.toLocaleString()}` : ''} links checked`;
  for (let i = 0; i < maxCalls; i++) {
    // the first batch shows the moving stripe: nothing is measured before it answers
    if (i === 0) task?.step(`Checking the links that are due${due > 0 ? ` (${due.toLocaleString()})` : ''}…`);
    else task?.progress(share(i), `Batch ${i + 1} of up to ${maxCalls} · ${checkedText()}…`);
    const r = await invoke({ mode: 'check' });
    total += r.checked ?? 0;
    onProgress?.({ checked: total, batch: r });
    task?.progress(share(i + 1), checkedText());
    if (!r.morePending || (r.checked ?? 0) === 0) return { checked: total, done: true };
  }
  return { checked: total, done: false };
}

/**
 * The suggested links ready to use (found and opened by the audit's "suggest"
 * mode: their page shows the product) and how many are still being checked.
 */
export async function loadWhereToBuySuggestions() {
  const [{ data, error }, { count, error: e2 }] = await Promise.all([
    supabase
      .from('where_to_buy_suggestions')
      .select('id, sku, retailer, url, reason, source, detail, current_url, status, status_note, page_model, price, currency, in_stock, checked_at')
      .eq('status', 'ready')
      .order('sku')
      .order('retailer')
      .limit(1000),
    supabase.from('where_to_buy_suggestions').select('id', { count: 'exact', head: true }).eq('status', 'to_check'),
  ]);
  if (error) throw error;
  if (e2) throw e2;
  return { ready: data ?? [], checking: count ?? 0 };
}

/** { due, scannedAt, differs: { [site]: skus whose live section is not the PIM's list } } */
export async function whereToBuyStatus() {
  return invoke({ mode: 'status' });
}

/**
 * Write the PIM's Where to Buy list to the Stylish pages of these products
 * again, one after the other (a page edited by hand in Wix goes back to the
 * PIM's links). Reports { done, total, errors } after each product; `task`
 * (optional taskProgress reporter): product N of M.
 */
export async function republishWhereToBuy(skus, onProgress, { task = null } = {}) {
  const { publishWhereToBuy } = await import('@/features/products/api/whereToBuy');
  const { data, error } = await supabase.from('products').select('sku, brand').in('sku', skus);
  if (error) throw error;
  let done = 0;
  let errors = 0;
  for (const product of data ?? []) {
    task?.count(done, data.length, `Publishing ${product.sku} (${done + 1} of ${data.length})…`);
    try {
      const r = await publishWhereToBuy(product);
      if (r.some((x) => x.status === 'error')) errors += 1;
    } catch { errors += 1; }
    done += 1;
    onProgress?.({ done, total: data.length, errors });
  }
  task?.progress(1);
  return { done, errors };
}
