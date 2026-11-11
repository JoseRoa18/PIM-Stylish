import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

/**
 * Stock per product and market, CACHED in product_inventory by the
 * `inventory-pull` edge function (hourly via pg_cron, after every product
 * insert, or by hand). Both markets come from Odoo's Calculated Inventory,
 * column "Available for Use" (free finished stock + what can be built from
 * components), with one warehouse selected (user, 2026-11-10):
 *   ca — warehouse CBG (Cambridge)
 *   us — warehouse ATL (Flowery Branch GA)
 * `available` is that number, `on_hand` Odoo's Quantity On Hand, and
 * `warehouses[code]` also keeps `free`, `buildable` and `incoming`.
 * A SKU without a row is a product Odoo does not have: not tracked —
 * unknown, not zero.
 */
export const STOCK_MARKETS = { ca: 'Canada', us: 'USA' };
/** The Odoo warehouse each market's stock is read from. */
export const STOCK_WAREHOUSES = { ca: 'CBG', us: 'ATL' };
const NOT_TRACKED = { ca: 'Not tracked — Odoo does not have this product (warehouse CBG)', us: 'Not tracked — Odoo does not have this product (warehouse ATL)' };

const COLUMNS = 'sku, on_hand, available, warehouses, source, eta, dropped_at, synced_at';

// `onChunk` (optional) is called as each chunk's read settles.
async function rowsFor(market, skus, onChunk = null) {
  const out = {};
  // Chunks of 100 SKUs, fetched in parallel (they used to go one by one).
  const chunks = [];
  for (let i = 0; i < skus.length; i += 100) chunks.push(skus.slice(i, i + 100));
  const results = await Promise.all(chunks.map((part) => {
    const read = supabase
      .from('product_inventory')
      .select(COLUMNS)
      .eq('market', market)
      .in('sku', part);
    return onChunk ? read.then((res) => { onChunk(); return res; }) : read;
  }));
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

/**
 * { ca: { sku → row }, us: { sku → row } } for the given SKUs. `task`
 * (optional taskProgress reporter) counts the chunk reads of both markets.
 */
export async function getStockFor(skus, { task = null } = {}) {
  const reads = Math.ceil(skus.length / 100) * 2;
  let done = 0;
  const onChunk = task ? () => { done += 1; task.count(done, reads, 'Reading the stock…'); } : null;
  const [ca, us] = await Promise.all([rowsFor('ca', skus, onChunk), rowsFor('us', skus, onChunk)]);
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
 * market has { ok, label, place, source, warehouse, matched, inStock,
 * outOfStock, notInOdoo: [PIM SKUs Odoo does not have], syncedAt, … }.
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
  ok: r.ok, error: r.error, warehouse: r.warehouse, matched: r.matched, inStock: r.inStock, outOfStock: r.outOfStock, removed: r.removed, notInOdoo: r.notInOdoo,
}]));

/** Pull Odoo's stock into product_inventory now — both markets by default. */
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

/** One line per market for card messages / the audit summary. */
export function describeInventoryPull(data) {
  return Object.values(data?.markets ?? {}).map((r) => {
    if (!r.ok) return `${r.label}: ${r.error}`;
    const parts = [`${r.label}: ${r.matched} SKUs tracked, ${r.inStock} in stock`];
    if (r.outOfStock) parts.push(`${r.outOfStock} at 0`);
    if (r.notInOdoo?.length) parts.push(`${r.notInOdoo.length} not in Odoo`);
    if (r.removed) parts.push(`${r.removed} no longer in Odoo`);
    return parts.join(', ');
  });
}

/**
 * What is on order for a stock row (user, 2026-11-11: "llega el…"): the units
 * of Odoo's open purchase orders not received yet and the next date Odoo
 * expects them — { qty, date, day ("Nov 27"), late } — or null when nothing
 * is on order. `late`: the date is already past in Odoo. It is the date of
 * the purchase, which lands in the vendor's warehouse of that country first.
 */
export function onOrder(stock) {
  const w = Object.values(stock?.warehouses ?? {})[0];
  const date = w?.expected ?? stock?.eta ?? null;
  if (!date) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : String(date);
  return { qty: w?.on_order ?? null, date, day, late: w?.late === true };
}

/** "arrives Nov 27" · "was due Oct 17" · '' (nothing on order). */
export function arrivalText(stock) {
  const o = onOrder(stock);
  if (!o) return '';
  return o.late ? `was due ${o.day}` : `arrives ${o.day}`;
}

/** Tooltip for one product_inventory row (or null = not tracked). */
export function describeStock(stock, market) {
  if (!stock) return NOT_TRACKED[market] ?? 'Not tracked';
  const [code, w] = Object.entries(stock.warehouses ?? {})[0] ?? [];
  const where = `Odoo · ${code ?? STOCK_WAREHOUSES[market] ?? market}`;
  // Odoo's own sum: free finished units + what can be built from components.
  const how = w?.free != null && w?.buildable ? ` (${w.free} free + ${w.buildable} buildable)` : '';
  const o = onOrder(stock);
  const coming = o ? ` · ${o.qty != null ? `${o.qty} on order, ` : ''}${o.late ? `was due ${o.day} (late in Odoo)` : `expected ${o.day}`}` : '';
  return `${where} · available for use ${stock.available}${how}, on hand ${stock.on_hand}${coming} · synced ${stockAge(stock.synced_at)}`;
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
