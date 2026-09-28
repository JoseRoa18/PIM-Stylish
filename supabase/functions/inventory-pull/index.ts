// Stylish PIM ← warehouse stock: READ-ONLY pull into product_inventory, one
// source per market. Nothing here writes to the sources.
//
//   us  ShipStation Inventory (API v2), secret SHIPSTATION_API_KEY: every
//       warehouse of the USA account (Flowery Branch GA + a 2-SKU "Walmart"
//       one; Amazon FBA is empty). ShipStation's list omits SKUs at 0 stock,
//       so a SKU we already track that is missing from a pull is kept at 0
//       with dropped_at stamped (most likely sold out), never deleted.
//   ca  The "Stylish Inventory" Excel on SharePoint: columns PART NUMBER,
//       NAME, QUANTITY IN STOCK CANADA and ETA CAN, found by header text on
//       whichever sheet carries them. The file lists its zeros itself, so a
//       SKU that is not in the file is not tracked — its row is removed.
//       The workbook comes from, in this order:
//         · the request body (`file`, base64): the Settings upload, or the
//           mailbox script (scripts/gmail-inventory-to-pim.gs) forwarding the
//           daily email with the INVENTORY_INBOUND_SECRET header,
//         · Microsoft Graph, when MS_TENANT_ID / MS_CLIENT_ID /
//           MS_CLIENT_SECRET are set: the share link CA_INVENTORY_XLSX_URL is
//           resolved through /shares (an app registration with
//           Files.Read.All or Sites.Selected on the site),
//         · a plain download of CA_INVENTORY_XLSX_URL when the link is an
//           "anyone with the link" one.
//
// Body: { mode?: "pull" | "ping", market?: "us" | "ca" | "all",
//         file?: string (base64 xlsx, Canada only), dryRun?: boolean }
//   (defaults: pull, all). dryRun parses and matches but writes nothing.
//   Each market's outcome is reported under `markets`; one failing does not
//   stop the other. The last report is saved in app_settings
//   'shipstation_inventory' for the Dashboard and Settings.
//
// Matching: exact SKU, then case-insensitive — the DASH is kept (dashed and
// undashed SKUs are DIFFERENT brands here). A SKU never seen stays absent
// ("not tracked"), which is not 0.
//
// Auth: `x-cron-secret` header matching CRON_SECRET (deployed with verify_jwt
// off so pg_net can call it), a service-role bearer (proven through GoTrue's
// admin API, not by matching the runtime's copy), or a signed-in session.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret, x-inventory-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const SS_BASE = "https://api.shipstation.com/v2";
const SS_US = { secret: "SHIPSTATION_API_KEY" };
const EXCEL_SOURCE = "Stylish Inventory (SharePoint)";
const MARKET_LABEL: Record<string, string> = { us: "USA", ca: "Canada" };
// Where a market's SKUs live, for the Dashboard wording.
const MARKET_PLACE: Record<string, string> = { us: "USA warehouse", ca: "Canada inventory file" };

type Client = ReturnType<typeof createClient>;
type ProductIndex = { exact: Set<string>; byUpper: Map<string, string> };
type Report = Record<string, unknown> & { ok: boolean; market: string; label: string; place: string };
type Bucket = { on_hand: number; available: number };

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

function matchSku(products: ProductIndex, source: string): string | null {
  return products.exact.has(source) ? source : products.byUpper.get(source.toUpperCase()) ?? null;
}

// ============================ USA: ShipStation ============================

type Warehouse = { inventory_warehouse_id: string; name: string };
type InventoryRow = { sku: string; on_hand?: number; available?: number; inventory_warehouse_id?: string };

// Follows the cursor links (absolute URLs) until the last page; one retry
// on 429 honouring Retry-After.
async function ssAll<T>(firstPath: string, key: string, field: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = `${SS_BASE}${firstPath}`;
  let retried = false;
  let guard = 0;
  while (url && guard++ < 500) {
    const r = await fetch(url, { headers: { "API-Key": key, Accept: "application/json" } });
    if (r.status === 429 && !retried) {
      retried = true;
      const wait = Number(r.headers.get("Retry-After") ?? "2");
      await new Promise((res) => setTimeout(res, Math.min(Math.max(wait, 1), 30) * 1000));
      continue;
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`ShipStation ${r.status}: ${text.slice(0, 300)}`);
    const page = JSON.parse(text);
    out.push(...((page[field] ?? []) as T[]));
    url = page.links?.next?.href || null;
  }
  return out;
}

