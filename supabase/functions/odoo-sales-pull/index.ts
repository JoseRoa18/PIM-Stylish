// Stylish PIM ← Odoo sales: READ-ONLY pull into product_sales. Nothing here
// writes to Odoo, and nothing here touches a product's own data.
//
// User, 2026-11-11: "Ventas por SKU y marketplace: unidades de 30 y 90 días en
// la página del producto, y días de inventario (stock entre ventas), para
// elegir qué meter en promoción" — "SI".
//
// What it reads: Odoo's confirmed sales order lines (order in state sale /
// done) of the last 90 days for the PIM's SKUs, sold WITH A PRICE — a line at
// $0 is a spare part, a warranty replacement or an open box sent free, not a
// sale (the EOS ScoreCard's rule) — and not the orders Odoo files under
// Warranty Claim / Missing Items / Correct Items / Wrong Items.
//
// One row per market and SKU that sold: `units_30`, `units_90`, and
// `channels` = { "<marketplace>": { u30, u90 } }. The market is the order's
// company (Stylish International = Canada, Stylish USA = USA — the companies
// of the CBG and ATL warehouses the stock is read from); the marketplace is
// the order's own (marketplace.master), a Wix order named by its store.
// A product that sold nothing in 90 days has no row.
//
// Matching: the PIM's SKU = Odoo's default_code, exact, then ignoring case —
// the DASH is kept. A kit sells as the kit: its components are not counted.
//
// Body: { dryRun?: boolean }. The last run's report is app_settings
// 'odoo_sales'. Cron: odoo-sales-pull (every 3 hours).
// Auth: `x-cron-secret`, a service-role bearer (proven through GoTrue's admin
// API) or a signed-in session. Deployed with verify_jwt off.
// Secrets: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY, CRON_SECRET.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const DAYS = 90;
const RECENT = 30;
// The warehouse whose company is each market (the stock's own).
const MARKET_WAREHOUSE: Record<string, string> = { ca: "CBG", us: "ATL" };
// Orders that are not sales.
const NOT_A_SALE = /warranty|missing items|correct items|wrong items/i;

function claimRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(b64)).role ?? null;
  } catch {
    return null;
  }
}

type Odoo = (model: string, method: string, args: unknown[], kwargs?: Record<string, unknown>) => Promise<any>;
async function odooClient(): Promise<Odoo> {
  const url = (Deno.env.get("ODOO_URL") ?? "").replace(/\/$/, "");
  const db = Deno.env.get("ODOO_DB");
  const user = Deno.env.get("ODOO_USER");
  const key = Deno.env.get("ODOO_API_KEY");
  if (!url || !db || !user || !key) throw new Error("The ODOO_URL / ODOO_DB / ODOO_USER / ODOO_API_KEY secrets are not set.");
  let id = 0;
  const rpc = async (service: string, method: string, args: unknown[]) => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: ++id });
    for (let attempt = 1; ; attempt++) {
      let j: { error?: { message?: string; data?: { message?: string } }; result?: unknown };
      try {
        const r = await fetch(`${url}/jsonrpc`, { method: "POST", headers: { "content-type": "application/json" }, body });
        if (r.status === 429 || r.status >= 500) throw new Error(`Odoo answered ${r.status}`);
        j = await r.json();
      } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((ok) => setTimeout(ok, 600 * 2 ** (attempt - 1) + Math.random() * 500));
        continue;
      }
      if (j.error) throw new Error(`Odoo: ${j.error.data?.message ?? j.error.message}`);
      return j.result;
    }
  };
  const uid = await rpc("common", "authenticate", [db, user, key, {}]);
  if (!uid) throw new Error("Odoo refused the PIM's login (ODOO_USER / ODOO_API_KEY).");
  return (model, method, args, kwargs = {}) => rpc("object", "execute_kw", [db, uid, key, model, method, args, kwargs]);
}

