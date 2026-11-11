// Stylish PIM ← Odoo stock: READ-ONLY pull into product_inventory. Nothing
// here writes to Odoo.
//
// Both markets come from Odoo's "Calculated Inventory" (Inventory →
// Reporting), column "Available for Use" = Free to Use (Finished) + Max
// Buildable Qty from components — product.product's computed fields
// available_for_use / finished_free_qty / max_buildable_qty (Odoo's
// replenishment_report module) — read with ONE warehouse selected per market
// (user, 2026-11-10: "el inventario debe venir de acá, de la columna llamada
// Available for Use"; the warehouses are the user's choice the same day: what
// can really be shipped, so no Amazon FBA, Irene / Elina / Bonnie or Open Box
// stock):
//   ca  warehouse CBG (Cambridge), Stylish International Inc
//   us  warehouse ATL (Flowery Branch GA), Stylish USA Inc
// The screen's warehouse filter is the context key `warehouse_id` (Odoo's
// own StockReportSearchModel), which is what this sends; the numbers are the
// screen's with that warehouse picked. Until that day the USA came from
// ShipStation Inventory and Canada from the "Stylish Inventory" Excel (daily
// email / Settings upload): both are gone.
//
// `eta` (user, 2026-11-11: "llega el…"): the next date Odoo expects units of the
// product, from the open purchase order lines of the market's company (ordered,
// not received yet); `warehouses[code]` keeps `on_order`, `expected` and `late`
// (the date is already past). Nothing on order → no date.
//
// One row per PIM product Odoo has: `available` = Available for Use (whole
// units, never below 0), `on_hand` = Quantity On Hand, `warehouses` =
// { "<code>": { on_hand, available, free, buildable, incoming } }. A PIM
// product Odoo does not have (no record, or an archived one) has NO row —
// "not tracked", which is not 0 — and is listed in the report's `notInOdoo`.
//
// Matching: the PIM's SKU = Odoo's default_code, exact, then ignoring case —
// the DASH is kept (dashed and undashed SKUs are DIFFERENT brands here). Two
// Odoo records of one SKU are added up.
//
// Guards: Odoo answering with no product, or with under half of the products
// the market holds now, changes nothing — the last numbers stay.
//
// Body: { mode?: "pull" | "ping", market?: "us" | "ca" | "all", dryRun?: boolean }
//   (defaults: pull, all). dryRun reads and matches but writes nothing.
//   Each market's outcome is reported under `markets`; one failing does not
//   stop the other. The last report is saved in app_settings
//   'shipstation_inventory' (the key kept its first name) for Settings.
//
// Auth: `x-cron-secret` header matching CRON_SECRET (deployed with verify_jwt
// off so pg_net can call it), a service-role bearer (proven through GoTrue's
// admin API, not by matching the runtime's copy), or a signed-in session.
// The mailbox script that used to forward the Canada workbook
// (`x-inventory-secret`) is answered "no longer read" and changes nothing.
// Secrets: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret, x-inventory-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const SOURCE = "Odoo";
const FIELD = "Available for Use";
// The warehouse each market's stock is read from (Odoo's warehouse code).
const MARKETS: Record<string, { label: string; warehouse: string }> = {
  ca: { label: "Canada", warehouse: "CBG" },
  us: { label: "USA", warehouse: "ATL" },
};
const NO_FILE = "The stock now comes from Odoo (Calculated Inventory, Available for Use): the Canada inventory file is no longer read.";

type Client = ReturnType<typeof createClient>;
type Report = Record<string, unknown> & { ok: boolean; market: string; label: string; place: string };
type Warehouse = { id: number; code: string; name: string; company: string; companyId: number };
type OdooRow = { id: number; default_code: string; qty_available: number; finished_free_qty: number; max_buildable_qty: number; available_for_use: number; incoming_qty: number };
type Stock = { on_hand: number; free: number; buildable: number; available: number; incoming: number; spellings: string[]; ids: number[] };
// What is on order for a product: the units not received yet and the next date Odoo expects them.
type OnOrder = { qty: number; date: string; late: boolean };

