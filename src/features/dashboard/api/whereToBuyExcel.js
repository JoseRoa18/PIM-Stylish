// The Where to Buy Excel: export the links with the audit's findings, and
// upload the file back (the "New Link" column) to change many links at once.
// Loaded on click from the Where to Buy panel; the sheets and the upload rules
// are in lib/whereToBuyExcel.js.

import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { buildSectionedWorkbook } from '@/features/import/lib/sectionedXlsx';
import { parseSpreadsheetFile } from '@/features/import/lib/parseSpreadsheet';
import { latestSnapshot } from '@/features/syndication/lib/channels';
import { whereToBuyRows, whereToBuySheets, whereToBuyValidation, scoreWhereToBuyHeader, planWhereToBuyImport } from '../lib/whereToBuyExcel';

const PAGE = 1000;
const SITES = ['stylish_ca', 'stylish_us'];

// Every row of a query, page after page (the API returns at most 1,000), in a
// unique order so no row is read twice or skipped.
async function readAll(table, columns, { filter = (q) => q, order }) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = filter(supabase.from(table).select(columns));
    for (const o of order) q = q.order(o);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const loadProducts = () => readAll('products', 'sku, model_name, category, brand, is_obsolete, upc:attributes->>upc', { order: ['sku'] });
const loadLinks = () => readAll('product_where_to_buy', 'sku, retailer, url', { order: ['sku', 'retailer'] });

async function loadExportData() {
  const [products, pim, audit, suggestions, inventory, aliases, amazon, bestBuy] = await Promise.all([
    loadProducts(),
    loadLinks(),
    readAll('where_to_buy_links', 'id, sku, retailer, url, verdict, note, checked_at, checked_via, page_model, sku_check, page_note, price, was_price, currency, in_stock, read_at', {
      filter: (q) => q.in('site', SITES).eq('section', 'where_to_buy'),
      order: ['id'],
    }),
    readAll('where_to_buy_suggestions', 'id, sku, retailer, url, checked_at', { filter: (q) => q.eq('status', 'ready'), order: ['id'] }),
    readAll('product_inventory', 'market, sku, available', { order: ['market', 'sku'] }),
    readAll('product_aliases', 'sku, marketplace, alias', { order: ['sku', 'marketplace'] }),
    readAll('amazon_links', 'marketplace, sku, seller_sku, asin', { order: ['marketplace', 'sku'] }),
    latestSnapshot('bestbuy').then((s) => s?.results ?? []),
  ]);
  return { products, pim, audit, suggestions, inventory, aliases, amazon, bestBuy };
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Build and download the Where to Buy Excel; returns { products, links, rows }. */
export async function downloadWhereToBuyExcel() {
  const rows = whereToBuyRows(await loadExportData());
  if (!rows.length) throw new Error('No Where to Buy links to export.');
  const date = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, the person's own day
  const blob = await buildSectionedWorkbook(whereToBuySheets(rows, date), { validationFor: whereToBuyValidation });
  downloadBlob(blob, `Stylish_Where_to_Buy_${date}.xlsx`);
  const result = { products: new Set(rows.map((r) => r.sku)).size, links: rows.filter((r) => r.url).length, rows: rows.length };
  logActivity({ action: 'export', entityType: 'channel', entityId: 'where_to_buy', target: 'pim', summary: `Where to Buy Excel: ${result.links} links of ${result.products} products`, metadata: result });
  return result;
}

/** Read an uploaded file and work out what it changes (nothing is saved). */
export async function readWhereToBuyImport(file) {
  const parsed = await parseSpreadsheetFile(file, { scoreHeader: scoreWhereToBuyHeader, allSheets: true });
  const names = parsed.headers.map((h) => h.toLowerCase());
  if (!names.includes('sku') || !names.includes('store') || !names.includes('new link')) {
    throw new Error('The file needs the SKU, Store and New Link columns — start from the Where to Buy export.');
  }
  const [products, current] = await Promise.all([loadProducts(), loadLinks()]);
  return planWhereToBuyImport(parsed.rows, { products, current });
}

/**
 * Save a plan's changes into the products' lists and publish their Stylish
 * pages (the audit's sync mode, 50 products a call: it writes the pages Wix
 * lets through now and queues the rest, then opens the new addresses).
 * Reports { done, total } as the products are published.
 */
export async function applyWhereToBuyImport(plan, onProgress) {
  const now = new Date().toISOString();
  const set = plan.changes.filter((c) => c.action !== 'remove');
  const removed = plan.changes.filter((c) => c.action === 'remove');
  for (let i = 0; i < set.length; i += 500) {
    const part = set.slice(i, i + 500).map((c) => ({ sku: c.sku, retailer: c.retailer, url: c.to, source: 'import', updated_at: now }));
    const { error } = await supabase.from('product_where_to_buy').upsert(part, { onConflict: 'sku,retailer' });
    if (error) throw error;
  }
  const removeBySku = new Map();
  for (const c of removed) removeBySku.set(c.sku, [...(removeBySku.get(c.sku) ?? []), c.retailer]);
  for (const [sku, retailers] of removeBySku) {
    const { error } = await supabase.from('product_where_to_buy').delete().eq('sku', sku).in('retailer', retailers);
    if (error) throw error;
  }
  const skus = [...new Set(plan.changes.map((c) => c.sku))];
  const count = (a) => plan.changes.filter((c) => c.action === a).length;
  logActivity({
    action: 'import',
    entityType: 'channel',
    entityId: 'where_to_buy',
    target: 'pim',
    summary: `Where to Buy import: ${count('add')} links added, ${count('replace')} replaced, ${count('remove')} removed on ${skus.length} products`,
    metadata: { changes: plan.changes.slice(0, 500).map(({ sku, retailer, action, from, to }) => ({ sku, retailer, action, from, to })), problems: plan.problems.length },
  });

  const statuses = {};
  const failures = [];
  onProgress?.({ done: 0, total: skus.length });
  for (let i = 0; i < skus.length; i += 50) {
    const part = skus.slice(i, i + 50);
    const { data, error } = await supabase.functions.invoke('where-to-buy-audit', { body: { mode: 'sync', skus: part } });
    if (error || data?.error) failures.push(`${part[0]}…: ${error?.message ?? data.error}`);
    for (const r of data?.published ?? []) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    onProgress?.({ done: Math.min(skus.length, i + part.length), total: skus.length });
  }
  return { products: skus.length, added: count('add'), replaced: count('replace'), removed: count('remove'), statuses, failures };
}