async function pullShipStationUs(key: string, supabase: Client, products: ProductIndex, dryRun: boolean): Promise<Report> {
  const market = "us";
  const base = { market, label: MARKET_LABEL[market], place: MARKET_PLACE[market], source: "ShipStation" };
  const syncedAt = new Date().toISOString();
  const warehouses = await ssAll<Warehouse>("/inventory_warehouses?page_size=100", key, "inventory_warehouses");
  const warehouseName = new Map(warehouses.map((w) => [w.inventory_warehouse_id, w.name]));

  // --- one row per (sku, warehouse), summed per SKU ------------------------
  const rows = await ssAll<InventoryRow>("/inventory?group_by=warehouse&page_size=250", key, "inventory");
  const bySource = new Map<string, Bucket & { warehouses: Record<string, Bucket> }>();
  for (const r of rows) {
    const sku = String(r.sku ?? "").trim();
    if (!sku) continue;
    const onHand = Number(r.on_hand ?? 0) || 0;
    const available = Number(r.available ?? 0) || 0;
    const agg = bySource.get(sku) ?? { on_hand: 0, available: 0, warehouses: {} };
    agg.on_hand += onHand;
    agg.available += available;
    const wh = warehouseName.get(r.inventory_warehouse_id ?? "") ?? r.inventory_warehouse_id ?? "unknown";
    const w = agg.warehouses[wh] ?? { on_hand: 0, available: 0 };
    w.on_hand += onHand;
    w.available += available;
    agg.warehouses[wh] = w;
    bySource.set(sku, agg);
  }
  if (bySource.size === 0) return { ok: false, ...base, error: "ShipStation returned no inventory rows; nothing changed." };

  // --- match to PIM SKUs ---------------------------------------------------
  const matched = new Map<string, Record<string, unknown>>();
  const unmatched: string[] = [];
  const ignored: string[] = [];
  for (const [sourceSku, agg] of bySource) {
    const sku = matchSku(products, sourceSku);
    if (!sku) {
      // Warehouse activity codes ("House Keeping", "Unload Pallets"…) live
      // in the same list; a SKU with a space in it is never a product.
      (/\s/.test(sourceSku) ? ignored : unmatched).push(sourceSku);
      continue;
    }
    const prev = matched.get(sku);
    if (prev) {
      // Two source spellings of one PIM SKU (A-921bk + A-921BK): add up.
      prev.on_hand = (prev.on_hand as number) + agg.on_hand;
      prev.available = (prev.available as number) + agg.available;
      prev.source_sku = `${prev.source_sku}, ${sourceSku}`;
      continue;
    }
    matched.set(sku, {
      market, sku, on_hand: agg.on_hand, available: agg.available, warehouses: agg.warehouses,
      source: "shipstation", source_sku: sourceSku, eta: null, dropped_at: null, synced_at: syncedAt,
    });
  }
  const upserts = [...matched.values()];
  const summary = {
    warehouses: warehouses.map((w) => w.name),
    tracked: bySource.size,
    matched: upserts.length,
    inStock: upserts.filter((u) => (u.available as number) > 0).length,
    unmatched: unmatched.sort(),
    ignored: ignored.sort(),
    syncedAt,
  };
  if (dryRun) return { ok: true, ...base, dryRun: true, ...summary, dropped: [], droppedTotal: 0 };

  // --- write the market's rows ---------------------------------------------
  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await supabase.from("product_inventory").upsert(upserts.slice(i, i + 500), { onConflict: "market,sku" });
    if (error) return { ok: false, ...base, step: "upsert", error: error.message };
  }
  // SKUs we track that are missing from this pull: ShipStation drops
  // sold-out SKUs from its list, so they are kept at 0 (stamped once).
  const { data: missing, error: mErr } = await supabase
    .from("product_inventory").select("sku, dropped_at").eq("market", market).lt("synced_at", syncedAt);
  if (mErr) return { ok: false, ...base, step: "missing", error: mErr.message };
  const newlyDropped = (missing ?? []).filter((m) => !m.dropped_at).map((m) => String(m.sku));
  if (missing?.length) {
    if (newlyDropped.length) {
      const { error } = await supabase.from("product_inventory").update({ dropped_at: syncedAt }).eq("market", market).in("sku", newlyDropped);
      if (error) return { ok: false, ...base, step: "dropped", error: error.message };
    }
    const { error } = await supabase
      .from("product_inventory")
      .update({ on_hand: 0, available: 0, warehouses: {}, synced_at: syncedAt })
      .eq("market", market).lt("synced_at", syncedAt);
    if (error) return { ok: false, ...base, step: "zero", error: error.message };
  }
  return { ok: true, ...base, ...summary, dropped: newlyDropped.sort(), droppedTotal: missing?.length ?? 0 };
}

