// scorecard-fill — the EOS ScoreCard numbers the PIM works out on the server
// (user, 2026-11-04: "que la mayoría de números se vengan automáticos",
// starting with Sinks Direct). Sources:
//   - Odoo (read only): sale orders (the Wix sites' orders are imported there,
//     by wix_site_name), their deliveries and returns, product costs per
//     company (Stylish International = CAD, Stylish USA = USD);
//   - Wix (read only): the store's own orders (cancellations, refunds) and
//     its product reviews;
//   - ShipStation's labels, copied into public.shipstation_labels by
//     shipstation-labels-sync: when a delivery really shipped (its label) and
//     what it really cost — matched to Odoo's deliveries by tracking number;
//   - the PIM's tables: stock, the obsolete mark, the Activity Log, prices and
//     promotions.
// It writes scorecard_values with origin 'auto' for the rows whose auto_key
// is one of SERVER_KEYS; the browser works out the others (Price Alignment,
// promotions — src/features/scorecard/lib/autoMetrics.js).
//
// Weeks (user, 2026-11-04): a column — the week of its Sunday, W44 = Nov 1 —
// holds the numbers of the week BEFORE it (Oct 25–31), the week reviewed in
// that week's meeting. Days are Eastern time (Cambridge, Ontario).
//
// Body: { mode: "fill" | "preview", boards?: string[], backfill?: number, refresh?: number, running?: true | "only" }
//   running  — also the column of the week now running (its numbers so far,
//              user 2026-11-06: updated every 3 hours by the cron), replaced
//              every time; "only" = that column alone. Read-today rows (stock,
//              reviews, profitability) and the AI note stay on this week's column.
//   fill     — this week's column, replaced (the rows are the PIM's); with
//              backfill N the N columns before it, written where they are
//              still empty — or, within the `refresh` newest of them, where
//              the PIM wrote them (origin 'auto'), so a refund, a return or an
//              order Odoo got late still lands. A value someone typed or
//              imported is never replaced.
//   preview  — the same numbers, nothing written, plus `diagnostics`.
// Caller: cron (x-cron-secret, daily), the service-role key, or an admin /
// editor (the page's "Refresh PIM numbers").
// Secrets: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY, WIX_API_KEY, CRON_SECRET.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isServiceRole } from "../_shared/serviceRole.ts";
import { WIX_SITES } from "../_shared/wixSites.ts";
import { priceOff } from "../_shared/priceTolerance.js";
import { promoWindow, windowContains, prevPeriod, periodOfDay, PROMO_DATE_COLUMNS } from "../_shared/promoCalendar.ts";
import { alignTargets, createPriceAlignment } from "../_shared/priceAlignmentReport.js";
import { createScorecardLive, LIVE_KEYS } from "../_shared/scorecardLive.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type Market = "ca" | "us";
/** Which SKUs a channel lists, for "# SKU not sold": the PIM's ids for it. */
type Listed = { alias: string } | { amazon: Market } | { wayfair: Market } | { wtb: string } | "catalog";
interface MarketSource {
  odoo: unknown[];      // Odoo domain on sale.order selecting the channel's orders
  company: number;      // Odoo company whose costs and currency apply (2 = Stylish International, CAD; 1 = Stylish USA, USD)
  wholesale?: { blue: string; orange: string; purple: string }; // the price levels the marketplace pays us (products columns)
  stock?: Market;       // product_inventory market of the stock it sells from (none: Amazon FBA's stock is Amazon's)
  listed?: Listed;      // the SKUs it lists (none: no list in the PIM — Amazon.com)
  wix?: string;         // Sinks Direct: WIX_SITES key of the store (its orders, reviews, price)
  wixSites?: string[];  // Sinks Direct: Activity Log site keys of the store's pushes
  ships?: number[];     // the Odoo marketplaces of it WE ship (Amazon: FBM, not FBA); none = all
  promo: string[];      // its promotion channel keys (promotions.marketplaces) — for the AI note
  pages: string[];      // its store-page retailer keys (where_to_buy_readings) — for the AI note
  align?: string[];     // its Price Alignment targets, when they are not `pages`
}
const BOARD_LABEL: Record<string, string> = { sinksdirect: "Sinks Direct", amazon: "Amazon", wayfair: "Wayfair", homedepot_ca: "Home Depot", lowes: "Lowe's", menards: "Menards", rona: "Rona", bbb_overstock: "BB&B / Overstock", bestbuy: "Best Buy", walmart: "Walmart" };
// Odoo's marketplaces (marketplace.master) and companies.
const MP = { walmart: 3, wayfair: 4, homedepot: 5, rona: 6, lowes: 7, bbb: 8, amazonFbm: 10, bestbuy: 11, menards: 12, amazonFba: 13, overstock: 17 };
const CA = 2;
const US = 1;
const sold = (ids: number[], company: number) => [["marketplace_name", "in", ids], ["company_id", "=", company]];
// Boards the server fills, per market (user, 2026-11-05: every marketplace
// tab, from Odoo's orders — every marketplace's orders are imported there —
// ShipStation's labels and the PIM). Keep in step with `serverFill` in
// src/features/scorecard/lib/boards.js.
const BOARDS: Record<string, Partial<Record<Market, MarketSource>>> = {
  sinksdirect: {
    ca: { odoo: [["wix_site_name", "=", "sinksdirect.ca"]], company: CA, wix: "sinksdirect_ca", wixSites: ["sinksdirect_ca"], stock: "ca", listed: "catalog", promo: ["wix_sinksdirect_ca"], pages: ["sinksdirect_ca"] },
    us: { odoo: [["wix_site_name", "=", "sinksdirectusa.com"]], company: US, wix: "sinksdirect_us", wixSites: ["sinksdirect_us"], stock: "us", listed: "catalog", promo: ["wix_sinksdirect_us"], pages: ["sinksdirect_us"] },
  },
  amazon: {
    ca: { odoo: sold([MP.amazonFbm, MP.amazonFba], CA), company: CA, listed: { amazon: "ca" }, ships: [MP.amazonFbm], promo: ["amazon_ca"], pages: ["amazon_ca"] },
    us: { odoo: sold([MP.amazonFbm, MP.amazonFba], US), company: US, ships: [MP.amazonFbm], promo: ["amazon_us"], pages: ["amazon_us"] },
  },
  wayfair: {
    ca: { odoo: sold([MP.wayfair], CA), company: CA, stock: "ca", listed: { wayfair: "ca" }, promo: ["wayfair_ca"], pages: ["wayfair_ca"] },
    us: { odoo: sold([MP.wayfair], US), company: US, stock: "us", listed: { wayfair: "us" }, promo: ["wayfair_us"], pages: ["wayfair_us"] },
  },
  // The key stays homedepot_ca: the tab holds both countries since 2026-11-09.
  homedepot_ca: {
    ca: { odoo: sold([MP.homedepot], CA), company: CA, stock: "ca", listed: { alias: "Home Depot CA" }, promo: ["homedepot_ca"], pages: ["homedepot_ca"] },
    us: { odoo: sold([MP.homedepot], US), company: US, stock: "us", listed: { alias: "Home Depot US" }, promo: ["homedepot_us"], pages: ["homedepot_us"] },
  },
  lowes: { us: { odoo: sold([MP.lowes], US), company: US, stock: "us", listed: { alias: "Lowe's US" }, promo: ["lowes_us"], pages: ["lowes_us"] } },
  // Menards has no aliases in the PIM: what it lists = the products with a Menards link.
  menards: { us: { odoo: sold([MP.menards], US), company: US, stock: "us", listed: { wtb: "menards" }, promo: ["menards"], pages: ["menards"] } },
  // The same: what each lists = the products with its Where to Buy link.
  bestbuy: { ca: { odoo: sold([MP.bestbuy], CA), company: CA, stock: "ca", listed: { wtb: "bestbuy_ca" }, promo: ["bestbuy"], pages: ["bestbuy_ca"], align: ["bestbuy"] } },
  walmart: {
    ca: { odoo: sold([MP.walmart], CA), company: CA, stock: "ca", listed: { wtb: "walmart_ca" }, promo: ["walmart_ca"], pages: ["walmart_ca"] },
    us: { odoo: sold([MP.walmart], US), company: US, stock: "us", listed: { wtb: "walmart_us" }, promo: ["walmart_us"], pages: ["walmart_us"] },
  },
  rona: { ca: { odoo: sold([MP.rona], CA), company: CA, stock: "ca", listed: { alias: "Rona" }, promo: ["rona"], pages: ["rona"] } },
  bbb_overstock: { us: { odoo: sold([MP.bbb, MP.overstock], US), company: US, stock: "us", listed: { alias: "BB&B / Overstock" }, promo: ["bbb", "overstock"], pages: ["bbb_us", "overstock_us"], wholesale: { blue: "cost_usd_lowes_sod_bbb", orange: "cost_usd_lowes_sod_bbb_orange", purple: "cost_usd_lowes_sod_bbb_purple" } } },
};
/** The same domain read from another model: sale.order fields under `prefix` (order_id., sale_id.). */
const via = (domain: unknown[], prefix: string) => domain.map((leaf) => (Array.isArray(leaf) ? [`${prefix}${leaf[0]}`, leaf[1], leaf[2]] : leaf));
const SERVER_KEYS = [
  // 2026-11-09: MAP %, promotions, deals and coupons (they only changed when the tab was opened).
  ...LIVE_KEYS,
  "sales", "orders", "units", "skus_not_sold_90d", "oos_loss", "obsolete_skus", "listings_updated",
  // 2026-11-05: Odoo records almost no cancellation, the store's own orders do.
  "cancel_rate", "on_time_ship", "late_ship_rate", "odr", "returns_not_received", "reviews_5plus", "no_profit_skus",
  // 2026-11-05, the marketplace tabs: returns over 4 weeks, sales in thousands of USD, Azuni SKUs sold.
  "return_rate", "returns_value", "sales_usd_k", "azuni_skus_sold",
  // 2026-11-09: the sales of a tab's own list of SKUs (app_settings.scorecard_top_losers, by board).
  "top_losers_sales",
  // 2026-11-09, BB&B / Overstock: what comes back in the week, and the reviews that are new on the store pages.
  "returns_note", "reviews_new",
  // The "Actions taken for top losers" note, written by AI from the week's data (user, 2026-11-05).
  "losers_note",
];
// Read from today's state (stock, marks, reviews, prices): only this week's column gets them.
const SNAPSHOT_KEYS = new Set(["oos_loss", "obsolete_skus", "reviews_5plus", "no_profit_skus", "losers_note", "reviews_new"]);
const WIX_KEYS = ["cancel_rate", "odr", "returns_not_received"];
const SHIP_KEYS = ["on_time_ship", "late_ship_rate"];
// On time = fully shipped by the end of the 2nd business day after the order
// (user, 2026-11-05; Monday–Friday, Eastern).
const SHIP_BUSINESS_DAYS = 2;
const SETTINGS_KEY = "scorecard_fill";
const FIRST_COLUMN = "2026-11-01"; // W44: the scorecard starts there

