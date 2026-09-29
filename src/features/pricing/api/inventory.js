import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

/**
 * Stock per product and market, CACHED in product_inventory by the
 * `inventory-pull` edge function (hourly via pg_cron, after every product
 * insert, or by hand). One source per market:
 *   us — ShipStation Inventory (Flowery Branch GA). ShipStation's list omits
 *        sold-out SKUs, so a row with `dropped_at` is a SKU it stopped
 *        listing: kept at 0 until it is back.
 *   ca — the "Stylish Inventory" Excel on SharePoint (PART NUMBER, QUANTITY
 *        IN STOCK CANADA, ETA CAN), read automatically once the PIM can reach
 *        it, or uploaded in Settings. The file lists its own zeros; a SKU
 *        not in the file is not tracked.
 * A SKU without a row is not tracked — unknown, not zero.
 */
export const STOCK_MARKETS = { ca: 'Canada', us: 'USA' };
const NOT_TRACKED = { ca: 'Not in the Canada inventory file', us: 'Not tracked in ShipStation (USA warehouse)' };

const COLUMNS = 'sku, on_hand, available, warehouses, source, eta, dropped_at, synced_at';

async function rowsFor(market, skus) {
  const out = {};
  // Chunks of 100 SKUs, fetched in parallel (they used to go one by one).
  const chunks = [];
  for (let i = 0; i < skus.length; i += 100) chunks.push(skus.slice(i, i + 100));
  const results = await Promise.all(chunks.map((part) => supabase
    .from('product_inventory')
    .select(COLUMNS)
    .eq('market', market)
    .in('sku', part)));
  for (const { data, error } of results) {
    if (error) throw error;
    for (const r of data ?? []) out[r.sku] = r;
  }
  return out;
}

// The catalog's stock columns only read the quantity, so the full-table read
// fetches just that (not warehouses, ETA, sync stamps…).
async function allRows(market) {
  const { data, error } = await supabase.from('product_inventory').select('sku, available').eq('market', market);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r) => [r.sku, r]));
}

/** { ca: { sku → row }, us: { sku → row } } for the given SKUs. */
export async function getStockFor(skus) {
  const [ca, us] = await Promise.all([rowsFor('ca', skus), rowsFor('us', skus)]);
  return { ca, us };
}

/** Every row of both markets, by SKU — the catalog list joins a few hundred rows at most. */
export async function getAllStock() {
  const [ca, us] = await Promise.all([allRows('ca'), allRows('us')]);
  return { ca, us };
}

/**
 * The last pull's report, written by the edge function into app_settings
 * ('shipstation_inventory'): { syncedAt, markets: { us, ca } } where each
 * market has { ok, label, place, source, matched, inStock, unmatched: [SKUs
 * in the source with no PIM product], syncedAt, … }.
 */
export async function getInventoryReport() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'shipstation_inventory')
    .maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

// invoke hides the function's own message behind a generic non-2xx error;
// the real reason is in the response body. A market that failed is reported
// inside `markets`, not thrown, so the other market's result still shows.
async function invokePull(body) {
  const { data, error } = await supabase.functions.invoke('inventory-pull', { body });
  if (error) {
    let detail = error.message;
    try {
      const text = await error.context?.text?.();
      if (text) {
        try { detail = JSON.parse(text).error ?? text; } catch { detail = text; }
      }
    } catch { /* keep error.message */ }
    throw new Error(detail);
  }
  if (data?.error && !data?.markets) throw new Error(data.error);
  return data;
}

const reportMeta = (data) => Object.fromEntries(Object.entries(data?.markets ?? {}).map(([m, r]) => [m, {
  ok: r.ok, error: r.error, matched: r.matched, inStock: r.inStock, outOfStock: r.outOfStock, dropped: r.dropped, removed: r.removed, unmatched: r.unmatched, blankQty: r.blankQty,
}]));

/** Pull the sources into product_inventory now — both markets by default. */
export async function refreshInventory(market = 'all') {
  const data = await invokePull({ mode: 'pull', market });
  await logActivity({
    action: 'inventory_refresh',
    entityType: 'inventory',
    target: 'inventory',
    summary: `Stock refreshed — ${describeInventoryPull(data).join(' · ')}`,
    metadata: reportMeta(data),
  });
  return data;
}

/**
 * Load the Canada inventory workbook by hand (the fallback while the PIM
 * cannot reach the SharePoint file, or to refresh it right now). `dryRun`
 * parses and matches without writing — a preview.
 */
export async function uploadCanadaInventory(file, { dryRun = false } = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const data = await invokePull({ mode: 'pull', market: 'ca', file: btoa(bin), dryRun });
  if (!dryRun) {
    await logActivity({
      action: 'inventory_upload',
      entityType: 'inventory',
      target: 'inventory',
      summary: `Canada inventory file "${file.name}" loaded — ${describeInventoryPull(data).join(' · ')}`,
      metadata: { file: file.name, ...reportMeta(data) },
    });
  }
  return data;
}

/** One line per market for card messages / the audit summary. */
export function describeInventoryPull(data) {
  return Object.values(data?.markets ?? {}).map((r) => {
    if (!r.ok) return `${r.label}: ${r.error}`;
    const parts = [`${r.label}: ${r.matched} SKUs tracked, ${r.inStock} in stock`];
    if (r.outOfStock) parts.push(`${r.outOfStock} at 0`);
    if (r.dropped?.length) parts.push(`${r.dropped.length} just sold out (${r.dropped.slice(0, 5).join(', ')}${r.dropped.length > 5 ? '…' : ''})`);
    if (r.unmatched?.length) parts.push(`${r.unmatched.length} not in the PIM`);
    if (r.blankQty?.length) parts.push(`${r.blankQty.length} without a quantity`);
    if (r.removed) parts.push(`${r.removed} no longer in the file`);
    return parts.join(', ');
  });
}

/** Tooltip for one product_inventory row (or null = not tracked). */
export function describeStock(stock, market) {
  if (!stock) return NOT_TRACKED[market] ?? 'Not tracked';
  if (stock.dropped_at) {
    return `Sold out — not in ShipStation's list since ${new Date(stock.dropped_at).toLocaleDateString()} · checked ${stockAge(stock.synced_at)}`;
  }
  const where = Object.keys(stock.warehouses ?? {}).join(', ') || (stock.source === 'excel' ? 'Stylish Inventory file' : 'ShipStation');
  const eta = stock.eta ? ` · ETA ${stock.eta}` : '';
  return `${where} · on hand ${stock.on_hand}, available ${stock.available}${eta} · synced ${stockAge(stock.synced_at)}`;
}

/** "just now" · "12 min ago" · "3 h ago" · "2 d ago" — for the sync stamp. */
export function stockAge(iso) {
  if (!iso) return null;
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
