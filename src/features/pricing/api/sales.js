import { supabase } from '@/lib/supabase';

/**
 * Units sold per product and market over the last 30 and 90 days, CACHED in
 * product_sales by the `odoo-sales-pull` edge function (every 3 hours) from
 * Odoo's confirmed sales orders (user, 2026-11-11). One row per market and
 * SKU that sold: `units_30`, `units_90` and `channels` =
 * { "<marketplace>": { u30, u90 } }. A SKU without a row sold nothing in 90
 * days. It is information about sales, like the stock: it never changes a
 * product's own data.
 */
const COLUMNS = 'sku, units_30, units_90, channels, synced_at';

async function rowsFor(market, skus) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < skus.length; i += 100) chunks.push(skus.slice(i, i + 100));
  const results = await Promise.all(chunks.map((part) => supabase.from('product_sales').select(COLUMNS).eq('market', market).in('sku', part)));
  for (const { data, error } of results) {
    if (error) throw error;
    for (const r of data ?? []) out[r.sku] = r;
  }
  return out;
}

/** { ca: { sku → row }, us: { sku → row } } for the given SKUs. */
export async function getSalesFor(skus) {
  const list = [...new Set(skus ?? [])];
  if (!list.length) return { ca: {}, us: {} };
  const [ca, us] = await Promise.all([rowsFor('ca', list), rowsFor('us', list)]);
  return { ca, us };
}

/**
 * Days the stock lasts at the pace of the last 90 days: units available ÷
 * (units sold in 90 days ÷ 90). null when the product is not tracked or sold
 * nothing in 90 days (no pace to go by).
 */
export function daysOfStock(stock, sales) {
  const sold = Number(sales?.units_90) || 0;
  if (!stock || sold <= 0) return null;
  return Math.round((Math.max(0, Number(stock.available) || 0) / sold) * 90);
}

/** "45 days" · "over a year" · "—" (no sales to go by). */
export function daysOfStockText(days) {
  if (days == null) return '—';
  if (days > 365) return 'over a year';
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** The marketplaces of a row, the best seller of the last 90 days first: [{ name, u30, u90 }]. */
export function salesChannels(sales) {
  return Object.entries(sales?.channels ?? {})
    .map(([name, c]) => ({ name, u30: Number(c?.u30) || 0, u90: Number(c?.u90) || 0 }))
    .sort((a, b) => b.u90 - a.u90 || a.name.localeCompare(b.name));
}
