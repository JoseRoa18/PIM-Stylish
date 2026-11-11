// The Dashboard's weekly briefing (user, 2026-11-11: "Cada lunes: los más
// vendidos sin stock, promociones que empiezan, links rotos"). Built straight
// from the data, in blocks — no model writes it (the scorecard's own note
// taught that: a paragraph written by AI read as "one messy paragraph").
//
// Everything here is read with the lookups' own helpers; `ctx` is the
// lookups' context (assistantTools.js). The `assistant` edge function runs it
// on Monday at 7 AM Eastern (cron assistant-briefing) or when an admin asks,
// and keeps the result in app_settings 'assistant_briefing'.
import { promotionsOverview, restAll } from "./assistantTools.js";
import { shiftDay } from "./promoCalendar.ts";
import { wtbRetailer } from "./whereToBuy.js";

// A deal's portals by the names people use.
const PORTAL = {
  wix_sinksdirect_ca: "Sinks Direct Canada", wix_sinksdirect_us: "Sinks Direct USA", wix_stylish_ca: "Stylish Canada", wix_stylish_us: "Stylish USA", wix_azuni_ca: "Azuni",
  amazon_ca: "Amazon Canada", amazon_us: "Amazon USA", wayfair_ca: "Wayfair Canada", wayfair_us: "Wayfair USA", homedepot_ca: "Home Depot Canada", homedepot_us: "Home Depot USA",
  lowes_us: "Lowe's", rona: "Rona", menards: "Menards", bbb: "Bed Bath & Beyond", overstock: "Overstock", bestbuy: "Best Buy", walmart_ca: "Walmart Canada", walmart_us: "Walmart USA",
};
const portalName = (key) => PORTAL[key] ?? String(key).replace(/_/g, " ");

const TOP = 5;
const LOW_DAYS = 21; // "running low": the stock lasts less than this at the 90-day pace
const SITES = "stylish_ca,stylish_us,azuni_ca"; // the pages the PIM publishes (the dealers' price watch is not a page of ours)

export async function buildBriefing(ctx) {
  const today = ctx.today;
  const weekEnd = shiftDay(today, 6);
  const [sales, stock, products, promos, broken, pending] = await Promise.all([
    restAll(ctx, "product_sales?select=market,sku,units_30,units_90"),
    restAll(ctx, "product_inventory?select=market,sku,available,eta,warehouses"),
    restAll(ctx, "products?select=sku,model_name,is_obsolete,workflow_status"),
    promotionsOverview(ctx, { when: "current" }),
    restAll(ctx, `where_to_buy_links?select=retailer,sku&site=in.(${SITES})&verdict=eq.broken`),
    restAll(ctx, "odoo_pending?select=sku,reason"),
  ]);

  const product = new Map(products.map((p) => [p.sku, p]));
  const selling = (sku) => product.has(sku) && !product.get(sku).is_obsolete && product.get(sku).workflow_status !== "archived";
  const sold = new Map(sales.map((s) => [`${s.market}|${s.sku}`, s]));

  // ── stock: what sells and has none, and what will run out soon ──
  const stockOf = {};
  for (const market of ["ca", "us"]) {
    const out = [];
    const low = [];
    for (const row of stock.filter((r) => r.market === market && selling(r.sku))) {
      const units90 = Number(sold.get(`${market}|${row.sku}`)?.units_90 ?? 0);
      if (!(units90 > 0)) continue;
      const order = Object.values(row.warehouses ?? {}).find((w) => w && (w.on_order || w.expected)) ?? {};
      const line = {
        sku: row.sku,
        model: product.get(row.sku).model_name,
        units_90: units90,
        ...(row.eta ? { arrives: row.eta, ...(order.late ? { late: true } : {}), ...(order.on_order ? { on_order: order.on_order } : {}) } : {}),
      };
      if (Number(row.available) <= 0) out.push(line);
      else {
        const days = Math.round(Number(row.available) / (units90 / 90));
        if (days < LOW_DAYS) low.push({ ...line, available: Number(row.available), lasts_days: days });
      }
    }
    out.sort((a, b) => b.units_90 - a.units_90);
    low.sort((a, b) => a.lasts_days - b.lasts_days || b.units_90 - a.units_90);
    stockOf[market] = { out_of_stock: out.length, out_of_stock_top: out.slice(0, TOP), running_low: low.length, running_low_top: low.slice(0, TOP) };
  }

  // ── promotions: what starts and what ends in the next 7 days ──
  const starting = [];
  const ending = [];
  let running = 0;
  for (const p of promos.promotions ?? []) {
    if (p.state_today === "running") running += 1;
    const spans = p.kind === "monthly"
      ? [["Canada", p.canada], ["USA", p.usa]]
      : [[(p.portals ?? []).map(portalName).join(", "), { start: p.starts, end: p.ends }]];
    for (const [where, span] of spans) {
      if (!span) continue;
      const line = { id: p.id, name: p.name, kind: p.kind, where };
      if (span.start >= today && span.start <= weekEnd) starting.push({ ...line, day: span.start });
      if (span.end >= today && span.end <= weekEnd && span.state !== "ended" && p.state_today !== "ended") ending.push({ ...line, day: span.end });
    }
  }
  starting.sort((a, b) => a.day.localeCompare(b.day));
  ending.sort((a, b) => a.day.localeCompare(b.day));

  // ── Where to Buy: broken links, one per product and store (the Canada and
  //    USA pages carry the same link). Walmart USA is not covered yet. ──
  const links = new Set(broken.filter((l) => l.retailer !== "walmart_us").map((l) => `${l.retailer}|${l.sku}`));
  const byStore = {};
  for (const key of links) byStore[key.split("|")[0]] = (byStore[key.split("|")[0]] ?? 0) + 1;

  // ── waiting for Odoo ──
  const byReason = {};
  for (const row of pending) byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;

  return {
    generated_at: new Date().toISOString(),
    day: today,
    through: weekEnd,
    stock: stockOf,
    promotions: { running, starting, ending },
    where_to_buy: {
      broken: links.size,
      products: new Set([...links].map((k) => k.split("|")[1])).size,
      by_store: Object.entries(byStore).sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([retailer, n]) => ({ retailer, store: wtbRetailer(retailer)?.label ?? retailer, broken: n })),
    },
    odoo: { waiting: pending.length, by_reason: byReason },
  };
}
