// scorecard-fill — the EOS ScoreCard numbers the PIM works out on the server
// (user, 2026-11-04: "que la mayoría de números se vengan automáticos",
// starting with Sinks Direct). Sources: Odoo's sale orders (every
// marketplace's orders are imported there — the Wix sites by wix_site_name)
// and the PIM's own tables (stock, the obsolete mark, the Activity Log). It
// writes scorecard_values with origin 'auto' for the rows whose auto_key is
// one of SERVER_KEYS; the browser works out the others (Price Alignment,
// promotions — src/features/scorecard/lib/autoMetrics.js).
//
// Weeks (user, 2026-11-04): a column — the week of its Sunday, W44 = Nov 1 —
// holds the numbers of the week BEFORE it (Oct 25–31), the week reviewed in
// that week's meeting. Days are Eastern time (Cambridge, Ontario).
//
// Body: { mode: "fill" | "preview", boards?: string[], backfill?: number }
//   fill     — this week's column, replaced (the rows are the PIM's), and with
//              backfill N the N columns before it where they are still empty
//              (history someone typed or imported stays as it is).
//   preview  — the same numbers, nothing written.
// Caller: cron (x-cron-secret, daily), the service-role key, or an admin /
// editor (the page's "Refresh PIM numbers").
// Secrets: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY, CRON_SECRET.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isServiceRole } from "../_shared/serviceRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type Market = "ca" | "us";
interface MarketSource {
  odoo: unknown[];      // Odoo domain selecting the store's orders
  wixSites: string[];   // Activity Log site keys of the store's pushes
  stock: Market;        // product_inventory market
}
// Boards the server fills, per market. Keep in step with `serverFill` in
// src/features/scorecard/lib/boards.js.
const BOARDS: Record<string, Partial<Record<Market, MarketSource>>> = {
  sinksdirect: {
    ca: { odoo: [["wix_site_name", "=", "sinksdirect.ca"]], wixSites: ["sinksdirect_ca"], stock: "ca" },
    us: { odoo: [["wix_site_name", "=", "sinksdirectusa.com"]], wixSites: ["sinksdirect_us"], stock: "us" },
  },
};
const SERVER_KEYS = ["sales", "orders", "units", "cancel_rate", "skus_not_sold_90d", "oos_loss", "obsolete_skus", "listings_updated"];
// Read from today's state (stock, marks): only this week's column gets them.
const SNAPSHOT_KEYS = new Set(["oos_loss", "obsolete_skus"]);
const SETTINGS_KEY = "scorecard_fill";