// The role claim of a JWT, read without a signature check — it only picks
// which real check to run on the bearer.
function claimRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(b64)).role ?? null;
  } catch {
    return null;
  }
}

// ================================= Odoo ===================================

type Odoo = (model: string, method: string, args: unknown[], kwargs?: Record<string, unknown>) => Promise<any>;
async function odooClient(): Promise<Odoo> {
  const url = (Deno.env.get("ODOO_URL") ?? "").replace(/\/$/, "");
  const db = Deno.env.get("ODOO_DB");
  const user = Deno.env.get("ODOO_USER");
  const key = Deno.env.get("ODOO_API_KEY");
  if (!url || !db || !user || !key) throw new Error("The ODOO_URL / ODOO_DB / ODOO_USER / ODOO_API_KEY secrets are not set.");
  let id = 0;
  // A request that does not get through (Odoo refuses some under load) is
  // sent again after a growing, random pause; an answer from Odoo itself (an
  // error it gives) is never retried.
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

// The markets' warehouses by code. Odoo keeps an archived twin of CBG under
// the other company: only the active one counts, and two active ones with
// one code would be a wrong guess, so that fails.
async function findWarehouses(odoo: Odoo): Promise<Record<string, Warehouse>> {
  const codes = [...new Set(Object.values(MARKETS).map((m) => m.warehouse))];
  const rows = await odoo("stock.warehouse", "search_read", [[["code", "in", codes]]], { fields: ["id", "code", "name", "company_id"] }) as
    { id: number; code: string; name: string; company_id: [number, string] }[];
  const out: Record<string, Warehouse> = {};
  for (const code of codes) {
    const found = rows.filter((r) => r.code === code);
    if (found.length === 0) throw new Error(`Odoo has no active warehouse with the code ${code}.`);
    if (found.length > 1) throw new Error(`Odoo has ${found.length} active warehouses with the code ${code}.`);
    out[code] = { id: found[0].id, code, name: found[0].name, company: found[0].company_id[1], companyId: found[0].company_id[0] };
  }
  return out;
}

const STOCK_FIELDS = ["default_code", "qty_available", "finished_free_qty", "max_buildable_qty", "available_for_use", "incoming_qty"];
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Odoo's numbers for the PIM's SKUs with one warehouse selected — what the
// Calculated Inventory screen shows with that warehouse picked on its left
// panel. Every company of both warehouses is allowed, as on that screen: a
// product of one company only reads 0 in the other's warehouse.
async function readStock(odoo: Odoo, warehouse: Warehouse, companies: number[], skus: string[]): Promise<Map<string, Stock>> {
  const context = { warehouse_id: warehouse.id, allowed_company_ids: companies };
  const byUpper = new Map<string, string>();
  for (const sku of skus) if (!byUpper.has(sku.toUpperCase())) byUpper.set(sku.toUpperCase(), sku);
  const stock = new Map<string, Stock>();
  const add = (sku: string, r: OdooRow) => {
    const s = stock.get(sku) ?? { on_hand: 0, free: 0, buildable: 0, available: 0, incoming: 0, spellings: [], ids: [] };
    s.on_hand += num(r.qty_available);
    s.free += num(r.finished_free_qty);
    s.buildable += num(r.max_buildable_qty);
    s.available += num(r.available_for_use);
    s.incoming += num(r.incoming_qty);
    s.spellings.push(String(r.default_code));
    s.ids.push(r.id);
    stock.set(sku, s);
  };
  const exact = new Set(skus);
  for (let i = 0; i < skus.length; i += 200) {
    const rows = await odoo("product.product", "search_read", [[["default_code", "in", skus.slice(i, i + 200)]]], { fields: STOCK_FIELDS, context }) as OdooRow[];
    for (const r of rows) if (exact.has(r.default_code)) add(r.default_code, r);
  }
  // What the exact spelling did not find, once more ignoring case.
  const missing = skus.filter((s) => !stock.has(s));
  for (let i = 0; i < missing.length; i += 40) {
    const part = missing.slice(i, i + 40);
    const domain: unknown[] = [...Array(part.length - 1).fill("|"), ...part.map((s) => ["default_code", "=ilike", likeEscape(s)])];
    const rows = await odoo("product.product", "search_read", [domain], { fields: STOCK_FIELDS, context }) as OdooRow[];
    for (const r of rows) {
      const sku = byUpper.get(String(r.default_code ?? "").toUpperCase());
      if (sku && missing.includes(sku)) add(sku, r);
    }
  }
  return stock;
}

// What is on order for the market (user, 2026-11-11: "llega el…"): the open
// purchase order lines of the market's company — units ordered and not
// received yet — and the next date Odoo expects them (the line's Expected
// Arrival). The orders land in the vendors' own warehouses of that country
// (Irene-CAN, Elina-USA…), not in CBG / ATL, so the date is when the purchase
// is expected, not when the units can be sold. A date already past means the
// order is late in Odoo: the latest of those is kept and marked late.
async function readOnOrder(odoo: Odoo, companyId: number, companies: number[], stock: Map<string, Stock>): Promise<Map<string, OnOrder>> {
  const skuOf = new Map<number, string>();
  for (const [sku, s] of stock) for (const id of s.ids) skuOf.set(id, sku);
  const lines = await odoo("purchase.order.line", "search_read", [[["order_id.state", "=", "purchase"], ["order_id.company_id", "=", companyId], ["product_id", "in", [...skuOf.keys()]]]],
    { fields: ["product_id", "product_qty", "qty_received", "date_planned"], limit: 20000, context: { allowed_company_ids: companies } }) as { product_id: [number, string]; product_qty: number; qty_received: number; date_planned: string | false }[];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
  const open = new Map<string, { qty: number; dates: string[] }>();
  for (const l of lines) {
    const left = num(l.product_qty) - num(l.qty_received);
    const sku = skuOf.get(l.product_id?.[0]);
    if (!sku || left <= 0) continue;
    const o = open.get(sku) ?? { qty: 0, dates: [] };
    o.qty += left;
    if (l.date_planned) o.dates.push(String(l.date_planned).slice(0, 10));
    open.set(sku, o);
  }
  const out = new Map<string, OnOrder>();
  for (const [sku, o] of open) {
    if (!o.dates.length) continue;
    const dates = [...o.dates].sort();
    const next = dates.find((d) => d >= today);
    out.set(sku, { qty: Math.round(o.qty), date: next ?? dates[dates.length - 1], late: !next });
  }
  return out;
}

async function pullMarket(market: string, odoo: Odoo, warehouse: Warehouse, companies: number[], skus: string[], supabase: Client, dryRun: boolean): Promise<Report> {
  const base = {
    market, label: MARKETS[market].label, place: `Odoo warehouse ${warehouse.code}`, source: SOURCE,
    warehouse: warehouse.code, warehouseName: warehouse.name, company: warehouse.company, field: FIELD,
  };
  const syncedAt = new Date().toISOString();
  const stock = await readStock(odoo, warehouse, companies, skus);
  if (stock.size === 0) return { ok: false, ...base, error: `Odoo returned none of the PIM's products for the warehouse ${warehouse.code}; nothing changed.` };

  // The purchase orders are an extra: when they cannot be read the stock
  // still goes in, without dates.
  let onOrder = new Map<string, OnOrder>();
  let onOrderError: string | null = null;
  try {
    onOrder = await readOnOrder(odoo, warehouse.companyId, companies, stock);
  } catch (err) {
    onOrderError = (err as Error).message;
  }

  const upserts = [...stock].map(([sku, s]) => {
    // Whole units that can be sold: never a fraction, never below 0.
    const available = Math.max(0, Math.floor(s.available + 1e-9));
    const onHand = Math.round(s.on_hand);
    const coming = onOrder.get(sku) ?? null;
    return {
      market, sku, on_hand: onHand, available,
      warehouses: { [warehouse.code]: { on_hand: onHand, available, free: Math.round(s.free), buildable: Math.round(s.buildable), incoming: Math.round(s.incoming), ...(coming ? { on_order: coming.qty, expected: coming.date, late: coming.late } : {}) } },
      source: "odoo", source_sku: s.spellings.join(", "), eta: coming?.date ?? null, dropped_at: null, synced_at: syncedAt,
    };
  });
  const summary = {
    matched: upserts.length,
    inStock: upserts.filter((u) => u.available > 0).length,
    outOfStock: upserts.filter((u) => u.available <= 0).length,
    units: upserts.reduce((a, u) => a + u.available, 0),
    notInOdoo: skus.filter((s) => !stock.has(s)).sort(),
    duplicates: [...stock].filter(([, s]) => s.spellings.length > 1).map(([sku]) => sku).sort(),
    onOrder: onOrder.size,
    onOrderLate: [...onOrder.values()].filter((o) => o.late).length,
    ...(onOrderError ? { onOrderError } : {}),
    syncedAt,
  };

  // Odoo answering with far fewer products than the market holds is a
  // broken answer (a lost permission, a half read), not a real change.
  const { count, error: cErr } = await supabase.from("product_inventory").select("sku", { count: "exact", head: true }).eq("market", market);
  if (cErr) return { ok: false, ...base, step: "count", error: cErr.message };
  if (count && upserts.length < count / 2) {
    return { ok: false, ...base, ...summary, error: `Odoo returned only ${upserts.length} of the ${count} products tracked in ${base.label}; nothing changed.` };
  }
  if (dryRun) return { ok: true, ...base, dryRun: true, ...summary, removed: 0, sample: upserts.slice(0, 5) };

  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await supabase.from("product_inventory").upsert(upserts.slice(i, i + 500), { onConflict: "market,sku" });
    if (error) return { ok: false, ...base, step: "upsert", error: error.message };
  }
  // A product Odoo no longer has is not tracked: its row goes.
  const { data: gone, error: gErr } = await supabase.from("product_inventory").select("sku").eq("market", market).lt("synced_at", syncedAt);
  if (gErr) return { ok: false, ...base, step: "gone", error: gErr.message };
  if (gone?.length) {
    const { error } = await supabase.from("product_inventory").delete().eq("market", market).in("sku", gone.map((g) => g.sku));
    if (error) return { ok: false, ...base, step: "delete", error: error.message };
  }
  return { ok: true, ...base, ...summary, removed: gone?.length ?? 0 };
}