// ---- dates (Eastern) --------------------------------------------------------
const DAY = 86400000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const etDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" });
const etToday = () => etDayFmt.format(new Date());
const etDayOf = (iso: string) => etDayFmt.format(new Date(iso));
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 Sunday
const sundayOf = (d: string) => addDays(d, -weekday(d));
/**
 * Toronto midnight of `day` as Odoo's UTC 'YYYY-MM-DD HH:MM:SS'. Kept per day:
 * the week filters ask it for every order line, and building the Intl
 * formatter each time ran a 14-week backfill out of CPU (WORKER_RESOURCE_LIMIT).
 */
const midnights = new Map<string, string>();
function etMidnightUtc(day: string): string {
  let hit = midnights.get(day);
  if (!hit) midnights.set(day, hit = computeEtMidnightUtc(day));
  return hit;
}
function computeEtMidnightUtc(day: string): string {
  // 05:00Z is about midnight there; DST never switches before 2 AM.
  const probe = new Date(`${day}T05:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(probe);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const offset = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - probe.getTime();
  return new Date(Date.parse(`${day}T00:00:00Z`) - offset).toISOString().replace("T", " ").slice(0, 19);
}
const isoOf = (odoo: string) => odoo.replace(" ", "T") + "Z";
/** Milliseconds of Toronto midnight of `day` (compare times as numbers: Wix writes milliseconds, Odoo does not). */
const etMs = (day: string) => Date.parse(isoOf(etMidnightUtc(day)));
const inWeek = (iso: string | null | undefined, fromDay: string, toDay: string) => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= etMs(fromDay) && t < etMs(toDay);
};
/** End (exclusive, ms) of the Nth business day after the order's Eastern day. */
function shipDeadline(orderIso: string): number {
  let d = etDayOf(orderIso);
  for (let n = 0; n < SHIP_BUSINESS_DAYS;) {
    d = addDays(d, 1);
    const w = weekday(d);
    if (w !== 0 && w !== 6) n += 1;
  }
  return etMs(addDays(d, 1));
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 10000) / 10000 : null);

// ---- Odoo (JSON-RPC, read only) ----------------------------------------------
type Odoo = (model: string, method: string, args: unknown[], kwargs?: Record<string, unknown>) => Promise<any>;
async function odooClient(): Promise<Odoo> {
  const url = Deno.env.get("ODOO_URL")!.replace(/\/$/, "");
  const db = Deno.env.get("ODOO_DB")!;
  const user = Deno.env.get("ODOO_USER")!;
  const key = Deno.env.get("ODOO_API_KEY")!;
  let id = 0;
  const rpc = async (service: string, method: string, args: unknown[]) => {
    const r = await fetch(`${url}/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: ++id }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`Odoo: ${j.error.data?.message ?? j.error.message}`);
    return j.result;
  };
  const uid = await rpc("common", "authenticate", [db, user, key, {}]);
  if (!uid) throw new Error("Odoo refused the PIM's login (ODOO_USER / ODOO_API_KEY).");
  return (model, method, args, kwargs = {}) => rpc("object", "execute_kw", [db, uid, key, model, method, args, kwargs]);
}

// `untaxed`: in the company's currency (an order's own currency can differ —
// Wayfair Canada pays in USD); `usd`: the same in USD.
interface Order { id: number; date: string; state: string; untaxed: number; usd: number; pickings: number[]; mp: number | null }
// `goods`: a product line, not a service (Odoo's "Shipping Charges").
interface Line { orderId: number; sku: string | null; qty: number; subtotal: number; goods: boolean }
/** A product sold with a price: not shipping, not a part or a unit sent free. */
const isSale = (l: Line) => l.goods && l.qty > 0 && l.subtotal > 0;

async function loadOrders(odoo: Odoo, domain: unknown[], fromDay: string, toDay: string, skuOf: (code: string | null) => string | null, usdPerCompanyUnit: number) {
  const when = [["date_order", ">=", etMidnightUtc(fromDay)], ["date_order", "<", etMidnightUtc(toDay)], ["state", "in", ["sale", "done", "cancel"]]];
  const rows = await odoo("sale.order", "search_read", [[...domain, ...when]], { fields: ["id", "date_order", "state", "amount_untaxed", "currency_rate", "currency_id", "picking_ids", "marketplace_name"] }) as { id: number; date_order: string; state: string; amount_untaxed: number; currency_rate: number; currency_id: [number, string]; picking_ids: number[]; marketplace_name: [number, string] | false }[];
  // Odoo's currency_rate = the order's currency per unit of the company's.
  const rate = new Map(rows.map((o) => [o.id, Number(o.currency_rate) || 1]));
  const orders: Order[] = rows.map((o) => {
    const amount = Number(o.amount_untaxed) || 0;
    const untaxed = amount / (rate.get(o.id) ?? 1);
    return { id: o.id, date: isoOf(o.date_order), state: o.state, untaxed, usd: o.currency_id?.[1] === "USD" ? amount : untaxed * usdPerCompanyUnit, pickings: o.picking_ids ?? [], mp: o.marketplace_name ? o.marketplace_name[0] : null };
  });
  const lines: Line[] = [];
  const productIds = new Set<number>();
  // The lines of the same orders in one read (not cancelled).
  const raw = (await odoo("sale.order.line", "search_read", [[...via([...domain, ...when], "order_id."), ["order_id.state", "!=", "cancel"], ["display_type", "=", false], ["is_delivery", "=", false]]], { fields: ["order_id", "product_id", "product_uom_qty", "price_subtotal"] }) as { order_id: [number, string]; product_id: [number, string] | false; product_uom_qty: number; price_subtotal: number }[])
    .map((l) => ({ ...l, price_subtotal: (Number(l.price_subtotal) || 0) / (rate.get(l.order_id[0]) ?? 1) }));
  for (const l of raw) if (l.product_id) productIds.add(l.product_id[0]);
  const codes = new Map<number, string | null>();
  const services = new Set<number>();
  const ids = [...productIds];
  for (let i = 0; i < ids.length; i += 400) {
    const prods = await odoo("product.product", "read", [ids.slice(i, i + 400)], { fields: ["default_code", "type"] }) as { id: number; default_code: string | false; type: string }[];
    for (const p of prods) {
      codes.set(p.id, p.default_code || null);
      if (p.type === "service") services.add(p.id);
    }
  }
  for (const l of raw) {
    const pid = l.product_id ? l.product_id[0] : null;
    lines.push({ orderId: l.order_id[0], sku: pid ? skuOf(codes.get(pid) ?? null) : null, qty: Number(l.product_uom_qty) || 0, subtotal: Number(l.price_subtotal) || 0, goods: pid != null && !services.has(pid) });
  }
  return { orders, lines };
}

/** Outgoing deliveries of the orders: when each order was FULLY shipped (null = something still to ship). */
// ---- ShipStation labels (copied into the PIM by shipstation-labels-sync) ------
type Admin = ReturnType<typeof createClient>;
interface LabelRow { tracking_number: string; created_at: string; cost: number | null; currency: string | null }
const trackingRefs = (ref: string | false | null | undefined) => String(ref || "").split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean);
/** The labels of these tracking numbers (not voided, not return labels): the earliest per number. */
async function labelsFor(admin: Admin, trackings: string[]): Promise<Map<string, LabelRow>> {
  const out = new Map<string, LabelRow>();
  const unique = [...new Set(trackings)];
  for (let i = 0; i < unique.length; i += 200) {
    const { data, error } = await admin.from("shipstation_labels").select("tracking_number, created_at, cost, currency")
      .in("tracking_number", unique.slice(i, i + 200)).eq("voided", false).eq("is_return", false);
    if (error) throw error;
    for (const l of (data ?? []) as LabelRow[]) {
      const prev = out.get(l.tracking_number);
      if (!prev || l.created_at < prev.created_at) out.set(l.tracking_number, l);
    }
  }
  return out;
}

/**
 * When each order was FULLY shipped, from its deliveries' ShipStation labels
 * (user, 2026-11-05: the real data — Odoo dated a batch of June–August
 * deliveries Oct 16, the day someone validated them). A delivery is shipped
 * when its label was made; done in Odoo without a label we know (a pickup, a
 * label made outside ShipStation) = unknown, and the order is left out
 * rather than guessed; not done and no label = not shipped yet.
 */
async function shippedAt(odoo: Odoo, admin: Admin, orders: Order[], diag: Record<string, any>): Promise<Map<number, { done: string | null; any: boolean; unknown: boolean }>> {
  const ids = orders.flatMap((o) => o.pickings);
  const picks: { id: number; picking_type_code: string; state: string; return_id: [number, string] | false; carrier_tracking_ref: string | false }[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    picks.push(...await odoo("stock.picking", "read", [ids.slice(i, i + 400)], { fields: ["picking_type_code", "state", "return_id", "carrier_tracking_ref"] }));
  }
  const byId = new Map(picks.map((p) => [p.id, p]));
  const labels = await labelsFor(admin, picks.flatMap((p) => trackingRefs(p.carrier_tracking_ref)));
  const out = new Map<number, { done: string | null; any: boolean; unknown: boolean }>();
  for (const o of orders) {
    const outgoing = o.pickings.map((id) => byId.get(id)).filter((p) => p && p.picking_type_code === "outgoing" && !p.return_id && p.state !== "cancel");
    if (!outgoing.length) { out.set(o.id, { done: null, any: false, unknown: false }); continue; }
    let unknown = false;
    let pending = false;
    let last = "";
    for (const p of outgoing) {
      const times = trackingRefs(p!.carrier_tracking_ref).map((t) => labels.get(t)?.created_at).filter(Boolean) as string[];
      if (times.length) { const t = times.sort()[0]; if (t > last) last = t; } else if (p!.state === "done") unknown = true; else pending = true;
    }
    if (unknown) diag.shipNoLabel = (diag.shipNoLabel ?? 0) + 1;
    out.set(o.id, { done: !unknown && !pending ? last : null, any: true, unknown });
  }
  return out;
}

