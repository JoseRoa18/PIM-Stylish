// Stylish PIM → Walmart USA stock (user, 2026-10-30: "queremos todos, por
// lotes" — the products go on Walmart USA in lots, and their stock follows the
// PIM by itself).
//
// What it sends: every SKU listed on Walmart USA gets our USA stock
// (product_inventory 'us', the ShipStation pull) MINUS 2 units of safety
// margin (user's choice the same day), never below 0; a SKU we do not track
// goes as 0, and a product without stock stays listed at 0 so it sells as
// soon as stock arrives.
//
// How: Walmart's bulk inventory feed, feedType "inventory" (spec 1.4, one ship
// node per file — read on developer.walmart.com 2026-10-30): it updates the
// seller's default ship node, and the account has only one, VIRTUAL
// 10003231796 "Stylish USA Inc" (Flowery Branch GA, the ShipStation
// warehouse). The amount sent replaces Walmart's.
//
// When: every hour after inventory-pull (cron walmart-us-inventory-hourly),
// and only while the switch on the Walmart USA page is on
// (app_settings.walmart_us_inventory.enabled). A run sends the SKUs whose
// quantity changed since the last feed, and every SKU once a day (or on
// "Send now"); it first reads how the previous feed went, so the page shows
// Walmart's answer.
//
// Body: { mode?: "push" | "status" | "switch", dryRun?: boolean, all?: boolean, enabled?: boolean }
//   push    (default) — dryRun returns the lines without sending; all sends
//           every SKU, not only the changed ones.
//   status  — the switch, the last feed and its outcome; nothing is sent.
//   switch  — turns the hourly sync on or off (enabled), with an Activity Log entry.
// Caller: cron (x-cron-secret), the service-role key, or an admin / editor.
// Secrets: WALMART_US_PROD_CLIENT_ID / _SECRET, CRON_SECRET.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isServiceRole } from "../_shared/serviceRole.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BASE = "https://marketplace.walmartapis.com";
const SETTINGS_KEY = "walmart_us_inventory";
const SAFETY_UNITS = 2;
const FULL_EVERY_MS = 20 * 3600e3;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function wmHeaders(extra: Record<string, string>) {
  return { "WM_SVC.NAME": "Walmart Marketplace", "WM_QOS.CORRELATION_ID": crypto.randomUUID(), "Accept": "application/json", "WM_MARKET": "us", ...extra };
}
async function getToken(): Promise<string> {
  const cid = Deno.env.get("WALMART_US_PROD_CLIENT_ID"), sec = Deno.env.get("WALMART_US_PROD_CLIENT_SECRET");
  if (!cid || !sec) throw new Error("Walmart US production secrets are not set.");
  const res = await fetch(`${BASE}/v3/token`, {
    method: "POST",
    headers: wmHeaders({ Authorization: `Basic ${btoa(`${cid}:${sec}`)}`, "Content-Type": "application/x-www-form-urlencoded" }),
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Walmart token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

interface LastFeed {
  at: string; feedId: string | null; count: number; all: boolean;
  feedStatus?: string; itemsSucceeded?: number; itemsFailed?: number; errors?: { sku: string; error: string }[];
}
interface Settings { enabled?: boolean; sent?: Record<string, number>; all_at?: string | null; last?: LastFeed | null; checked_at?: string }

// The SKUs on Walmart USA (any state but retired). A seller with nothing
// listed gets 404 CONTENT_NOT_FOUND, not an empty page (walmart-pull-items).
async function listedSkus(wm: string): Promise<string[]> {
  const out: string[] = [];
  let total = 0;
  for (let offset = 0; offset < 10000; offset += 200) {
    const res = await fetch(`${BASE}/v3/items?limit=200&offset=${offset}`, { headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": wm }) });
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 404 && /CONTENT_NOT_FOUND|No Items found/i.test(body)) break;
      throw new Error(`Walmart items ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    total = data.totalItems ?? 0;
    const page = (data.ItemResponse ?? []) as Record<string, unknown>[];
    for (const it of page) if (it.sku && String(it.lifecycleStatus ?? "") !== "RETIRED") out.push(String(it.sku));
    if (!page.length || offset + 200 >= total) break;
  }
  return [...new Set(out)];
}

// How the previous feed went: its counts and the first errors per SKU.
async function feedOutcome(wm: string, last: LastFeed): Promise<LastFeed> {
  if (!last.feedId || last.feedStatus === "PROCESSED" || last.feedStatus === "ERROR") return last;
  const res = await fetch(`${BASE}/v3/feeds/${encodeURIComponent(last.feedId)}?includeDetails=true&limit=50&offset=0`, { headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": wm }) });
  if (!res.ok) return last;
  const d = await res.json() as Record<string, unknown>;
  const items = ((d.itemDetails as Record<string, unknown>)?.itemIngestionStatus ?? []) as Record<string, unknown>[];
  // Only a finished item that did not succeed is an error; INPROGRESS is
  // Walmart still working on it (it showed in red on the first feed).
  const errors = items.filter((it) => it.ingestionStatus && !["SUCCESS", "INPROGRESS"].includes(String(it.ingestionStatus))).slice(0, 20).map((it) => ({
    sku: String(it.sku ?? ""),
    error: (((it.ingestionErrors as Record<string, unknown>)?.ingestionError ?? []) as { description?: string }[]).map((e) => e.description).filter(Boolean).join(" · ") || String(it.ingestionStatus),
  }));
  return { ...last, feedStatus: String(d.feedStatus ?? ""), itemsSucceeded: Number(d.itemsSucceeded ?? 0), itemsFailed: Number(d.itemsFailed ?? 0), errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // --- caller ---------------------------------------------------------------
    const cronSecret = Deno.env.get("CRON_SECRET");
    const viaCron = Boolean(cronSecret && req.headers.get("x-cron-secret") === cronSecret);
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    let caller: { id: string | null; email: string | null } = { id: null, email: viaCron ? "cron" : "service role" };
    if (!viaCron) {
      if (!token) return json({ error: "Missing Authorization header." }, 401);
      if (!(await isServiceRole(SUPABASE_URL, token, SERVICE_ROLE))) {
        const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
        const { data: { user } } = await callerClient.auth.getUser();
        if (!user) return json({ error: "Invalid or expired session." }, 401);
        const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
        if (!["admin", "editor"].includes(profile?.role ?? "")) return json({ error: "Only admins and editors can send stock to Walmart USA." }, 403);
        caller = { id: user.id, email: user.email ?? null };
      }
    }

    const body = await req.json().catch(() => ({}));
    const mode: string = body.mode ?? "push";
    const dryRun = body.dryRun === true;
    const { data: row } = await admin.from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
    const settings: Settings = (row?.value as Settings) ?? {};
    const save = async (next: Settings) => {
      const { error } = await admin.from("app_settings").upsert({ key: SETTINGS_KEY, value: next }, { onConflict: "key" });
      if (error) throw new Error(`settings: ${error.message}`);
    };

    if (mode === "switch") {
      if (typeof body.enabled !== "boolean") return json({ error: "enabled (true / false) is required." }, 400);
      await save({ ...settings, enabled: body.enabled });
      await admin.from("audit_log").insert({
        actor_id: caller.id, actor_email: caller.email, actor_name: null, action: "update", entity_type: "channel", entity_id: "walmart_us", target: "walmart",
        summary: `Walmart USA stock sync switched ${body.enabled ? "on" : "off"}`, metadata: { enabled: body.enabled, safetyUnits: SAFETY_UNITS },
      }).then(() => {}, () => {});
      return json({ ok: true, enabled: body.enabled });
    }

    const wm = await getToken();
    let last = settings.last ?? null;
    if (last) last = await feedOutcome(wm, last);

    if (mode === "status") {
      if (last !== settings.last) await save({ ...settings, last });
      return json({ ok: true, enabled: Boolean(settings.enabled), safetyUnits: SAFETY_UNITS, last, allAt: settings.all_at ?? null, checkedAt: settings.checked_at ?? null, skusSent: Object.keys(settings.sent ?? {}).length });
    }
    if (mode !== "push") return json({ error: `unknown mode "${mode}"` }, 400);
    if (!settings.enabled && !dryRun) {
      if (last !== settings.last) await save({ ...settings, last });
      return json({ ok: true, skipped: "Stock sync is off (Walmart USA page)." });
    }

    // --- what each listed SKU should carry ------------------------------------
    const skus = await listedSkus(wm);
    const stock = new Map<string, number>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from("product_inventory").select("sku, available").eq("market", "us").order("sku").range(from, from + 999);
      if (error) throw new Error(`stock: ${error.message}`);
      for (const r of data ?? []) stock.set(String(r.sku), Number(r.available ?? 0));
      if (!data || data.length < 1000) break;
    }
    const want = skus.map((sku) => {
      const tracked = stock.has(sku);
      const ours = tracked ? Math.max(0, Math.floor(stock.get(sku)!)) : null;
      return { sku, ours, amount: ours == null ? 0 : Math.max(0, ours - SAFETY_UNITS) };
    });
    const sent = settings.sent ?? {};
    const sendAll = body.all === true || !settings.all_at || Date.now() - Date.parse(settings.all_at) > FULL_EVERY_MS;
    const lines = sendAll ? want : want.filter((w) => sent[w.sku] !== w.amount);
    const now = new Date().toISOString();

    if (dryRun) {
      return json({ ok: true, dryRun: true, enabled: Boolean(settings.enabled), listed: skus.length, sending: lines.length, all: sendAll, safetyUnits: SAFETY_UNITS, lines, last });
    }
    if (!lines.length) {
      await save({ ...settings, last, checked_at: now });
      return json({ ok: true, listed: skus.length, sending: 0, note: "No quantity changed since the last feed.", last });
    }

    // --- the feed ---------------------------------------------------------------
    const feed = { InventoryHeader: { version: "1.4" }, Inventory: lines.map((l) => ({ sku: l.sku, quantity: { unit: "EACH", amount: l.amount } })) };
    const form = new FormData();
    form.append("file", new Blob([JSON.stringify(feed)], { type: "application/json" }), "inventory.json");
    const res = await fetch(`${BASE}/v3/feeds?feedType=inventory`, { method: "POST", headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": wm }), body: form });
    const t = await res.text();
    if (!res.ok) {
      await save({ ...settings, last, checked_at: now });
      return json({ error: `Walmart inventory feed ${res.status}: ${t.slice(0, 300)}` }, 502);
    }
    let feedId: string | null = null;
    try { feedId = JSON.parse(t).feedId ?? null; } catch { /* keep null */ }
    const nextSent = { ...sent };
    for (const l of lines) nextSent[l.sku] = l.amount;
    const fed: LastFeed = { at: now, feedId, count: lines.length, all: sendAll };
    await save({ ...settings, sent: nextSent, all_at: sendAll ? now : settings.all_at ?? null, last: fed, checked_at: now });
    await admin.from("audit_log").insert({
      actor_id: caller.id, actor_email: caller.email, actor_name: caller.id ? null : "PIM automation", action: "push", entity_type: "channel", entity_id: "walmart_us", target: "walmart",
      summary: `Walmart USA stock: ${lines.length} SKU${lines.length === 1 ? "" : "s"} sent${sendAll ? " (all listed products)" : " (changed quantities)"} — feed ${feedId ?? "?"}`,
      metadata: { feedId, all: sendAll, safetyUnits: SAFETY_UNITS, lines: lines.slice(0, 400) },
    }).then(() => {}, () => {});
    return json({ ok: true, listed: skus.length, sending: lines.length, all: sendAll, feedId, previous: last });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[walmart-us-inventory] FAILED:", message);
    return json({ error: message }, 500);
  }
});