// ============================ Canada: the Excel ===========================

type ExcelRow = { part: string; name: string | null; qty: number | null; eta: string | null; row: number };

const normHeader = (v: unknown) => String(v ?? "").trim().toUpperCase().replace(/\s+/g, " ");

function toQty(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.\-]/g, ""));
  return /\d/.test(s) && Number.isFinite(n) ? Math.round(n) : null;
}
function toEta(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  return s || null;
}

// The first sheet whose first 20 rows carry a "PART NUMBER" header, read by
// header text — the sheet can gain, hide or move columns.
function parseInventoryWorkbook(bytes: Uint8Array): { rows: ExcelRow[]; sheet: string; headerRow: number; columns: Record<string, string | null> } {
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });
  const col = (i: number) => (i < 0 ? null : XLSX.utils.encode_col(i));
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true }) as unknown[][];
    for (let r = 0; r < Math.min(grid.length, 20); r++) {
      const headers = (grid[r] ?? []).map(normHeader);
      const part = headers.indexOf("PART NUMBER");
      if (part < 0) continue;
      const qty = headers.findIndex((h) => /^QUANTITY IN STOCK/.test(h));
      if (qty < 0) throw new Error(`Sheet "${name}" has a PART NUMBER header on row ${r + 1} but no "QUANTITY IN STOCK…" column.`);
      const nameCol = headers.indexOf("NAME");
      const eta = headers.findIndex((h) => /^ETA\b/.test(h));
      const rows: ExcelRow[] = [];
      for (let i = r + 1; i < grid.length; i++) {
        const line = grid[i] ?? [];
        const partNo = String(line[part] ?? "").trim();
        if (!partNo) continue;
        rows.push({
          part: partNo,
          name: nameCol >= 0 && line[nameCol] != null ? String(line[nameCol]).trim() : null,
          qty: toQty(line[qty]),
          eta: eta >= 0 ? toEta(line[eta]) : null,
          row: i + 1,
        });
      }
      return { rows, sheet: name, headerRow: r + 1, columns: { part: col(part), name: col(nameCol), qty: col(qty), eta: col(eta) } };
    }
  }
  throw new Error('No sheet has a "PART NUMBER" header row.');
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchCanadaWorkbook(body: Record<string, unknown>): Promise<{ bytes: Uint8Array; via: string }> {
  if (typeof body.file === "string" && body.file.length > 0) {
    return { bytes: base64ToBytes(body.file), via: body.via === "email" ? "email" : "upload" };
  }

  const url = Deno.env.get("CA_INVENTORY_XLSX_URL");
  if (!url) {
    throw new Error("No Canada inventory source yet: upload the file in Settings, or set CA_INVENTORY_XLSX_URL (the SharePoint link) plus MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET so the PIM can read it.");
  }
  const tenant = Deno.env.get("MS_TENANT_ID");
  const clientId = Deno.env.get("MS_CLIENT_ID");
  const clientSecret = Deno.env.get("MS_CLIENT_SECRET");
  if (tenant && clientId && clientSecret) {
    const tok = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
    });
    const tj = await tok.json();
    if (!tj.access_token) throw new Error(`Microsoft sign-in failed: ${tj.error_description ?? tj.error ?? tok.status}`);
    // A sharing link becomes a Graph "shares" id: "u!" + base64url(link).
    const shareId = "u!" + btoa(url).replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
    const r = await fetch(`https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem/content`, { headers: { Authorization: `Bearer ${tj.access_token}` } });
    if (!r.ok) throw new Error(`Microsoft Graph could not download the file (${r.status}): ${(await r.text()).slice(0, 200)}`);
    return { bytes: new Uint8Array(await r.arrayBuffer()), via: "graph" };
  }
  const dl = url.includes("download=1") ? url : `${url}${url.includes("?") ? "&" : "?"}download=1`;
  const r = await fetch(dl, { redirect: "follow" });
  if (!r.ok || /text\/html/i.test(r.headers.get("content-type") ?? "")) {
    throw new Error("The Canada inventory link asks for a Microsoft sign-in (it is not an 'anyone with the link' link): set MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET so the PIM reads it through Microsoft Graph, or upload the file in Settings.");
  }
  return { bytes: new Uint8Array(await r.arrayBuffer()), via: "link" };
}