/**
 * What shipping really costs the company per unit of each SKU on the store
 * (user, 2026-11-05: "lo más real y pura posible"): for every order of the
 * last `days` whose deliveries all have a ShipStation label with a cost in the
 * market's currency: each delivery's label cost shared among the products it
 * carried by their value (an accessory sent in a box of its own carries that
 * box alone; a kit is its own line), MINUS the shipping the customer paid
 * (Odoo's "Shipping Charges" service line — charged per order, so shared among
 * the order's products by value). An order with a delivery we cannot price
 * (no label we know, a $0 label, another currency) is left out — never
 * guessed. Per SKU: the shares summed ÷ the units sold (it can be negative
 * when customers paid more than the labels).
 */
async function shipCostPerUnit(odoo: Odoo, admin: Admin, pickDomain: unknown[], sinceDay: string, currency: string, skuOf: (code: string | null) => string | null, diag: Record<string, any>): Promise<Map<string, number>> {
  // Odoo's done date can be late (a batch validated weeks after), so a month more; the label date decides.
  const picks = await odoo("stock.picking", "search_read", [[...pickDomain, ["picking_type_code", "=", "outgoing"], ["return_id", "=", false], ["state", "=", "done"], ["date_done", ">=", etMidnightUtc(addDays(sinceDay, -30))]]], { fields: ["carrier_tracking_ref", "sale_id", "move_ids"] }) as { carrier_tracking_ref: string | false; sale_id: [number, string] | false; move_ids: number[] }[];
  const labels = await labelsFor(admin, picks.flatMap((p) => trackingRefs(p.carrier_tracking_ref)));
  const sinceMs = etMs(sinceDay);
  // Per order: its deliveries with their label cost, or null when one cannot be priced.
  const deliveries = new Map<number, { cost: number; moves: number[] }[] | null>();
  const recent = new Set<number>();
  for (const p of picks) {
    if (!p.sale_id) continue;
    const orderId = p.sale_id[0];
    const ls = trackingRefs(p.carrier_tracking_ref).map((t) => labels.get(t));
    const ok = ls.length > 0 && ls.every((l) => l && Number(l.cost) > 0 && (l.currency ?? "").toUpperCase() === currency);
    if (!ok) { deliveries.set(orderId, null); continue; }
    if (ls.some((l) => Date.parse(l!.created_at) >= sinceMs)) recent.add(orderId);
    const prev = deliveries.get(orderId);
    if (prev === null) continue;
    deliveries.set(orderId, [...(prev ?? []), { cost: ls.reduce((s, l) => s + Number(l!.cost), 0), moves: p.move_ids ?? [] }]);
  }
  const orderIds = [...recent].filter((id) => deliveries.get(id) != null);
  diag.ordersPriced = orderIds.length;
  diag.ordersWithoutKnownShipCost = [...deliveries.values()].filter((v) => v === null).length;
  const moveIds = orderIds.flatMap((id) => deliveries.get(id)!.flatMap((d) => d.moves));
  const lineOfMove = new Map<number, number>();
  for (let i = 0; i < moveIds.length; i += 400) {
    for (const m of await odoo("stock.move", "read", [moveIds.slice(i, i + 400)], { fields: ["sale_line_id"] }) as { id: number; sale_line_id: [number, string] | false }[]) {
      if (m.sale_line_id) lineOfMove.set(m.id, m.sale_line_id[0]);
    }
  }
  const lines: { id: number; order_id: [number, string]; product_id: [number, string] | false; product_uom_qty: number; price_subtotal: number; is_delivery: boolean }[] = [];
  for (let i = 0; i < orderIds.length; i += 400) {
    lines.push(...await odoo("sale.order.line", "search_read", [[["order_id", "in", orderIds.slice(i, i + 400)], ["display_type", "=", false]]], { fields: ["id", "order_id", "product_id", "product_uom_qty", "price_subtotal", "is_delivery"] }));
  }
  const prodIds = [...new Set(lines.filter((l) => l.product_id).map((l) => (l.product_id as [number, string])[0]))];
  const code = new Map<number, string | null>();
  const service = new Set<number>();
  for (let i = 0; i < prodIds.length; i += 400) {
    for (const pr of await odoo("product.product", "read", [prodIds.slice(i, i + 400)], { fields: ["default_code", "type"] }) as { id: number; default_code: string | false; type: string }[]) {
      code.set(pr.id, pr.default_code || null);
      if (pr.type === "service") service.add(pr.id);
    }
  }
  const byOrder = new Map<number, typeof lines>();
  for (const l of lines) { const k = l.order_id[0]; if (!byOrder.has(k)) byOrder.set(k, []); byOrder.get(k)!.push(l); }
  const ship = new Map<string, { cost: number; units: number }>();
  let charged = 0;
  let labelled = 0;
  for (const orderId of orderIds) {
    const ls = byOrder.get(orderId) ?? [];
    const isShipping = (l: typeof lines[number]) => l.is_delivery || (l.product_id && service.has(l.product_id[0]));
    const paidShipping = ls.filter(isShipping).reduce((s, l) => s + (Number(l.price_subtotal) || 0), 0);
    const goods = ls.filter((l) => !isShipping(l) && l.product_id && l.product_uom_qty > 0 && l.price_subtotal > 0);
    const total = goods.reduce((s, l) => s + l.price_subtotal, 0);
    if (!goods.length || total <= 0) continue;
    // Each line's share: of every box it travelled in, and of the shipping charged.
    const share = new Map<number, number>(goods.map((l) => [l.id, -paidShipping * (l.price_subtotal / total)]));
    for (const d of deliveries.get(orderId)!) {
      const inBox = goods.filter((l) => d.moves.some((m) => lineOfMove.get(m) === l.id));
      const carriers = inBox.length ? inBox : goods; // a box whose moves name no sale line: the order's products
      const boxValue = carriers.reduce((s, l) => s + l.price_subtotal, 0);
      for (const l of carriers) share.set(l.id, share.get(l.id)! + d.cost * (l.price_subtotal / boxValue));
      labelled += d.cost;
    }
    charged += paidShipping;
    for (const l of goods) {
      const sku = skuOf(code.get((l.product_id as [number, string])[0]) ?? null);
      if (!sku) continue;
      const cur = ship.get(sku) ?? { cost: 0, units: 0 };
      cur.cost += share.get(l.id)!;
      cur.units += l.product_uom_qty;
      ship.set(sku, cur);
    }
  }
  diag.labelCostOfPricedOrders = round2(labelled);
  diag.shippingChargedOnThem = round2(charged);
  diag.skusWithShipCost = ship.size;
  return new Map([...ship].map(([sku, v]) => [sku, v.cost / v.units]));
}

/**
 * The returns Odoo RECEIVED for the channel's orders since `sinceDay`: when,
 * which order, and the value of the goods back (the returned quantity at the
 * order line's price, in the company's currency). Bodega validates returns in
 * batches, so a week alone jumps (0 %, 58 %…): callers read them over 4 weeks
 * (user, 2026-11-05).
 */
async function receivedReturns(odoo: Odoo, pickDomain: unknown[], sinceDay: string): Promise<{ at: string; orderId: number; value: number; items: { code: string | null; qty: number; value: number }[] }[]> {
  const rets = await odoo("stock.picking", "search_read", [[...pickDomain, ["return_id", "!=", false], ["picking_type_code", "=", "incoming"], ["state", "=", "done"], ["date_done", ">=", etMidnightUtc(sinceDay)]]], { fields: ["sale_id", "date_done", "move_ids"] }) as { sale_id: [number, string] | false; date_done: string; move_ids: number[] }[];
  const moveIds = rets.flatMap((r) => r.move_ids ?? []);
  const moves: { id: number; product_id: [number, string] | false; quantity: number; product_uom_qty: number; sale_line_id: [number, string] | false; origin_returned_move_id: [number, string] | false }[] = [];
  for (let i = 0; i < moveIds.length; i += 400) moves.push(...await odoo("stock.move", "read", [moveIds.slice(i, i + 400)], { fields: ["product_id", "quantity", "product_uom_qty", "sale_line_id", "origin_returned_move_id"] }));
  // A return move names its sale line, or the delivery move it returns does.
  const originIds = moves.filter((m) => !m.sale_line_id && m.origin_returned_move_id).map((m) => (m.origin_returned_move_id as [number, string])[0]);
  const originLine = new Map<number, number>();
  for (let i = 0; i < originIds.length; i += 400) {
    for (const o of await odoo("stock.move", "read", [originIds.slice(i, i + 400)], { fields: ["sale_line_id"] }) as { id: number; sale_line_id: [number, string] | false }[]) if (o.sale_line_id) originLine.set(o.id, o.sale_line_id[0]);
  }
  const lineOf = (m: typeof moves[number]) => (m.sale_line_id ? m.sale_line_id[0] : m.origin_returned_move_id ? originLine.get(m.origin_returned_move_id[0]) ?? null : null);
  const lineIds = [...new Set(moves.map(lineOf).filter((x) => x != null))] as number[];
  const lines = new Map<number, { unit: number; orderId: number }>();
  const orderIds = new Set<number>();
  const rawLines: { id: number; order_id: [number, string]; price_subtotal: number; product_uom_qty: number }[] = [];
  for (let i = 0; i < lineIds.length; i += 400) rawLines.push(...await odoo("sale.order.line", "read", [lineIds.slice(i, i + 400)], { fields: ["order_id", "price_subtotal", "product_uom_qty"] }));
  for (const l of rawLines) orderIds.add(l.order_id[0]);
  const rate = new Map<number, number>();
  const ids = [...orderIds];
  for (let i = 0; i < ids.length; i += 400) {
    for (const o of await odoo("sale.order", "read", [ids.slice(i, i + 400)], { fields: ["currency_rate"] }) as { id: number; currency_rate: number }[]) rate.set(o.id, Number(o.currency_rate) || 1);
  }
  for (const l of rawLines) lines.set(l.id, { unit: l.product_uom_qty > 0 ? (Number(l.price_subtotal) || 0) / l.product_uom_qty / (rate.get(l.order_id[0]) ?? 1) : 0, orderId: l.order_id[0] });
  const moveById = new Map(moves.map((m) => [m.id, m]));
  const codeOf = new Map<number, string | null>();
  const productIds = [...new Set(moves.map((m) => (m.product_id ? m.product_id[0] : 0)).filter(Boolean))];
  for (let i = 0; i < productIds.length; i += 400) {
    for (const p of await odoo("product.product", "read", [productIds.slice(i, i + 400)], { fields: ["default_code"] }) as { id: number; default_code: string | false }[]) codeOf.set(p.id, p.default_code || null);
  }
  const moveLine = (m: typeof moves[number]) => { const line = lines.get(lineOf(m) as number); const qty = Number(m.quantity) || Number(m.product_uom_qty) || 0; return { code: m.product_id ? codeOf.get(m.product_id[0]) ?? null : null, qty, value: line ? qty * line.unit : 0 }; };
  return rets.filter((r) => r.sale_id).map((r) => ({
    at: isoOf(r.date_done),
    orderId: (r.sale_id as [number, string])[0],
    items: (r.move_ids ?? []).map((id) => moveById.get(id)).filter(Boolean).map((m) => moveLine(m as typeof moves[number])),
    value: (r.move_ids ?? []).reduce((s, id) => {
      const m = moveById.get(id);
      const line = m ? lines.get(lineOf(m) as number) : null;
      return s + (m && line ? (Number(m.quantity) || Number(m.product_uom_qty) || 0) * line.unit : 0);
    }, 0),
  }));
}