// ================================ handler =================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // The mailbox script still forwards the daily Canada workbook until its
    // trigger is switched off: it is told the file is not read (as a success,
    // so the script does not mail a failure every day) and nothing changes.
    const inboundSecret = Deno.env.get("INVENTORY_INBOUND_SECRET");
    if (inboundSecret && req.headers.get("x-inventory-secret") === inboundSecret) {
      return json({ ok: true, ignored: true, note: NO_FILE, markets: { ca: { ok: true, market: "ca", label: "Canada", place: "Odoo warehouse CBG", source: SOURCE, ignored: true, note: NO_FILE } } });
    }

    // --- caller: cron secret, service role, or a signed-in user -------------
    const cronSecret = Deno.env.get("CRON_SECRET");
    const provided = req.headers.get("x-cron-secret");
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    let authorized = Boolean(cronSecret && provided === cronSecret) || bearer === SERVICE_ROLE;
    let detail: string | null = null;
    if (!authorized && bearer) {
      if (claimRole(bearer) === "service_role" || bearer.startsWith("sb_secret_")) {
        // A service-role key is proven by what it can do (GoTrue's admin
        // listing needs one), not by matching the runtime's own copy — that
        // copy is not always the key the .env files carry.
        const { error } = await createClient(SUPABASE_URL, bearer).auth.admin.listUsers({ page: 1, perPage: 1 });
        authorized = !error;
        detail = error?.message ?? null;
      } else {
        const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
        const { data: { user }, error } = await callerClient.auth.getUser();
        authorized = Boolean(user);
        detail = error?.message ?? null;
      }
    }
    if (!authorized) return json({ error: "unauthorized", ...(detail ? { detail } : {}) }, 401);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const mode = String(body.mode ?? "pull");
    const which = String(body.market ?? "all");
    const dryRun = body.dryRun === true;
    const markets = which === "all" ? Object.keys(MARKETS) : [which];
    if (markets.some((m) => !MARKETS[m])) return json({ error: `unknown market "${which}" (use us, ca or all)` }, 400);
    // An upload from a page opened before this change.
    if (typeof body.file === "string" && body.file.length > 0) {
      return json({ ok: false, error: NO_FILE, markets: { ca: { ok: false, market: "ca", label: "Canada", place: "Odoo warehouse CBG", error: NO_FILE } } });
    }
    if (mode !== "pull" && mode !== "ping") return json({ error: `unknown mode "${mode}" (use pull or ping)` }, 400);

    // Odoo not answering (or a warehouse gone) fails every market asked for,
    // with the reason in the saved report; the last numbers stay.
    let odoo: Odoo | null = null;
    let warehouses: Record<string, Warehouse> = {};
    let companies: number[] = [];
    let down: string | null = null;
    try {
      odoo = await odooClient();
      warehouses = await findWarehouses(odoo);
      companies = [...new Set(Object.values(warehouses).map((w) => w.companyId))];
    } catch (err) {
      down = (err as Error).message;
    }
    const failed = (m: string, error: string): Report => ({ ok: false, market: m, label: MARKETS[m].label, place: `Odoo warehouse ${MARKETS[m].warehouse}`, source: SOURCE, error });

    if (mode === "ping") {
      const out: Record<string, unknown> = {};
      for (const m of markets) {
        const w = warehouses[MARKETS[m].warehouse];
        out[m] = down || !w ? failed(m, down ?? "warehouse not found") : { ok: true, label: MARKETS[m].label, source: SOURCE, field: FIELD, warehouse: w.code, warehouseName: w.name, company: w.company };
      }
      return json({ ok: !down, ...(down ? { error: down } : {}), markets: out });
    }

    // --- the PIM's SKUs, read once for every market --------------------------
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const skus: string[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from("products").select("sku").order("sku").range(from, from + 999);
      if (error) return json({ ok: false, step: "products", error: error.message }, 500);
      for (const p of data ?? []) skus.push(String(p.sku));
      if ((data ?? []).length < 1000) break;
    }
    if (skus.length === 0) return json({ ok: false, step: "products", error: "The PIM has no products." }, 500);

    const reports: Record<string, Report> = {};
    for (const m of markets) {
      if (down || !odoo) { reports[m] = failed(m, down ?? "Odoo is not reachable."); continue; }
      try {
        reports[m] = await pullMarket(m, odoo, warehouses[MARKETS[m].warehouse], companies, skus, supabase, dryRun);
      } catch (err) {
        reports[m] = failed(m, (err as Error).message);
      }
    }

    const syncedAt = new Date().toISOString();
    const failures = Object.values(reports).filter((r) => !r.ok);
    let reportSaved = false;
    if (!dryRun) {
      // Merge into the last report so a one-market pull keeps the other
      // market's latest outcome. Not fatal if it cannot be written.
      const { data: prev } = await supabase.from("app_settings").select("value").eq("key", "shipstation_inventory").maybeSingle();
      const prevMarkets = ((prev?.value as { markets?: Record<string, Report> } | null)?.markets) ?? {};
      const { error: reportErr } = await supabase
        .from("app_settings")
        .upsert({ key: "shipstation_inventory", value: { syncedAt, markets: { ...prevMarkets, ...reports } }, updated_at: syncedAt }, { onConflict: "key" });
      reportSaved = !reportErr;
    }

    return json({
      ok: failures.length === 0,
      ...(failures.length ? { error: failures.map((r) => `${r.label}: ${r.error}`).join(" · ") } : {}),
      dryRun,
      syncedAt,
      markets: reports,
      reportSaved,
    });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
