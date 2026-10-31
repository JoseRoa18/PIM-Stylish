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

// Several reads at once; `task` (optional taskProgress reporter) counts the
// settled ones ("3 of 8 tables").
function settleAll(reads, task, detail) {
  let done = 0;
  task?.count(0, reads.length, `${detail} (0 of ${reads.length} tables)`);
  return Promise.all(reads.map((p) => p.then((rows) => {
    done += 1;
    task?.count(done, reads.length, `${detail} (${done} of ${reads.length} tables)`);
    return rows;
  })));
}

async function loadExportData(task = null) {
  const [products, pim, audit, suggestions, inventory, aliases, amazon, bestBuy] = await settleAll([
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
  ], task, 'Loading the links and what the check found…');
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

/**
 * Build and download the Where to Buy Excel; returns { products, links, rows }.
 * `task` (optional taskProgress reporter): loading 45%, the rows and sheets
 * 10%, writing the workbook the rest.
 */
export async function downloadWhereToBuyExcel({ task = null } = {}) {
  const data = await loadExportData(task?.part(0, 0.45));
  if (task) await task.step(`Sorting ${data.audit.length.toLocaleString()} checked links…`);
  const rows = whereToBuyRows(data);
  if (!rows.length) throw new Error('No Where to Buy links to export.');
  const date = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, the person's own day
  if (task) await task.step(`Building the sheets for ${rows.length.toLocaleString()} rows…`);
  const sheets = whereToBuySheets(rows, date);
  task?.progress(0.55);
  const blob = await buildSectionedWorkbook(sheets, { validationFor: whereToBuyValidation, task: task?.part(0.55, 1) });
  downloadBlob(blob, `Stylish_Where_to_Buy_${date}.xlsx`);
  const result = { products: new Set(rows.map((r) => r.sku)).size, links: rows.filter((r) => r.url).length, rows: rows.length };
  logActivity({ action: 'export', entityType: 'channel', entityId: 'where_to_buy', target: 'pim', summary: `Where to Buy Excel: ${result.links} links of ${result.products} products`, metadata: result });
  return result;
}

/**
 * Read an uploaded file and work out what it changes (nothing is saved).
 * `task` (optional taskProgress reporter): the sheets 60%, the products and
 * their current links 35%, the comparison the rest.
 */
export async function readWhereToBuyImport(file, { task = null } = {}) {
  const parsed = await parseSpreadsheetFile(file, { scoreHeader: scoreWhereToBuyHeader, allSheets: true, task: task?.part(0, 0.6) });
  const names = parsed.headers.map((h) => h.toLowerCase());
  if (!names.includes('sku') || !names.includes('store') || !names.includes('new link')) {
    throw new Error('The file needs the SKU, Store and New Link columns — start from the Where to Buy export.');
  }
  const [products, current] = await settleAll([loadProducts(), loadLinks()], task?.part(0.6, 0.95), 'Reading the products and their links…');
  if (task) await task.step(`Comparing ${parsed.rows.length.toLocaleString()} rows with the PIM…`);
  const plan = planWhereToBuyImport(parsed.rows, { products, current });
  task?.progress(1);
  return plan;
}

/**
 * Save a plan's changes into the products' lists and publish their Stylish
 * pages (the audit's sync mode, 50 products a call: it writes the pages Wix
 * lets through now and queues the rest, then opens the new addresses).
 * Reports { done, total } as the products are published. `task` (optional
 * taskProgress reporter): saving 20% (batches of 500, one removal per
 * product), publishing the rest (calls of 50 products).
 */
export async function applyWhereToBuyImport(plan, onProgress, { task = null } = {}) {
  const now = new Date().toISOString();
  const set = plan.changes.filter((c) => c.action !== 'remove');
  const removed = plan.changes.filter((c) => c.action === 'remove');
  const removeBySku = new Map();
  for (const c of removed) removeBySku.set(c.sku, [...(removeBySku.get(c.sku) ?? []), c.retailer]);
  const saving = task?.part(0, 0.2);
  const writes = Math.ceil(set.length / 500) + removeBySku.size;
  let written = 0;
  const saved = () => { written += 1; saving?.count(written, writes, `Saving the links (${written} of ${writes} writes)…`); };
  saving?.count(0, writes, `Saving ${plan.changes.length.toLocaleString()} changes…`);
  for (let i = 0; i < set.length; i += 500) {
    const part = set.slice(i, i + 500).map((c) => ({ sku: c.sku, retailer: c.retailer, url: c.to, source: 'import', updated_at: now }));
    const { error } = await supabase.from('product_where_to_buy').upsert(part, { onConflict: 'sku,retailer' });
    if (error) throw error;
    saved();
  }
  for (const [sku, retailers] of removeBySku) {
    const { error } = await supabase.from('product_where_to_buy').delete().eq('sku', sku).in('retailer', retailers);
    if (error) throw error;
    saved();
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
  const publishing = task?.part(0.2, 1);
  onProgress?.({ done: 0, total: skus.length });
  for (let i = 0; i < skus.length; i += 50) {
    const part = skus.slice(i, i + 50);
    publishing?.count(i, skus.length, `Publishing products ${i + 1}–${i + part.length} of ${skus.length} on the Stylish pages…`);
    const { data, error } = await supabase.functions.invoke('where-to-buy-audit', { body: { mode: 'sync', skus: part } });
    if (error || data?.error) failures.push(`${part[0]}…: ${error?.message ?? data.error}`);
    for (const r of data?.published ?? []) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    onProgress?.({ done: Math.min(skus.length, i + part.length), total: skus.length });
    publishing?.count(Math.min(skus.length, i + part.length), skus.length);
  }
  return { products: skus.length, added: count('add'), replaced: count('replace'), removed: count('remove'), statuses, failures };
}