/** The SKUs a channel lists, per the PIM's ids for it (null = every live product). */
async function listedSkus(admin: Admin, listed: Listed): Promise<Set<string> | null> {
  if (listed === "catalog") return null;
  const out = new Set<string>();
  const page = async (table: string, select: string, filter: (q: any) => any, pick: (r: any) => string | null) => {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await filter(admin.from(table).select(select)).range(from, from + 999);
      if (error) throw error;
      for (const r of data ?? []) { const s = pick(r); if (s) out.add(s); }
      if ((data ?? []).length < 1000) break;
    }
  };
  if ("alias" in listed) await page("product_aliases", "sku", (q) => q.eq("marketplace", listed.alias), (r) => r.sku);
  else if ("amazon" in listed) await page("amazon_links", "sku", (q) => q.eq("marketplace", listed.amazon), (r) => r.sku);
  else if ("wtb" in listed) await page("product_where_to_buy", "sku", (q) => q.eq("retailer", listed.wtb), (r) => r.sku);
  else await page("products", "sku, wayfair_item_group_id, wayfair_usa_item_group_id", (q) => q, (r) => ((listed.wayfair === "ca" ? r.wayfair_item_group_id : r.wayfair_usa_item_group_id) ? r.sku : null));
  return out;
}

/** Wix order ids of the store's orders with a RECEIVED return (an incoming return picking done in Odoo). */
async function returnedWixOrders(odoo: Odoo, pickDomain: unknown[], sinceDay: string) {
  const rets = await odoo("stock.picking", "search_read", [[...pickDomain, ["return_id", "!=", false], ["picking_type_code", "=", "incoming"], ["state", "=", "done"], ["date_done", ">=", etMidnightUtc(sinceDay)]]], { fields: ["sale_id", "date_done"] }) as { sale_id: [number, string] | false; date_done: string }[];
  const saleIds = [...new Set(rets.filter((r) => r.sale_id).map((r) => (r.sale_id as [number, string])[0]))];
  const wixIds = new Map<number, string>();
  for (let i = 0; i < saleIds.length; i += 400) {
    const so = await odoo("sale.order", "read", [saleIds.slice(i, i + 400)], { fields: ["wix_order_id"] }) as { id: number; wix_order_id: string | false }[];
    for (const s of so) if (s.wix_order_id) wixIds.set(s.id, s.wix_order_id);
  }
  return { wixOrderIds: new Set(wixIds.values()), returns: rets.length, unmatched: saleIds.filter((id) => !wixIds.has(id)).length };
}

/** The Wix orders (ids) of which Odoo shipped something: a refund on an order never shipped returns nothing. */
async function shippedWixOrders(odoo: Odoo, wixIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!wixIds.length) return out;
  const orders = await odoo("sale.order", "search_read", [[["wix_order_id", "in", wixIds]]], { fields: ["wix_order_id", "picking_ids"] }) as { wix_order_id: string; picking_ids: number[] }[];
  const pickIds = orders.flatMap((o) => o.picking_ids ?? []);
  const picks = pickIds.length ? await odoo("stock.picking", "read", [pickIds], { fields: ["picking_type_code", "state", "return_id"] }) as { id: number; picking_type_code: string; state: string; return_id: unknown }[] : [];
  const shippedPick = new Set(picks.filter((p) => p.picking_type_code === "outgoing" && !p.return_id && p.state === "done").map((p) => p.id));
  for (const o of orders) if ((o.picking_ids ?? []).some((id) => shippedPick.has(id))) out.add(o.wix_order_id);
  return out;
}

// ---- "Actions taken for top losers", written by AI (user, 2026-11-05) ----------
interface LoserFact { sku: string; model: string | null; units: number; sales: number; avgUnits: number; avgSales: number; brief: string[]; todo: string[]; stock: string; promo: string | null }
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shorten = (t: string, max = 150) => (t.length <= max ? t : `${t.slice(0, t.lastIndexOf(" ", max))}…`);

/**
 * The week's note (user, 2026-11-09: it read as one messy paragraph): a block
 * per top loser, one fact per line, then what the PIM recorded. Built straight
 * from the data; the note's dialog shows each block as a card and Copy gives
 * this same text. The only causes are our stock at 0, a store page sold out or
 * a broken link: a price or a promotion is never a cause.
 */
function writeLosersNote(losers: LoserFact[], actions: string[]): string {
  if (!losers.length) return "No SKU sold under its 8-week average this week.";
  const blocks = losers.map((l) => [
    `${l.sku} — down ${money(l.avgSales - l.sales)}`,
    `Sold: ${l.units} ${l.units === 1 ? "unit" : "units"} (usually ${l.avgUnits.toFixed(1)} a week)`,
    `Stock: ${l.stock}`,
    ...(l.promo ? [`Promotion: ${l.promo}`] : []),
    `Cause: ${l.brief.length ? cap(l.brief.join("; ")) : "None visible in the PIM"}`,
    "To do:",
    ...l.todo.map((t) => `• ${cap(t)}`),
  ].join("\n"));
  blocks.push(actions.length ? ["Recorded in the PIM", ...actions.slice(0, 6).map((a) => `• ${a}`)].join("\n") : "No action recorded in the PIM this week.");
  return blocks.join("\n\n");
}

/** USD per unit of the company's currency (Stylish USA: 1), Odoo's rate of today; null when unknown. */
async function usdPerUnit(odoo: Odoo, company: number): Promise<number | null> {
  if (company === US) return 1;
  const [usd] = await odoo("res.currency", "search_read", [[["name", "=", "USD"]]], { fields: ["rate"], context: { allowed_company_ids: [company] } }) as { rate: number }[];
  const r = Number(usd?.rate);
  return r > 0 ? r : null;
}

/** Odoo's average cost of each PIM SKU in one company (its own currency). */
async function costsBySku(odoo: Odoo, company: number, skus: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < skus.length; i += 400) {
    const prods = await odoo("product.product", "search_read", [[["default_code", "in", skus.slice(i, i + 400)]]], { fields: ["default_code", "standard_price"], context: { allowed_company_ids: [company] } }) as { default_code: string; standard_price: number }[];
    for (const p of prods) {
      const c = Number(p.standard_price) || 0;
      if (c > 0 && !(out.get(p.default_code)! > c)) out.set(p.default_code, c); // a duplicated code: the higher cost
    }
  }
  return out;
}