// The marketplace of an order, as the PIM shows it.
function channelOf(order: { marketplace_name: [number, string] | false; wix_site_name: string | false }): string | null {
  const name = order.marketplace_name ? String(order.marketplace_name[1]).trim() : "";
  if (NOT_A_SALE.test(name)) return null;
  if (/^wix$/i.test(name) || (!name && order.wix_site_name)) {
    const site = String(order.wix_site_name || "").toLowerCase();
    if (site.includes("sinksdirect")) return "Sinks Direct";
    if (site.includes("azuni")) return "Azuni website";
    if (site.includes("stylish")) return "Stylish website";
    return "Wix";
  }
  if (!name) return "Other";
  if (/best buy/i.test(name)) return "Best Buy";
  if (/menards/i.test(name)) return "Menards";
  if (/overstock/i.test(name)) return "Overstock";
  if (/lowe/i.test(name)) return "Lowe's";
  return name;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // --- caller: cron secret, service role, or a signed-in user ---------------
    const cronSecret = Deno.env.get("CRON_SECRET");
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    let authorized = Boolean(cronSecret && req.headers.get("x-cron-secret") === cronSecret) || bearer === SERVICE_ROLE;
    if (!authorized && bearer) {
      if (claimRole(bearer) === "service_role" || bearer.startsWith("sb_secret_")) {
        const { error } = await createClient(SUPABASE_URL, bearer).auth.admin.listUsers({ page: 1, perPage: 1 });
        authorized = !error;
      } else {
        const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
        const { data: { user } } = await callerClient.auth.getUser();
        authorized = Boolean(user);
      }
    }
    if (!authorized) return json({ error: "unauthorized" }, 401);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const dryRun = body.dryRun === true;
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // --- the PIM's SKUs --------------------------------------------------------
    const skus: string[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from("products").select("sku").order("sku").range(from, from + 999);
      if (error) return json({ ok: false, step: "products", error: error.message }, 500);
      for (const p of data ?? []) skus.push(String(p.sku));
      if ((data ?? []).length < 1000) break;
    }
    if (!skus.length) return json({ ok: false, error: "The PIM has no products." }, 500);

    const odoo = await odooClient();
    const warehouses = await odoo("stock.warehouse", "search_read", [[["code", "in", Object.values(MARKET_WAREHOUSE)]]], { fields: ["code", "company_id"] }) as { code: string; company_id: [number, string] }[];
    const marketOf = new Map<number, string>();
    for (const [market, code] of Object.entries(MARKET_WAREHOUSE)) {
      const w = warehouses.filter((x) => x.code === code);
      if (w.length !== 1) throw new Error(`Odoo has ${w.length} active warehouses with the code ${code}.`);
      marketOf.set(w[0].company_id[0], market);
    }
    const context = { allowed_company_ids: [...marketOf.keys()], active_test: false };

    // --- Odoo's products for those SKUs (archived ones sold too) ---------------
    const exact = new Set(skus);
    const byUpper = new Map(skus.map((s) => [s.toUpperCase(), s]));
    const skuOf = new Map<number, string>();
    for (let i = 0; i < skus.length; i += 200) {
      const rows = await odoo("product.product", "search_read", [[["default_code", "in", skus.slice(i, i + 200)]]], { fields: ["default_code"], context }) as { id: number; default_code: string }[];
      for (const r of rows) {
        const code = String(r.default_code).trim();
        const sku = exact.has(code) ? code : byUpper.get(code.toUpperCase());
        if (sku) skuOf.set(r.id, sku);
      }
    }
    if (!skuOf.size) return json({ ok: false, error: "Odoo returned none of the PIM's products; nothing changed." });

    // --- the sales lines of the last 90 days, with a price ---------------------
    const now = Date.now();
    const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    const since = stamp(now - DAYS * 86400000);
    const recent = stamp(now - RECENT * 86400000);
    const domain = [["product_id", "in", [...skuOf.keys()]], ["order_id.date_order", ">=", since], ["order_id.state", "in", ["sale", "done"]], ["price_unit", ">", 0]];
    type Line = { product_id: [number, string]; product_uom_qty: number; order_id: [number, string] };
    const lines: Line[] = [];
    for (let offset = 0; offset < 200000; offset += 2000) {
      const page = await odoo("sale.order.line", "search_read", [domain], { fields: ["product_id", "product_uom_qty", "order_id"], limit: 2000, offset, order: "id", context }) as Line[];
      lines.push(...page);
      if (page.length < 2000) break;
    }
    type Order = { id: number; date_order: string; marketplace_name: [number, string] | false; wix_site_name: string | false; company_id: [number, string] | false };
    const orders = new Map<number, Order>();
    const orderIds = [...new Set(lines.map((l) => l.order_id[0]))];
    for (let i = 0; i < orderIds.length; i += 500) {
      const rows = await odoo("sale.order", "read", [orderIds.slice(i, i + 500), ["date_order", "marketplace_name", "wix_site_name", "company_id"]], { context }) as Order[];
      for (const o of rows) orders.set(o.id, o);
    }

    // --- units per market, SKU and marketplace ---------------------------------
    type Row = { market: string; sku: string; units_30: number; units_90: number; channels: Record<string, { u30: number; u90: number }> };
    const rows = new Map<string, Row>();
    let skipped = 0;
    for (const l of lines) {
      const sku = skuOf.get(l.product_id?.[0]);
      const order = orders.get(l.order_id?.[0]);
      const market = order?.company_id ? marketOf.get(order.company_id[0]) : undefined;
      const channel = order ? channelOf(order) : null;
      const qty = Number(l.product_uom_qty) || 0;
      if (!sku || !order || !market || !channel || qty <= 0) { skipped += 1; continue; }
      const key = `${market}|${sku}`;
      const row = rows.get(key) ?? { market, sku, units_30: 0, units_90: 0, channels: {} };
      const c = row.channels[channel] ?? { u30: 0, u90: 0 };
      const isRecent = order.date_order >= recent;
      row.units_90 += qty; c.u90 += qty;
      if (isRecent) { row.units_30 += qty; c.u30 += qty; }
      row.channels[channel] = c;
      rows.set(key, row);
    }
    const syncedAt = new Date().toISOString();
    const round = (n: number) => Math.round(n * 100) / 100;
    const upserts = [...rows.values()].map((r) => ({
      market: r.market, sku: r.sku, units_30: round(r.units_30), units_90: round(r.units_90),
      channels: Object.fromEntries(Object.entries(r.channels).map(([k, v]) => [k, { u30: round(v.u30), u90: round(v.u90) }])),
      synced_at: syncedAt,
    }));
    const report = {
      ok: true, syncedAt, since, lines: lines.length, orders: orders.size, skipped,
      rows: upserts.length,
      markets: Object.fromEntries([...marketOf.values()].map((m) => [m, { products: upserts.filter((u) => u.market === m).length, units_90: round(upserts.filter((u) => u.market === m).reduce((a, u) => a + u.units_90, 0)) }])),
    };
    // Far fewer lines than a quarter of sales is a broken answer, not a real change.
    if (!lines.length) return json({ ...report, ok: false, error: "Odoo returned no sales lines; nothing changed." });
    if (dryRun) return json({ ...report, dryRun: true, sample: upserts.slice(0, 5) });

    for (let i = 0; i < upserts.length; i += 500) {
      const { error } = await supabase.from("product_sales").upsert(upserts.slice(i, i + 500), { onConflict: "market,sku" });
      if (error) return json({ ok: false, step: "upsert", error: error.message }, 500);
    }
    // A product that sold nothing in the window has no row.
    const { error: dErr } = await supabase.from("product_sales").delete().lt("synced_at", syncedAt);
    if (dErr) return json({ ok: false, step: "delete", error: dErr.message }, 500);
    await supabase.from("app_settings").upsert({ key: "odoo_sales", value: report, updated_at: syncedAt }, { onConflict: "key" });
    return json(report);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