async function pullCanadaExcel(body: Record<string, unknown>, supabase: Client, products: ProductIndex, dryRun: boolean): Promise<Report> {
  const market = "ca";
  const base = { market, label: MARKET_LABEL[market], place: MARKET_PLACE[market], source: EXCEL_SOURCE };
  const syncedAt = new Date().toISOString();
  const { bytes, via } = await fetchCanadaWorkbook(body);
  const parsed = parseInventoryWorkbook(bytes);
  if (parsed.rows.length === 0) return { ok: false, ...base, via, error: `Sheet "${parsed.sheet}" has the headers on row ${parsed.headerRow} but no part numbers under them; nothing changed.` };

  const matched = new Map<string, Record<string, unknown>>();
  const unmatched: string[] = [];
  const blankQty: string[] = [];
  const duplicates: string[] = [];
  for (const r of parsed.rows) {
    const sku = matchSku(products, r.part);
    if (!sku) {
      if (!unmatched.includes(r.part)) unmatched.push(r.part);
      continue;
    }
    if (r.qty == null) {
      blankQty.push(r.part);
      continue;
    }
    // The same part number twice: the lower row wins (the sheet's latest).
    if (matched.has(sku)) duplicates.push(r.part);
    matched.set(sku, {
      market, sku, on_hand: r.qty, available: r.qty,
      warehouses: { [EXCEL_SOURCE]: { on_hand: r.qty, available: r.qty } },
      source: "excel", source_sku: r.part, eta: r.eta, dropped_at: null, synced_at: syncedAt,
    });
  }
  const upserts = [...matched.values()];
  const summary = {
    via, file: typeof body.fileName === "string" ? body.fileName : null,
    sheet: parsed.sheet, headerRow: parsed.headerRow, columns: parsed.columns,
    fileRows: parsed.rows.length,
    matched: upserts.length,
    inStock: upserts.filter((u) => (u.available as number) > 0).length,
    outOfStock: upserts.filter((u) => (u.available as number) <= 0).length,
    withEta: upserts.filter((u) => u.eta).length,
    unmatched: unmatched.sort(),
    blankQty: blankQty.sort(),
    duplicates: [...new Set(duplicates)].sort(),
    syncedAt,
  };
  if (dryRun) return { ok: true, ...base, dryRun: true, ...summary, removed: 0, sample: upserts.slice(0, 5) };

  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await supabase.from("product_inventory").upsert(upserts.slice(i, i + 500), { onConflict: "market,sku" });
    if (error) return { ok: false, ...base, step: "upsert", error: error.message };
  }
  // Not in the file = not tracked there: the row goes (the file lists its
  // own zeros, unlike ShipStation).
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

    // --- caller: cron secret, service role, or a signed-in user -------------
    const cronSecret = Deno.env.get("CRON_SECRET");
    const provided = req.headers.get("x-cron-secret");
    // The mailbox script hands over the Canada workbook with this secret and
    // can do nothing else here (checked once the body is parsed).
    const inboundSecret = Deno.env.get("INVENTORY_INBOUND_SECRET");
    const viaInbound = Boolean(inboundSecret && req.headers.get("x-inventory-secret") === inboundSecret);
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    let authorized = Boolean(cronSecret && provided === cronSecret) || viaInbound || bearer === SERVICE_ROLE;
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
    const markets = which === "all" ? ["us", "ca"] : [which];
    if (markets.some((m) => !MARKET_LABEL[m])) return json({ error: `unknown market "${which}" (use us, ca or all)` }, 400);
    if (viaInbound && !(mode === "pull" && which === "ca" && typeof body.file === "string" && body.file.length > 0)) {
      return json({ error: "The inbound secret only loads the Canada inventory file (mode pull, market ca, file)." }, 403);
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    if (mode === "ping") {
      const out: Record<string, unknown> = {};
      for (const m of markets) {
        if (m === "us") {
          const key = Deno.env.get(SS_US.secret);
          if (!key) { out.us = { ok: false, label: "USA", error: `${SS_US.secret} secret is not set.` }; continue; }
          try {
            const warehouses = await ssAll<Warehouse>("/inventory_warehouses?page_size=100", key, "inventory_warehouses");
            const r = await fetch(`${SS_BASE}/inventory?page_size=1`, { headers: { "API-Key": key, Accept: "application/json" } });
            out.us = { ok: true, label: "USA", source: "ShipStation", warehouses: warehouses.map((w) => `${w.inventory_warehouse_id} ${w.name}`), tracked: (await r.json()).total ?? null };
          } catch (err) {
            out.us = { ok: false, label: "USA", error: (err as Error).message };
          }
        } else {
          const link = Boolean(Deno.env.get("CA_INVENTORY_XLSX_URL"));
          const graph = Boolean(Deno.env.get("MS_TENANT_ID") && Deno.env.get("MS_CLIENT_ID") && Deno.env.get("MS_CLIENT_SECRET"));
          out.ca = { ok: link, label: "Canada", source: EXCEL_SOURCE, link, graph, automatic: link, note: link ? (graph ? "read through Microsoft Graph" : "plain download of the link") : "upload only until CA_INVENTORY_XLSX_URL is set" };
        }
      }
      return json({ ok: Object.values(out).every((r) => (r as { ok: boolean }).ok), markets: out });
    }
    if (mode !== "pull") return json({ error: `unknown mode "${mode}" (use pull or ping)` }, 400);

    // --- the PIM's SKUs, indexed once for every market ----------------------
    const { data: productRows, error: pErr } = await supabase.from("products").select("sku");
    if (pErr) return json({ ok: false, step: "products", error: pErr.message }, 500);
    const products: ProductIndex = { exact: new Set(), byUpper: new Map() };
    for (const p of productRows ?? []) {
      const sku = String(p.sku);
      products.exact.add(sku);
      if (!products.byUpper.has(sku.toUpperCase())) products.byUpper.set(sku.toUpperCase(), sku);
    }

    const reports: Record<string, Report> = {};
    const skipped: Record<string, Report> = {};
    for (const m of markets) {
      try {
        if (m === "us") {
          const key = Deno.env.get(SS_US.secret);
          reports.us = key
            ? await pullShipStationUs(key, supabase, products, dryRun)
            : { ok: false, market: "us", label: "USA", place: MARKET_PLACE.us, error: `${SS_US.secret} secret is not set.` };
        } else {
          const hasSource = (typeof body.file === "string" && body.file.length > 0) || Boolean(Deno.env.get("CA_INVENTORY_XLSX_URL"));
          if (!hasSource && which === "all") {
            // The hourly run has no workbook to read (it arrives by email or
            // upload): the last loaded file's rows and report stay as they are.
            skipped.ca = { ok: true, market: "ca", label: "Canada", place: MARKET_PLACE.ca, source: EXCEL_SOURCE, skipped: true, note: "No new workbook this run — the last loaded file stays." };
            continue;
          }
          reports.ca = await pullCanadaExcel(body, supabase, products, dryRun);
        }
      } catch (err) {
        reports[m] = { ok: false, market: m, label: MARKET_LABEL[m], place: MARKET_PLACE[m], error: (err as Error).message };
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
      markets: { ...skipped, ...reports },
      reportSaved,
    });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