// ---- Wix (read only) -----------------------------------------------------------
const WIX = "https://www.wixapis.com";
interface WixOrder {
  id: string; number: string; createdDate: string; updatedDate?: string; status: string; paymentStatus: string;
  priceSummary?: { total?: { amount?: string } };
  activities?: { type?: string; createdDate?: string; orderRefunded?: { amount?: { amount?: string } } }[];
}
function wixHeaders(siteKey: string) {
  return { Authorization: Deno.env.get("WIX_API_KEY")!, "wix-site-id": WIX_SITES[siteKey].siteId, "Content-Type": "application/json" };
}
async function wixOrders(siteKey: string, sinceIso: string): Promise<WixOrder[]> {
  const out: WixOrder[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const body = { search: { filter: { createdDate: { $gte: sinceIso } }, cursorPaging: cursor ? { limit: 100, cursor } : { limit: 100 } } };
    const r = await fetch(`${WIX}/ecom/v1/orders/search`, { method: "POST", headers: wixHeaders(siteKey), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Wix orders (${siteKey}) ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    out.push(...(j.orders ?? []));
    cursor = j.metadata?.cursors?.next ?? null;
    if (!cursor) break;
  }
  return out;
}
const orderTotal = (o: WixOrder) => Number(o.priceSummary?.total?.amount ?? 0) || 0;
const isRefunded = (o: WixOrder) => /REFUND/.test(o.paymentStatus ?? "");

/**
 * The refunds of the refunded orders: [{ orderId, at, amount }]. Read from the
 * order's payments (refunds with their date and amount), else from its
 * ORDER_REFUNDED activities, else — fully refunded — its total at its last update.
 */
async function wixRefunds(siteKey: string, orders: WixOrder[], diag: Record<string, any>) {
  const out: { orderId: string; at: string; amount: number }[] = [];
  for (const o of orders.filter(isRefunded)) {
    let got = false;
    const r = await fetch(`${WIX}/ecom/v1/payments/orders/${o.id}`, { headers: wixHeaders(siteKey) });
    if (r.ok) {
      const j = await r.json();
      for (const rf of (j.orderTransactions?.refunds ?? []) as Record<string, any>[]) {
        const amount = (rf.transactions ?? []).reduce((s: number, t: any) => s + (Number(t.amount?.amount ?? 0) || 0), 0);
        if (amount > 0 && rf.createdDate) { out.push({ orderId: o.id, at: rf.createdDate, amount }); got = true; }
      }
    }
    if (got) { diag.refundsFromPayments = (diag.refundsFromPayments ?? 0) + 1; continue; }
    for (const a of o.activities ?? []) {
      const amount = Number(a.orderRefunded?.amount?.amount ?? 0) || 0;
      if (a.type === "ORDER_REFUNDED" && amount > 0 && a.createdDate) { out.push({ orderId: o.id, at: a.createdDate, amount }); got = true; }
    }
    if (got) { diag.refundsFromActivities = (diag.refundsFromActivities ?? 0) + 1; continue; }
    if (o.paymentStatus === "FULLY_REFUNDED" && o.updatedDate) {
      out.push({ orderId: o.id, at: o.updatedDate, amount: orderTotal(o) });
      diag.refundsFromTotal = (diag.refundsFromTotal ?? 0) + 1;
    } else diag.refundsUnread = (diag.refundsUnread ?? 0) + 1;
  }
  return out;
}

/**
 * # of the PIM's products with more than 5 approved reviews on the store (Wix
 * Reviews; a review's entityId is the store's product id → `skuByWixId`).
 */
async function productsWithReviews(siteKey: string, skuByWixId: Map<string, string>, diag: Record<string, any>) {
  const perSku = new Map<string, number>();
  const seen = new Set<string>();
  const kinds: Record<string, number> = {};
  let cursor: string | null = null;
  let total = 0;
  let unmapped = 0;
  for (let page = 0; page < 200; page++) {
    const body = { query: { cursorPaging: cursor ? { limit: 100, cursor } : { limit: 100 } } };
    const r = await fetch(`${WIX}/reviews/v1/reviews/query`, { method: "POST", headers: wixHeaders(siteKey), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Wix reviews (${siteKey}) ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const reviews = (j.reviews ?? []) as { id?: string; namespace?: string; entityId?: string; origin?: { type?: string }; source?: unknown; moderation?: { moderationStatus?: string } }[];
    let fresh = 0;
    for (const rv of reviews) {
      if (rv.id && seen.has(rv.id)) continue; // a cursor that does not move on
      if (rv.id) seen.add(rv.id);
      fresh += 1;
      total += 1;
      const kind = `${rv.namespace ?? "?"}/${rv.origin?.type ?? "?"}/${rv.moderation?.moderationStatus ?? "?"}`;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      if ((rv.moderation?.moderationStatus ?? "APPROVED") !== "APPROVED" || !rv.entityId) continue;
      const sku = skuByWixId.get(rv.entityId);
      if (!sku) { unmapped += 1; continue; }
      perSku.set(sku, (perSku.get(sku) ?? 0) + 1);
    }
    cursor = j.pagingMetadata?.cursors?.next ?? j.metadata?.cursors?.next ?? null;
    if (!cursor || !fresh) break;
  }
  diag.reviews = total;
  diag.reviewsNotOnPimProducts = unmapped;
  diag.reviewedSkus = perSku.size;
  diag.reviewKinds = JSON.stringify(kinds);
  return [...perSku.values()].filter((n) => n > 5).length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  try {
    // --- caller ---------------------------------------------------------------
    const cronSecret = Deno.env.get("CRON_SECRET");
    const viaCron = Boolean(cronSecret && req.headers.get("x-cron-secret") === cronSecret);
    if (!viaCron) {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!token) return json({ error: "Missing Authorization header." }, 401);
      if (!(await isServiceRole(SUPABASE_URL, token, SERVICE_ROLE))) {
        const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
        const { data: { user } } = await callerClient.auth.getUser();
        if (!user) return json({ error: "Invalid or expired session." }, 401);
        const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
        if (!["admin", "editor"].includes(profile?.role ?? "")) return json({ error: "Only admins and editors can refresh the scorecard." }, 403);
      }
    }

    const body = await req.json().catch(() => ({}));
    const mode: string = body.mode ?? "fill";
    if (!["fill", "preview"].includes(mode)) return json({ error: `Unknown mode "${mode}".` }, 400);
    const boards: string[] = (Array.isArray(body.boards) ? body.boards : Object.keys(BOARDS)).filter((b: string) => BOARDS[b]);
    const backfill = Math.max(0, Math.min(26, Number(body.backfill) || 0));
    const refresh = Math.max(0, Math.min(backfill, Number(body.refresh) || 0));
    const today = etToday();
    const thisColumn = sundayOf(today);
    // The week running now (its column is next Sunday's): numbers so far.
    const running = body.running === true || body.running === "only";
    const runColumn = addDays(thisColumn, 7);
    // Newest first, never before W44 — where the scorecard starts (FIRST_WEEK in
    // src/features/scorecard/lib/weeks.js; user, 2026-11-05): older columns stay as they are.
    const columns = body.running === "only" ? [] : Array.from({ length: backfill + 1 }, (_, i) => addDays(thisColumn, -7 * i)).filter((c, i) => i === 0 || c >= FIRST_COLUMN);
    const loop = running ? [runColumn, ...columns] : columns;

    const { data: metrics, error: mErr } = await admin
      .from("scorecard_metrics")
      .select("id, board, market, name, auto_key")
      .in("board", boards)
      .in("auto_key", SERVER_KEYS)
      .eq("archived", false);
    if (mErr) throw mErr;
    // A preview can try keys on rows that do not have them yet:
    // `assume: [{ board, market, key }]` (nothing is written in a preview).
    if (mode === "preview" && Array.isArray(body.assume)) {
      for (const [i, a] of (body.assume as { board: string; market: string; key: string }[]).entries()) {
        if (boards.includes(a.board) && SERVER_KEYS.includes(a.key)) metrics.push({ id: `assume-${i}`, board: a.board, market: a.market, name: `(assumed) ${a.key}`, auto_key: a.key });
      }
    }
    if (!metrics?.length) return json({ ok: true, mode, columns: loop, note: "No measurable of these boards is filled by the server.", values: [] });

    // The PIM's products and how Odoo's codes map onto them.
    const { data: products, error: pErr } = await admin.from("products").select("sku, brand, model_name, workflow_status, is_obsolete, map_cad, map_usd, msrp_cad, msrp_usd, wix_product_id, cost_usd_lowes_sod_bbb, cost_usd_lowes_sod_bbb_orange, cost_usd_lowes_sod_bbb_purple");
    if (pErr) throw pErr;
    const live = (products ?? []).filter((p) => p.workflow_status !== "archived");
    const { data: topLosersRow } = await admin.from("app_settings").select("value").eq("key", "scorecard_top_losers").maybeSingle();
    const topLosers = (topLosersRow?.value ?? {}) as Record<string, string[]>;
    // The review count of each store listing at the last run: new reviews are the week's difference.
    type ReviewState = { column: string; prev: Record<string, number> | null; first: Record<string, number> };
    const { data: reviewRow } = await admin.from("app_settings").select("value").eq("key", "scorecard_review_counts").maybeSingle();
    const reviewState = (reviewRow?.value ?? {}) as Record<string, ReviewState>;
    let reviewsChanged = false;
    const exact = new Set((products ?? []).map((p) => p.sku));
    const lower = new Map((products ?? []).map((p) => [p.sku.toLowerCase(), p.sku]));
    const skuOf = (code: string | null) => (code == null ? null : exact.has(code) ? code : lower.get(code.toLowerCase()) ?? null);

    // One run reads each thing once (MAP %, promotions, deals, coupons).
    const memo = new Map<string, Promise<unknown>>();
    const sharedLoad = (key: string, loader: () => Promise<unknown>) => {
      if (!memo.has(key)) memo.set(key, loader());
      return memo.get(key);
    };
    const reports = createPriceAlignment({ db: admin, sharedLoad, readingsOfOneStore: true });
    const liveRows = createScorecardLive({ db: admin, targets: alignTargets(WIX_SITES), latestReport: reports.latestReport });

    const odoo = await odooClient();
    const oldest = loop.at(-1)!;
    const newest = loop[0];
    const now = Date.now();
    const out: { metricId: string; board: string; market: string; name: string; key: string; week: string; value: number | null; note?: string | null }[] = [];
    const diagnostics: Record<string, Record<string, any>> = {};

    for (const board of boards) {
      for (const [market, src] of Object.entries(BOARDS[board]) as [Market, MarketSource][]) {
        const rows = metrics.filter((m) => m.board === board && m.market === market);
        if (!rows.length) continue;
        const keys = new Set(rows.map((m) => m.auto_key));
        const diag: Record<string, any> = {};
        diagnostics[`${board}:${market}`] = diag;
        // Orders from the earliest window any key needs: 90 days before the
        // oldest column (SKUs without a sale), up to this column.
        const usdRate = await usdPerUnit(odoo, src.company);
        const { orders, lines } = await loadOrders(odoo, src.odoo, addDays(oldest, -91), newest, skuOf, usdRate ?? 0);
        const orderDate = new Map(orders.map((o) => [o.id, o.date]));
        const inDays = (iso: string, fromDay: string, toDay: string) => iso >= isoOf(etMidnightUtc(fromDay)) && iso < isoOf(etMidnightUtc(toDay));
        const paidOrderIds = new Set(lines.filter(isSale).map((l) => l.orderId));
        // The channel's listed SKUs ("# SKU not sold", obsoletes): its ids in the PIM.
        const listed = src.listed ? await listedSkus(admin, src.listed) : undefined;
        const population = listed === undefined ? null : live.filter((p) => listed === null || listed.has(p.sku));
        if (population) diag.listedSkus = population.length;
        const brandOf = new Map((products ?? []).map((p) => [p.sku, String(p.brand ?? "").toLowerCase()]));

        // The week's "Actions taken for top losers" note, from the facts below.
        const losersNoteFor = async (boardKey: string, mk: Market, s: MarketSource, fromDay: string, toDay: string): Promise<string> => {
          // Top losers: sales of the week under the SKU's weekly average of the 8 weeks before.
          const now = new Map<string, { units: number; sales: number }>();
          const base = new Map<string, { units: number; sales: number }>();
          for (const l of lines) {
            if (!l.sku || !isSale(l)) continue;
            const d = orderDate.get(l.orderId);
            if (!d) continue;
            const into = inDays(d, fromDay, toDay) ? now : inDays(d, addDays(fromDay, -56), fromDay) ? base : null;
            if (!into) continue;
            const cur = into.get(l.sku) ?? { units: 0, sales: 0 };
            cur.units += l.qty;
            cur.sales += l.subtotal;
            into.set(l.sku, cur);
          }
          const top = [...base].map(([sku, b]) => ({ sku, units: now.get(sku)?.units ?? 0, sales: now.get(sku)?.sales ?? 0, avgUnits: b.units / 8, avgSales: b.sales / 8 }))
            .filter((x) => x.avgSales >= 50 && x.avgSales - x.sales > 0)
            .sort((a, b) => (b.avgSales - b.sales) - (a.avgSales - a.sales))
            .slice(0, 5);
          const skus = top.map((x) => x.sku);
          const stockMarket: Market = s.stock ?? (s.company === CA ? "ca" : "us");
          const today = etToday();
          const priceField = mk === "us" ? "promo_price_usd" : "promo_price_cad";
          const { data: promotionsNow } = skus.length
            ? await admin.from("promotions").select(`name, kind, status, period, marketplaces, ${PROMO_DATE_COLUMNS}, promotion_prices(sku, in_ca, in_us, promo_price_cad, promo_price_usd)`).gte("period", prevPeriod(periodOfDay(today))).neq("status", "ended").in("promotion_prices.sku", skus)
            : { data: [] };
          const dealsHere = (promotionsNow ?? []).filter((p: any) => p.kind !== "monthly" && (p.marketplaces ?? []).some((c: string) => s.promo.includes(c))).map((p: any) => ({ p, w: promoWindow(p, mk) }));
          const monthlyNow = (promotionsNow ?? []).filter((p: any) => p.kind === "monthly" && p.status === "active" && windowContains(promoWindow(p, mk), today));
          const memberOf = (p: any, sku: string) => (p.promotion_prices ?? []).find((r: any) => r.sku === sku && ((mk === "us" ? r.in_us : r.in_ca) ?? r[priceField] != null));
          const nextDeals = dealsHere.filter(({ w }: any) => w.start > today).sort((a: any, b: any) => a.w.start.localeCompare(b.w.start));
          const [{ data: inv }, { data: pages }, { data: promos }, { data: log }] = await Promise.all([
            skus.length ? admin.from("product_inventory").select("sku, available, eta").eq("market", stockMarket).in("sku", skus) : Promise.resolve({ data: [] }),
            skus.length ? admin.from("where_to_buy_readings").select("retailer, sku, verdict, in_stock, price, read_at").in("retailer", s.pages).in("sku", skus) : Promise.resolve({ data: [] }),
            admin.from("promotions").select("name, kind, created_at, marketplaces").gte("created_at", isoOf(etMidnightUtc(fromDay))).lt("created_at", isoOf(etMidnightUtc(toDay))),
            admin.from("audit_log").select("entity_id, target, summary, metadata, occurred_at").gte("occurred_at", isoOf(etMidnightUtc(fromDay))).lt("occurred_at", isoOf(etMidnightUtc(toDay))).limit(2000),
          ]);
          const onBoard = (p: { marketplaces?: string[] | null }) => (p.marketplaces ?? []).some((c) => s.promo.includes(c));
          const losers: LoserFact[] = top.map((x) => {
            const prod = (products ?? []).find((p) => p.sku === x.sku);
            const brief: string[] = [];
            const st = (inv ?? []).find((r) => r.sku === x.sku);
            if (st && st.available <= 0) brief.push(`0 in our ${mk.toUpperCase()} stock`);
            for (const pg of (pages ?? []).filter((r) => r.sku === x.sku)) {
              if (pg.verdict === "broken") brief.push("store link broken"); else if (pg.in_stock === false) brief.push("sold out on the store");
            }
            // What could bring the sales back, from these same facts: the note
            // may only recommend what is listed here.
            const todo: string[] = [];
            const own = (pages ?? []).filter((r) => r.sku === x.sku);
            const isBroken = own.some((r) => r.verdict === "broken");
            const soldOut = own.some((r) => r.verdict !== "broken" && r.in_stock === false);
            const live = own.find((r) => r.verdict !== "broken" && r.in_stock !== false && r.price != null);
            const onHand = st ? Number(st.available) : null;
            const running = dealsHere.filter(({ w, p }: any) => windowContains(w, today) && memberOf(p, x.sku)).sort((a: any, b: any) => b.w.start.localeCompare(a.w.start))[0]?.p ?? monthlyNow.find((p: any) => memberOf(p, x.sku)) ?? null;
            const promoPrice = running ? Number(memberOf(running, x.sku)?.[priceField] ?? NaN) : NaN;
            if (onHand !== null && onHand <= 0 && !s.ships?.length) {
              todo.push(st?.eta ? `stock is due ${st.eta}: plan a promotion for when it arrives` : "there is no arrival date: confirm the purchase order");
            } else {
              if (s.ships?.length) todo.push("check its FBA stock, which the PIM cannot see");
              if (soldOut && onHand !== null && onHand > 0) todo.push(`we have ${onHand} units but the store shows it sold out: send the stock to the store or ask it to reactivate the item`);
              if (isBroken) todo.push("fix or replace the broken store link");
              if (!own.length) todo.push("confirm the listing is live on this store");
              if (live) {
                const map = Number(mk === "us" ? prod?.map_usd : prod?.map_cad) || null;
                // BB&B and Overstock take flash deals at a level the promotion's row does not hold.
                const expected = running ? ((running.kind === "flash" || running.kind === "mk_event") && boardKey === "bbb_overstock" ? null : promoPrice > 0 ? promoPrice : null) : map;
                if (expected != null && priceOff(Number(live.price), expected)) todo.push(`the store shows ${money(Number(live.price))} against the expected ${money(expected)}: correct the price`);
                if (running) todo.push("review its images, title and reviews");
                else {
                  const next = nextDeals[0];
                  if (next && memberOf(next.p, x.sku)) todo.push(`it is in "${next.p.name}" from ${next.w.start}: confirm it is loaded on the store`);
                  else if (next) todo.push(`add it to "${next.p.name}", which starts ${next.w.start}`);
                  else todo.push("add it to the next promotion");
                }
              }
            }
            if (!todo.length) todo.push("review the listing on this store");
            const stockText = s.ships?.length ? "FBA stock is not in the PIM"
              : onHand === null ? "Not tracked"
              : onHand > 0 ? `${onHand} ${onHand === 1 ? "unit" : "units"}${x.avgUnits > 0 ? ` (about ${Math.round(onHand / x.avgUnits)} weeks)` : ""}`
              : `0 units${st?.eta ? ` (due ${st.eta})` : ""}`;
            return { ...x, model: prod?.model_name ?? null, brief, todo, stock: stockText, promo: running?.name ?? null };
          });
          // What the PIM recorded that week for this channel or these SKUs.
          // A Wix push counts for this store only (the Wix target is shared by the five stores).
          const storeLabel = s.wix ? WIX_SITES[s.wix]?.label ?? s.wix : "";
          const thisStore = (r: { summary?: string | null; metadata?: Record<string, any> | null }) => Boolean(s.wix) && (String(r.summary ?? "").includes(storeLabel) || r.metadata?.site === s.wix || r.metadata?.results?.[s.wix as string]?.ok === true);
          const targets = new Set([...s.promo, ...s.pages, ...(boardKey === "wayfair" ? ["wayfair"] : []), ...(s.wix ? ["wix"] : [])]);
          const actions = [
            ...(promos ?? []).filter((p) => onBoard(p) && inDays(String(p.created_at).replace("T", " ").slice(0, 19), fromDay, toDay)).map((p) => `${String(p.created_at).slice(5, 10)}: created ${p.kind} "${p.name}"`),
            ...(log ?? []).filter((r) => (targets.has(r.target) || (skus.includes(r.entity_id) && r.target === "pim")) && !/^Where to Buy/i.test(String(r.summary ?? "")) && (r.target !== "wix" || thisStore(r)))
              .map((r) => `${String(r.occurred_at).slice(5, 10)}: ${String(r.summary ?? "").replace(/\s+/g, " ")}`),
          ];
          const uniq = [...new Set(actions)].slice(0, 8).map((a) => {
            const m = a.match(/^(\d\d)-(\d\d): (.*)$/);
            return m ? `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}: ${shorten(cap(m[3]))}` : shorten(a);
          });
          diag.noteLosers = losers.map((l) => l.sku).join(", ");
          diag.noteActions = uniq;
          return writeLosersNote(losers, uniq);
        };
        // Returns Odoo received for the channel (read over 4 weeks).
        const returns = keys.has("return_rate") || keys.has("returns_value") || keys.has("returns_note") ? await receivedReturns(odoo, via(src.odoo, "sale_id."), addDays(oldest, -35)) : null;
        if (returns) diag.returnsReceived = returns.length;

        let stock: Map<string, number> | null = null;
        if (keys.has("oos_loss") && src.stock) {
          const { data: inv, error } = await admin.from("product_inventory").select("sku, available").eq("market", src.stock);
          if (error) throw error;
          stock = new Map((inv ?? []).map((r) => [r.sku, Number(r.available) || 0]));
        }
        let pushes: { entity_id: string; occurred_at: string; metadata: Record<string, unknown> | null }[] = [];
        if (keys.has("listings_updated") && src.wixSites) {
          const wixSites = src.wixSites;
          const { data, error } = await admin
            .from("audit_log")
            .select("entity_id, occurred_at, metadata")
            .eq("action", "push").eq("entity_type", "product").eq("target", "wix")
            .gte("occurred_at", isoOf(etMidnightUtc(addDays(oldest, -7))))
            .lt("occurred_at", isoOf(etMidnightUtc(newest)))
            .limit(5000);
          if (error) throw error;
          const onSite = (md: Record<string, unknown> | null) => {
            if (!md) return false;
            if (wixSites.includes(String(md.site ?? ""))) return true;
            const results = md.results as Record<string, { ok?: boolean }> | undefined;
            return Boolean(results && wixSites.some((s) => results[s]?.ok));
          };
          pushes = (data ?? []).filter((p) => p.entity_id && onSite(p.metadata as Record<string, unknown> | null));
        }

        // Shipping: the paid orders of the columns' weeks and when they were fully shipped.
        let shipped: Map<number, { done: string | null; any: boolean }> | null = null;
        if (SHIP_KEYS.some((k) => keys.has(k))) {
          const since = isoOf(etMidnightUtc(addDays(oldest, -7)));
          // Only what we ship ourselves (Amazon FBA ships from Amazon's stock).
          shipped = await shippedAt(odoo, admin, orders.filter((o) => o.date >= since && paidOrderIds.has(o.id) && (!src.ships || (o.mp != null && src.ships.includes(o.mp)))), diag);
        }
        // The store's own orders (cancelled, refunded) and the returns Odoo received.
        let wixList: WixOrder[] = [];
        let refunds: { orderId: string; at: string; amount: number }[] = [];
        let returned = new Set<string>();
        if (src.wix && WIX_KEYS.some((k) => keys.has(k))) {
          // Refunds land weeks after the order: orders of the 4 months before the oldest week too.
          wixList = await wixOrders(src.wix, isoOf(etMidnightUtc(addDays(oldest, -127))));
          const allRefunds = await wixRefunds(src.wix, wixList, diag);
          const r = await returnedWixOrders(odoo, via(src.odoo, "sale_id."), addDays(oldest, -400));
          returned = r.wixOrderIds;
          // Only money refunded on goods that left the warehouse: an order
          // cancelled and refunded before shipping returns nothing.
          const shippedIds = await shippedWixOrders(odoo, [...new Set(allRefunds.map((x) => x.orderId))]);
          refunds = allRefunds.filter((x) => shippedIds.has(x.orderId));
          diag.refundsNeverShipped = allRefunds.length - refunds.length;
          diag.wixOrders = wixList.length;
          diag.wixRefunds = refunds.length;
          diag.odooReturns = r.returns;
          diag.odooReturnsWithoutWixOrder = r.unmatched;
        }

        for (const column of loop) {
          const from = addDays(column, -7); // the data week: the 7 days before the column's Sunday
          const week = orders.filter((o) => inDays(o.date, from, column));
          const sold = week.filter((o) => o.state !== "cancel");
          const weekIds = new Set(sold.map((o) => o.id));
          // A sale is a product sold with a price (user, 2026-11-05): a $0
          // order — a spare part, a warranty replacement, an open box sent
          // free — is no order, and the shipping charged is no unit.
          const paidLines = lines.filter((l) => weekIds.has(l.orderId) && isSale(l));
          const paidOrders = new Set(paidLines.map((l) => l.orderId));
          const linesIn = (a: string, b: string) => lines.filter((l) => { const d = orderDate.get(l.orderId); return d != null && inDays(d, a, b); });
          const value: Record<string, number | null> = {};
          const notes: Record<string, string> = {}; // text cells (the AI note)
          // Sales: the untaxed total, shipping charged included — Odoo's own sales report.
          value.sales = round2(sold.reduce((s, o) => s + o.untaxed, 0));
          // The same in thousands of USD (Wayfair's "Total Sales. Thousands USD"):
          // an order paid in USD as it is, any other at Odoo's rate of today.
          if (usdRate != null) value.sales_usd_k = round2(sold.reduce((s, o) => s + o.usd, 0) / 1000);
          value.orders = paidOrders.size;
          value.units = paidLines.reduce((s, l) => s + l.qty, 0);
          value.azuni_skus_sold = new Set(paidLines.filter((l) => l.sku && brandOf.get(l.sku) === "azuni").map((l) => l.sku)).size;
          // Products only (no shipping), the same paid lines as Orders and Units.
          if (topLosers[board]) {
            const watched = new Set(topLosers[board]);
            value.top_losers_sales = round2(paidLines.filter((l) => l.sku && watched.has(l.sku)).reduce((s, l) => s + l.subtotal, 0));
          }
          if (keys.has("skus_not_sold_90d") && population) {
            // The SKUs the channel lists (its ids in the PIM; Sinks Direct: every product) without a sale in 90 days.
            const soldSkus = new Set(linesIn(addDays(column, -90), column).filter((l) => isSale(l) && l.sku).map((l) => l.sku));
            value.skus_not_sold_90d = population.filter((p) => !soldSkus.has(p.sku)).length;
          }
          if (returns) {
            // Over the 4 weeks ending with the data week: orders with a return
            // Odoo received ÷ the paid orders placed in them, and the weekly
            // average value of the goods back (bodega validates returns in batches).
            const start = addDays(column, -28);
            const inWindow = returns.filter((r) => inDays(r.at, start, column));
            const placed = orders.filter((o) => paidOrderIds.has(o.id) && inDays(o.date, start, column)).length;
            value.return_rate = ratio(new Set(inWindow.map((r) => r.orderId)).size, placed);
            value.returns_value = round2(inWindow.reduce((s, r) => s + r.value, 0) / 4);
            if (keys.has("returns_note")) {
              // The note reads only what came back in this data week.
              const back = new Map<string, { qty: number; value: number }>();
              for (const it of returns.filter((r) => inDays(r.at, from, column)).flatMap((r) => r.items)) {
                const key = skuOf(it.code) ?? it.code ?? "Unknown SKU";
                const cur = back.get(key) ?? { qty: 0, value: 0 };
                cur.qty += it.qty;
                cur.value += it.value;
                back.set(key, cur);
              }
              const list = [...back].sort((a, b) => b[1].value - a[1].value).map(([sku, x]) => `${sku} (${x.qty} ${x.qty === 1 ? "unit" : "units"}, ${money(x.value)})`);
              notes.returns_note = list.length ? `Received back this week: ${list.join(", ")}. Total ${money([...back.values()].reduce((t, x) => t + x.value, 0))}.` : "No returns this week.";
            }
          }
          if (keys.has("listings_updated")) {
            value.listings_updated = new Set(pushes.filter((p) => p.occurred_at >= isoOf(etMidnightUtc(from)) && p.occurred_at < isoOf(etMidnightUtc(column))).map((p) => p.entity_id)).size;
          }
          if (shipped) {
            // The week's paid orders: shipped by their deadline, after it, or
            // not yet with the deadline gone; the others are still on time to ship.
            // One still open in Odoo 14 days after it was placed is left out:
            // the marketplace cancelled it and Odoo was not told (it would read
            // as late for ever) — a backorder that ships later counts as late then.
            let onTime = 0;
            let late = 0;
            for (const id of paidOrders) {
              const s = shipped.get(id);
              if (!s?.any || s.unknown) continue; // nothing to ship from our warehouses, or no label to date it
              const placedAt = Date.parse(orderDate.get(id)!);
              const deadline = shipDeadline(orderDate.get(id)!);
              if (s.done) { if (Date.parse(s.done) < deadline) onTime += 1; else late += 1; } else if (now >= deadline) {
                if (now - placedAt <= 14 * DAY) late += 1; else diag.openPast14Days = (diag.openPast14Days ?? 0) + 1;
              }
            }
            value.on_time_ship = ratio(onTime, onTime + late);
            value.late_ship_rate = ratio(late, onTime + late);
          }
          if (src.wix && WIX_KEYS.some((k) => keys.has(k))) {
            // The store's paid orders of the week (Wix): cancelled; defective =
            // cancelled, refunded or returned (user, 2026-11-05).
            const placed = wixList.filter((o) => orderTotal(o) > 0 && inWeek(o.createdDate, from, column));
            const cancelled = placed.filter((o) => o.status === "CANCELED").length;
            const defective = placed.filter((o) => o.status === "CANCELED" || isRefunded(o) || returned.has(o.id)).length;
            value.cancel_rate = ratio(cancelled, placed.length);
            value.odr = ratio(defective, placed.length);
            // Money refunded in the week on orders whose goods never came back.
            value.returns_not_received = round2(refunds.filter((r) => inWeek(r.at, from, column) && !returned.has(r.orderId)).reduce((s, r) => s + r.amount, 0));
          }
          if (column === thisColumn) {
            value.obsolete_skus = (population ?? live).filter((p) => p.is_obsolete).length;
            if (stock) {
              // Products at 0 units now that sold in the 8 weeks before the
              // data week: their average weekly sales is what the store loses.
              const bySku = new Map<string, number>();
              for (const l of linesIn(addDays(from, -56), from)) if (l.sku) bySku.set(l.sku, (bySku.get(l.sku) ?? 0) + l.subtotal);
              let loss = 0;
              for (const [sku, avail] of stock) if (avail <= 0) loss += (bySku.get(sku) ?? 0) / 8;
              value.oos_loss = round2(loss);
            }
            if (keys.has("reviews_5plus") && src.wix) {
              // The store's product ids of the PIM's products (Sinks Direct
              // Canada's also live in the legacy products.wix_product_id).
              const { data: links, error } = await admin.from("wix_links").select("sku, wix_product_id").eq("site", src.wix);
              if (error) throw error;
              const skuByWixId = new Map((links ?? []).map((l) => [l.wix_product_id, l.sku]));
              if (src.wix === "sinksdirect_ca") for (const p of products ?? []) if (p.wix_product_id && !skuByWixId.has(p.wix_product_id)) skuByWixId.set(p.wix_product_id, p.sku);
              value.reviews_5plus = await productsWithReviews(src.wix, skuByWixId, diag);
            }
            if (keys.has("no_profit_skus") && src.wix) {
              // Not profitable (user, 2026-11-05): this week's price on the store
              // (the running monthly promotion, else the regular price) under
              // Odoo's average cost plus the SKU's real shipping cost per unit of
              // the last 180 days (ShipStation labels). A SKU we never shipped
              // in that time has no shipping cost to add: only its cost counts.
              const site = WIX_SITES[src.wix];
              const promo = new Map<string, number>();
              if (site.promoAware) {
                const promoField = site.market === "us" ? "promo_price_usd" : "promo_price_cad";
                const { data: promos, error } = await admin
                  .from("promotions")
                  .select(`period, starts_on, ends_on, ca_starts_on, ca_ends_on, us_starts_on, us_ends_on, promotion_prices(sku, ${promoField})`)
                  .eq("status", "active").eq("kind", "monthly");
                if (error) throw error;
                for (const p of promos ?? []) {
                  if (!windowContains(promoWindow(p, site.market as Market), today)) continue;
                  for (const row of (p.promotion_prices ?? []) as Record<string, unknown>[]) {
                    if (row[promoField] != null) promo.set(row.sku as string, Number(row[promoField]));
                  }
                }
              }
              const costs = await costsBySku(odoo, src.company, live.map((p) => p.sku));
              const shipping = await shipCostPerUnit(odoo, admin, via(src.odoo, "sale_id."), addDays(today, -180), site.market === "us" ? "USD" : "CAD", skuOf, diag);
              const below: string[] = [];
              for (const p of live) {
                const price = promo.get(p.sku) ?? (p as Record<string, unknown>)[site.priceField] as number | null;
                const cost = costs.get(p.sku);
                if (price == null || cost == null) continue;
                const ship = shipping.get(p.sku) ?? 0;
                if (Number(price) < cost + ship) below.push(`${p.sku} ${price} < ${round2(cost)}${ship ? ` ${ship > 0 ? "+" : "-"} ${round2(Math.abs(ship))} net shipping` : ""}`);
              }
              diag.costsKnown = costs.size;
              diag.promoPrices = promo.size;
              diag.belowCost = below.join(", ");
              value.no_profit_skus = below.length;
            }
            if (keys.has("no_profit_skus") && src.wholesale && population) {
              // What the marketplace pays us this week against Odoo's average cost
              // (user, 2026-11-09). The marketplace pays the shipping, so none is added.
              // Level: Purple while a deal on this channel has the SKU, else Orange in the monthly promotion, else Blue.
              const priceKey = market === "us" ? "promo_price_usd" : "promo_price_cad";
              const { data: promos, error } = await admin.from("promotions")
                .select(`kind, status, marketplaces, period, ${PROMO_DATE_COLUMNS}, promotion_prices(sku, in_ca, in_us, promo_price_cad, promo_price_usd)`)
                .gte("period", prevPeriod(periodOfDay(today))).neq("status", "ended");
              if (error) throw error;
              const level = new Map<string, "orange" | "purple">();
              for (const p of (promos ?? []) as any[]) {
                const monthly = p.kind === "monthly";
                if (monthly ? p.status !== "active" : !(p.marketplaces ?? []).some((c: string) => src.promo.includes(c))) continue;
                if (!windowContains(promoWindow(p, market as Market), today)) continue;
                for (const r of p.promotion_prices ?? []) {
                  if (!((market === "us" ? r.in_us : r.in_ca) ?? r[priceKey] != null)) continue;
                  if (!monthly) level.set(r.sku, "purple"); else if (!level.has(r.sku)) level.set(r.sku, "orange");
                }
              }
              const costs = await costsBySku(odoo, src.company, population.map((p) => p.sku));
              const below: string[] = [];
              for (const p of population as Record<string, any>[]) {
                const paid = p[src.wholesale[level.get(p.sku) ?? "blue"]];
                const cost = costs.get(p.sku);
                if (paid == null || cost == null) continue;
                if (Number(paid) < cost) below.push(`${p.sku} ${paid} < ${round2(cost)}`);
              }
              diag.belowCost = below.join(", ");
              value.no_profit_skus = below.length;
            }
            if (keys.has("reviews_new")) {
              // New reviews of a column's data week: each listing's count when this
              // column opened (the week just ended) against when the column before
              // opened. A listing seen for the first time adds nothing.
              const items: Record<string, number> = {};
              for (let from_ = 0; ; from_ += 1000) {
                const { data, error } = await admin.from("where_to_buy_links").select("retailer, page_item_id, review_count").in("retailer", src.pages).not("review_count", "is", null).not("page_item_id", "is", null).range(from_, from_ + 999);
                if (error) throw error;
                for (const r of data ?? []) { const k = `${r.retailer}:${r.page_item_id}`; items[k] = Math.max(items[k] ?? 0, Number(r.review_count)); }
                if ((data ?? []).length < 1000) break;
              }
              const key = `${board}:${market}`;
              const saved = reviewState[key];
              const sameColumn = saved?.column === column;
              const first = sameColumn && Object.keys(saved.first).length ? saved.first : items;
              const prev = sameColumn ? saved.prev : saved?.first ?? null;
              if (prev && Object.keys(prev).length) value.reviews_new = Object.keys(first).reduce((t, k) => t + (k in prev ? Math.max(0, first[k] - prev[k]) : 0), 0);
              reviewState[key] = { column, prev, first };
              reviewsChanged = true;
              diag.reviewListings = Object.keys(items).length;
            }
            if (keys.has("losers_note")) {
              // Written once per column (a closed week), again only on request
              // (`regenerate`) — a preview always writes it.
              const noteIds = rows.filter((r) => r.auto_key === "losers_note" && !String(r.id).startsWith("assume")).map((r) => r.id);
              const { data: have, error } = noteIds.length ? await admin.from("scorecard_values").select("metric_id, note, origin").in("metric_id", noteIds).eq("week_start", column) : { data: [], error: null };
              if (error) throw error;
              // Kept: a note the PIM already wrote this week. A typed one is replaced, like any value of a PIM row.
              if (mode === "preview" || body.regenerate || !(have ?? []).some((h) => h.note && h.origin === "auto")) {
                notes.losers_note = await losersNoteFor(board, market, src, from, column);
              } else diag.noteKept = true;
            }
          }
          // The rows that read the PIM as it is now: this week's column and the running one.
          const liveKeys = (column === thisColumn || column === runColumn) ? LIVE_KEYS.filter((k: string) => keys.has(k)) : [];
          if (liveKeys.length) {
            try {
              Object.assign(value, await liveRows.values({ keys: liveKeys, market, channels: src.promo, align: src.align ?? src.pages, column, today }));
            } catch (err) {
              diag.liveError = (err as Error).message; // the tab's other numbers still go
              console.error(`[scorecard-fill] ${board}/${market} live rows:`, (err as Error).message);
            }
          }
          for (const m of rows) {
            if (column !== thisColumn && SNAPSHOT_KEYS.has(m.auto_key)) continue;
            if (!(m.auto_key in value) && !(m.auto_key in notes)) continue;
            out.push({ metricId: m.id, board, market, name: m.name, key: m.auto_key, week: column, value: value[m.auto_key] ?? null, note: notes[m.auto_key] ?? null });
          }
        }
      }
    }

    let written = 0;
    let replacedCount = 0;
    if (mode === "fill") {
      if (reviewsChanged) await admin.from("app_settings").upsert({ key: "scorecard_review_counts", value: reviewState, updated_at: new Date().toISOString() }, { onConflict: "key" });
      const row = (v: typeof out[number]) => ({ metric_id: v.metricId, week_start: v.week, value: v.value, note: v.note ?? null, origin: "auto" });
      const filled = (v: typeof out[number]) => v.value != null || Boolean(v.note);
      // This week's column and the running week's: always the PIM's.
      const current = out.filter((v) => (v.week === thisColumn || (running && v.week === runColumn)) && filled(v)).map(row);
      // Past weeks: where nothing is stored yet — or, in the `refresh` newest
      // ones, where the PIM wrote the value. Typed / imported values stay.
      const pastValues = out.filter((v) => v.week !== thisColumn && v.week !== runColumn && filled(v));
      const refreshable = new Set(columns.slice(1, refresh + 1));
      // `replaceTyped` (user, 2026-11-05: "una sola fuente"): a PIM row's past
      // weeks become the PIM's numbers too, so its trend is one source; every
      // typed / imported value replaced goes to the Activity Log first.
      const replaceTyped = body.replaceTyped === true;
      const existing = new Map<string, { origin: string; value: number | null; note: string | null }>();
      const metricIds = [...new Set(pastValues.map((v) => v.metricId))];
      for (let i = 0; i < metricIds.length; i += 100) {
        const { data, error } = await admin.from("scorecard_values").select("metric_id, week_start, origin, value, note").in("metric_id", metricIds.slice(i, i + 100)).gte("week_start", oldest);
        if (error) throw error;
        for (const e of data ?? []) existing.set(`${e.metric_id}|${e.week_start}`, e);
      }
      const replaced: { metric_id: string; week_start: string; value: number | null; note: string | null; origin: string }[] = [];
      const past = pastValues.filter((v) => {
        const had = existing.get(`${v.metricId}|${v.week}`);
        if (had == null || (had.origin === "auto" && refreshable.has(v.week))) return true;
        if (replaceTyped && had.origin !== "auto") {
          replaced.push({ metric_id: v.metricId, week_start: v.week, value: had.value, note: had.note, origin: had.origin });
          return true;
        }
        return false;
      }).map(row);
      if (replaced.length) {
        const { error } = await admin.from("audit_log").insert({
          action: "update", entity_type: "scorecard", entity_id: null, target: "pim", actor_name: "PIM (scorecard-fill)",
          summary: `EOS ScoreCard · ${boards.join(", ")}: ${replaced.length} typed / imported values of the PIM's rows replaced by the PIM's numbers (one source per row)`,
          metadata: { replaced },
        });
        if (error) throw error;
        replacedCount = replaced.length;
      }
      for (const batch of [current, past]) {
        if (!batch.length) continue;
        const { error } = await admin.from("scorecard_values").upsert(batch, { onConflict: "metric_id,week_start" });
        if (error) throw error;
      }
      written = current.length + past.length;
      await admin.from("app_settings").upsert({ key: SETTINGS_KEY, value: { at: new Date().toISOString(), ok: true, boards, column: thisColumn, running: running ? body.running : false, backfill, refresh, values: written } }, { onConflict: "key" });
    }
    return json({ ok: true, mode, column: thisColumn, dataWeek: [addDays(thisColumn, -7), addDays(thisColumn, -1)], ...(running ? { runningColumn: runColumn, runningSince: thisColumn } : {}), backfill, refresh, written, replacedTyped: replacedCount, values: out, ...(mode === "preview" ? { diagnostics } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin.from("app_settings").upsert({ key: SETTINGS_KEY, value: { at: new Date().toISOString(), ok: false, error: message } }, { onConflict: "key" });
    return json({ error: message }, 500);
  }
});