// ---- dates (Eastern) --------------------------------------------------------
const DAY = 86400000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const etToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
const sundayOf = (d: string) => addDays(d, -new Date(`${d}T00:00:00Z`).getUTCDay());
/** Toronto midnight of `day` as Odoo's UTC 'YYYY-MM-DD HH:MM:SS'. */
function etMidnightUtc(day: string): string {
  // 05:00Z is about midnight there; DST never switches before 2 AM.
  const probe = new Date(`${day}T05:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(probe);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const offset = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - probe.getTime();
  return new Date(Date.parse(`${day}T00:00:00Z`) - offset).toISOString().replace("T", " ").slice(0, 19);
}
const isoOf = (odoo: string) => odoo.replace(" ", "T") + "Z";

// ---- Odoo (JSON-RPC, read only) ----------------------------------------------
async function odooClient() {
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
  return (model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) =>
    rpc("object", "execute_kw", [db, uid, key, model, method, args, kwargs]);
}

interface Order { id: number; date: string; state: string; untaxed: number }
interface Line { orderId: number; sku: string | null; qty: number; subtotal: number }

async function loadOrders(odoo: Awaited<ReturnType<typeof odooClient>>, domain: unknown[], fromDay: string, toDay: string, skuOf: (code: string | null) => string | null) {
  const rows = await odoo("sale.order", "search_read", [[...domain, ["date_order", ">=", etMidnightUtc(fromDay)], ["date_order", "<", etMidnightUtc(toDay)], ["state", "in", ["sale", "done", "cancel"]]]], { fields: ["id", "date_order", "state", "amount_untaxed"] }) as { id: number; date_order: string; state: string; amount_untaxed: number }[];
  const orders: Order[] = rows.map((o) => ({ id: o.id, date: isoOf(o.date_order), state: o.state, untaxed: Number(o.amount_untaxed) || 0 }));
  const live = orders.filter((o) => o.state !== "cancel").map((o) => o.id);
  const lines: Line[] = [];
  const productIds = new Set<number>();
  const raw: { order_id: [number, string]; product_id: [number, string] | false; product_uom_qty: number; price_subtotal: number }[] = [];
  for (let i = 0; i < live.length; i += 400) {
    const part = await odoo("sale.order.line", "search_read", [[["order_id", "in", live.slice(i, i + 400)], ["display_type", "=", false], ["is_delivery", "=", false]]], { fields: ["order_id", "product_id", "product_uom_qty", "price_subtotal"] });
    raw.push(...part);
  }
  for (const l of raw) if (l.product_id) productIds.add(l.product_id[0]);
  const codes = new Map<number, string | null>();
  const ids = [...productIds];
  for (let i = 0; i < ids.length; i += 400) {
    const prods = await odoo("product.product", "read", [ids.slice(i, i + 400)], { fields: ["default_code"] }) as { id: number; default_code: string | false }[];
    for (const p of prods) codes.set(p.id, p.default_code || null);
  }
  for (const l of raw) {
    lines.push({ orderId: l.order_id[0], sku: l.product_id ? skuOf(codes.get(l.product_id[0]) ?? null) : null, qty: Number(l.product_uom_qty) || 0, subtotal: Number(l.price_subtotal) || 0 });
  }
  return { orders, lines };
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
    const thisColumn = sundayOf(etToday());
    const columns = Array.from({ length: backfill + 1 }, (_, i) => addDays(thisColumn, -7 * i)); // newest first

    const { data: metrics, error: mErr } = await admin
      .from("scorecard_metrics")
      .select("id, board, market, name, auto_key")
      .in("board", boards)
      .in("auto_key", SERVER_KEYS)
      .eq("archived", false);
    if (mErr) throw mErr;
    if (!metrics?.length) return json({ ok: true, mode, columns, note: "No measurable of these boards is filled by the server.", values: [] });

    // The PIM's products and how Odoo's codes map onto them.
    const { data: products, error: pErr } = await admin.from("products").select("sku, brand, workflow_status, is_obsolete");
    if (pErr) throw pErr;
    const live = (products ?? []).filter((p) => p.workflow_status !== "archived");
    const exact = new Set((products ?? []).map((p) => p.sku));
    const lower = new Map((products ?? []).map((p) => [p.sku.toLowerCase(), p.sku]));
    const skuOf = (code: string | null) => (code == null ? null : exact.has(code) ? code : lower.get(code.toLowerCase()) ?? null);

    const odoo = await odooClient();
    const oldest = columns.at(-1)!;
    const out: { metricId: string; board: string; market: string; name: string; key: string; week: string; value: number | null }[] = [];

    for (const board of boards) {
      for (const [market, src] of Object.entries(BOARDS[board]) as [Market, MarketSource][]) {
        const rows = metrics.filter((m) => m.board === board && m.market === market);
        if (!rows.length) continue;
        const keys = new Set(rows.map((m) => m.auto_key));
        // Orders from the earliest window any key needs: 90 days before the
        // oldest column (SKUs without a sale), up to this column.
        const { orders, lines } = await loadOrders(odoo, src.odoo, addDays(oldest, -91), thisColumn, skuOf);
        const orderDate = new Map(orders.map((o) => [o.id, o.date]));
        const inDays = (iso: string, fromDay: string, toDay: string) => iso >= isoOf(etMidnightUtc(fromDay)) && iso < isoOf(etMidnightUtc(toDay));

        let stock: Map<string, number> | null = null;
        if (keys.has("oos_loss")) {
          const { data: inv, error } = await admin.from("product_inventory").select("sku, available").eq("market", src.stock);
          if (error) throw error;
          stock = new Map((inv ?? []).map((r) => [r.sku, Number(r.available) || 0]));
        }
        let pushes: { entity_id: string; occurred_at: string; metadata: Record<string, unknown> | null }[] = [];
        if (keys.has("listings_updated")) {
          const { data, error } = await admin
            .from("audit_log")
            .select("entity_id, occurred_at, metadata")
            .eq("action", "push").eq("entity_type", "product").eq("target", "wix")
            .gte("occurred_at", isoOf(etMidnightUtc(addDays(oldest, -7))))
            .lt("occurred_at", isoOf(etMidnightUtc(thisColumn)))
            .limit(5000);
          if (error) throw error;
          const onSite = (md: Record<string, unknown> | null) => {
            if (!md) return false;
            if (src.wixSites.includes(String(md.site ?? ""))) return true;
            const results = md.results as Record<string, { ok?: boolean }> | undefined;
            return Boolean(results && src.wixSites.some((s) => results[s]?.ok));
          };
          pushes = (data ?? []).filter((p) => p.entity_id && onSite(p.metadata as Record<string, unknown> | null));
        }

        for (const column of columns) {
          const from = addDays(column, -7); // the data week: the 7 days before the column's Sunday
          const week = orders.filter((o) => inDays(o.date, from, column));
          const sold = week.filter((o) => o.state !== "cancel");
          const soldIds = new Set(sold.map((o) => o.id));
          const linesIn = (a: string, b: string) => lines.filter((l) => { const d = orderDate.get(l.orderId); return d != null && inDays(d, a, b); });
          const value: Record<string, number | null> = {};
          value.sales = Math.round(sold.reduce((s, o) => s + o.untaxed, 0) * 100) / 100;
          value.orders = sold.length;
          value.units = lines.filter((l) => soldIds.has(l.orderId) && l.sku).reduce((s, l) => s + l.qty, 0);
          value.cancel_rate = week.length ? Math.round((week.filter((o) => o.state === "cancel").length / week.length) * 10000) / 10000 : null;
          if (keys.has("skus_not_sold_90d")) {
            const soldSkus = new Set(linesIn(addDays(column, -90), column).filter((l) => l.qty > 0 && l.sku).map((l) => l.sku));
            value.skus_not_sold_90d = live.filter((p) => !soldSkus.has(p.sku)).length;
          }
          if (keys.has("listings_updated")) {
            value.listings_updated = new Set(pushes.filter((p) => p.occurred_at >= isoOf(etMidnightUtc(from)) && p.occurred_at < isoOf(etMidnightUtc(column))).map((p) => p.entity_id)).size;
          }
          if (column === thisColumn) {
            value.obsolete_skus = live.filter((p) => p.is_obsolete).length;
            if (stock) {
              // Products at 0 units now that sold in the 8 weeks before the
              // data week: their average weekly sales is what the store loses.
              const before = linesIn(addDays(from, -56), from);
              let loss = 0;
              for (const [sku, avail] of stock) {
                if (avail > 0) continue;
                loss += before.filter((l) => l.sku === sku).reduce((s, l) => s + l.subtotal, 0) / 8;
              }
              value.oos_loss = Math.round(loss * 100) / 100;
            }
          }
          for (const m of rows) {
            if (column !== thisColumn && SNAPSHOT_KEYS.has(m.auto_key)) continue;
            if (!(m.auto_key in value)) continue;
            out.push({ metricId: m.id, board, market, name: m.name, key: m.auto_key, week: column, value: value[m.auto_key] });
          }
        }
      }
    }

    let written = 0;
    if (mode === "fill") {
      const now = out.filter((v) => v.week === thisColumn && v.value != null).map((v) => ({ metric_id: v.metricId, week_start: v.week, value: v.value, note: null, origin: "auto" }));
      const past = out.filter((v) => v.week !== thisColumn && v.value != null).map((v) => ({ metric_id: v.metricId, week_start: v.week, value: v.value, note: null, origin: "auto" }));
      if (now.length) {
        const { error } = await admin.from("scorecard_values").upsert(now, { onConflict: "metric_id,week_start" });
        if (error) throw error;
      }
      if (past.length) {
        // Past weeks only where nothing is stored yet.
        const { error } = await admin.from("scorecard_values").upsert(past, { onConflict: "metric_id,week_start", ignoreDuplicates: true });
        if (error) throw error;
      }
      written = now.length + past.length;
      await admin.from("app_settings").upsert({ key: SETTINGS_KEY, value: { at: new Date().toISOString(), ok: true, boards, column: thisColumn, backfill, values: written } }, { onConflict: "key" });
    }
    return json({ ok: true, mode, column: thisColumn, dataWeek: [addDays(thisColumn, -7), addDays(thisColumn, -1)], backfill, written, values: out });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin.from("app_settings").upsert({ key: SETTINGS_KEY, value: { at: new Date().toISOString(), ok: false, error: message } }, { onConflict: "key" });
    return json({ error: message }, 500);
  }
});
