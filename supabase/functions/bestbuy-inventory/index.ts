// Stylish PIM → Best Buy Canada stock (user, 2026-10-30: "Podemos enviar el
// inventario desde PIM?" — "Sí, hazlo"). On Oct 27–28 someone outside the
// PIM left ~108 of our offers at 0 / inactive while we had Canada stock, and
// Best Buy takes a product's page down while its offer has none.
//
// What it sends: every Best Buy offer whose shop SKU is a PIM product gets
// our Canada stock (product_inventory 'ca', the daily "Stylish Inventory"
// Excel) as it is — no safety margin (user, the same day: "quítale eso";
// Walmart USA keeps its 2 units) — and a product we do not track goes as 0. Open-box offers ("…-B-OB-A") and
// products switched off for Best Buy are left alone.
//
// When: the Canada stock arrives once a day, so a run sends only when a NEWER
// Canada file is in the PIM than the one last sent (or on "Send now") — the
// cron runs every hour (bestbuy-inventory-hourly) and finds nothing to do the
// rest of the day. Correcting Best Buy every hour would put back the units
// its own sales took off before the next file knows about them. A run sends
// only the offers whose quantity differs from ours.
//
// How: Mirakl OF24 (the same import as bestbuy-push-price). Mirakl runs it in
// NORMAL mode — a field missing from a line is blanked — so each line carries
// the offer's live price and discount (carryDiscount) with the new quantity.
// The next run reads how the import went.
//
// Body: { mode: "push" | "status" | "switch", dryRun?: boolean, all?: boolean, enabled?: boolean }
//   push    — dryRun returns the lines without sending; all sends even when
//           no newer Canada file came in (Send now). Only an explicit push sends.
//   status  — the switch, the last import and its outcome.
//   switch  — turns the sync on or off (enabled), with an Activity Log entry.
// Caller: cron (x-cron-secret), the service-role key, or an admin / editor.
// Secrets: BESTBUY_API_KEY, CRON_SECRET.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isServiceRole } from "../_shared/serviceRole.ts";
import { carryDiscount } from "../_shared/bestbuyDiscount.ts";
import { excludedSet } from "../_shared/exclusions.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MIRAKL_BASE = "https://marketplace.bestbuy.ca";
const SETTINGS_KEY = "bestbuy_inventory";
const SAFETY_UNITS = 0;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface LastImport {
  at: string; feedId: string | null; count: number; all: boolean;
  feedStatus?: string; itemsFailed?: number; errors?: { sku: string; error: string }[];
}
interface Settings { enabled?: boolean; stock_at?: string | null; last?: LastImport | null; checked_at?: string }
interface Offer { shop_sku: string; quantity: number; price: number | null; discount: Record<string, unknown> | null }

async function liveOffers(key: string): Promise<Offer[]> {
  const out: Offer[] = [];
  for (let offset = 0; offset < 20000; offset += 100) {
    const res = await fetch(`${MIRAKL_BASE}/api/offers?max=100&offset=${offset}`, { headers: { Authorization: key, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Could not read Best Buy's offers (Mirakl ${res.status}) — nothing was sent.`);
    const data = await res.json();
    for (const o of data.offers ?? []) out.push({ shop_sku: String(o.shop_sku), quantity: Number(o.quantity ?? 0), price: o.price ?? null, discount: o.discount ?? null });
    if (!data.offers?.length || offset + 100 >= (data.total_count ?? 0)) break;
  }
  return out;
}

// How the previous import went: its status, and the error report's lines.
async function importOutcome(key: string, last: LastImport): Promise<LastImport> {
  if (!last.feedId || last.feedStatus === "COMPLETE" || last.feedStatus === "FAILED") return last;
  const res = await fetch(`${MIRAKL_BASE}/api/offers/imports/${last.feedId}`, { headers: { Authorization: key, Accept: "application/json" } });
  if (!res.ok) return last;
  const st = await res.json();
  const next: LastImport = { ...last, feedStatus: String(st.status ?? ""), itemsFailed: Number(st.lines_in_error ?? 0) };
  if (next.itemsFailed) {
    const rep = await fetch(`${MIRAKL_BASE}/api/offers/imports/${last.feedId}/error_report`, { headers: { Authorization: key } });
    if (rep.ok) {
      const rows = (await rep.text()).split(/\r?\n/).slice(1).filter(Boolean).slice(0, 20);
      next.errors = rows.map((r) => ({ sku: r.split(/[;,]/)[0]?.replace(/"/g, "") ?? "", error: r.slice(0, 300) }));
    }
  }
  return next;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const KEY = Deno.env.get("BESTBUY_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    if (!KEY) return json({ error: "BESTBUY_API_KEY secret is not set." }, 500);
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
        if (!["admin", "editor"].includes(profile?.role ?? "")) return json({ error: "Only admins and editors can send stock to Best Buy." }, 403);
        caller = { id: user.id, email: user.email ?? null };
      }
    }

    const body = await req.json().catch(() => ({}));
    const mode: string = body.mode ?? "status";
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
        actor_id: caller.id, actor_email: caller.email, actor_name: null, action: "update", entity_type: "channel", entity_id: "bestbuy", target: "bestbuy",
        summary: `Best Buy stock sync switched ${body.enabled ? "on" : "off"}`, metadata: { enabled: body.enabled, safetyUnits: SAFETY_UNITS },
      }).then(() => {}, () => {});
      return json({ ok: true, enabled: body.enabled });
    }

    let last = settings.last ?? null;
    if (last) last = await importOutcome(KEY, last);

    if (mode === "status") {
      if (last !== settings.last) await save({ ...settings, last });
      return json({ ok: true, enabled: Boolean(settings.enabled), safetyUnits: SAFETY_UNITS, last, stockAt: settings.stock_at ?? null, checkedAt: settings.checked_at ?? null });
    }
    if (mode !== "push") return json({ error: `unknown mode "${mode}"` }, 400);
    if (!settings.enabled && !dryRun) {
      if (last !== settings.last) await save({ ...settings, last });
      return json({ ok: true, skipped: "Stock sync is off (Best Buy page)." });
    }

    // --- the Canada stock: only a newer file than the last one sent ------------
    const stock = new Map<string, number>();
    let stockAt = "";
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from("product_inventory").select("sku, available, synced_at").eq("market", "ca").order("sku").range(from, from + 999);
      if (error) throw new Error(`stock: ${error.message}`);
      for (const r of data ?? []) {
        stock.set(String(r.sku), Number(r.available ?? 0));
        if (r.synced_at && String(r.synced_at) > stockAt) stockAt = String(r.synced_at);
      }
      if (!data || data.length < 1000) break;
    }
    const now = new Date().toISOString();
    const fresh = !settings.stock_at || stockAt > settings.stock_at;
    if (!fresh && body.all !== true && !dryRun) {
      if (last !== settings.last) await save({ ...settings, last, checked_at: now });
      return json({ ok: true, sending: 0, note: "No newer Canada stock file since the last send.", stockAt, last });
    }

    // --- every offer of a PIM product, at our quantity -------------------------
    const offers = await liveOffers(KEY);
    const { data: products } = await admin.from("products").select("sku").in("sku", [...new Set(offers.map((o) => o.shop_sku))].slice(0, 2000));
    const known = new Set((products ?? []).map((p) => String(p.sku)));
    const excluded = await excludedSet(admin, [...known], "bestbuy");
    const all = offers.filter((o) => known.has(o.shop_sku) && !excluded.has(o.shop_sku) && o.price != null).map((o) => {
      const tracked = stock.has(o.shop_sku);
      const ours = tracked ? Math.max(0, Math.floor(stock.get(o.shop_sku)!)) : null;
      return { o, sku: o.shop_sku, ours, current: o.quantity, amount: ours == null ? 0 : Math.max(0, ours - SAFETY_UNITS) };
    });
    const lines = all.filter((w) => w.amount !== w.current);

    if (dryRun) {
      return json({ ok: true, dryRun: true, enabled: Boolean(settings.enabled), listed: all.length, sending: lines.length, safetyUnits: SAFETY_UNITS, stockAt, fresh, lines: lines.map(({ sku, ours, current, amount }) => ({ sku, ours, current, amount })), last });
    }
    if (!lines.length) {
      await save({ ...settings, last, stock_at: stockAt, checked_at: now });
      return json({ ok: true, listed: all.length, sending: 0, note: "Every offer already carries our quantity.", last });
    }

    // --- the OF24 import: the new quantity with the live price and discount ----
    const payload = lines.map(({ o, amount }) => {
      const line: Record<string, unknown> = { shop_sku: o.shop_sku, update_delete: "update", price: o.price, quantity: amount };
      const d = carryDiscount(o.discount);
      if (d) line.discount = d;
      return line;
    });
    const res = await fetch(`${MIRAKL_BASE}/api/offers`, {
      method: "POST",
      headers: { Authorization: KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ import_mode: "PARTIAL_UPDATE", offers: payload }),
    });
    const t = await res.json().catch(() => ({}));
    if (!res.ok || !t.import_id) {
      await save({ ...settings, last, checked_at: now });
      return json({ error: `Mirakl OF24 ${res.status}: ${JSON.stringify(t).slice(0, 300)}` }, 502);
    }
    const fed: LastImport = { at: now, feedId: String(t.import_id), count: lines.length, all: body.all === true };
    await save({ ...settings, stock_at: stockAt, last: fed, checked_at: now });
    await admin.from("audit_log").insert({
      actor_id: caller.id, actor_email: caller.email, actor_name: caller.id ? null : "PIM automation", action: "push", entity_type: "channel", entity_id: "bestbuy", target: "bestbuy",
      summary: `Best Buy stock: ${lines.length} offer${lines.length === 1 ? "" : "s"} sent (Canada stock of ${stockAt.slice(0, 10)}) — import ${t.import_id}`,
      metadata: { importId: t.import_id, safetyUnits: SAFETY_UNITS, stockAt, lines: lines.slice(0, 500).map(({ sku, ours, current, amount }) => ({ sku, ours, current, amount })) },
    }).then(() => {}, () => {});
    return json({ ok: true, listed: all.length, sending: lines.length, feedId: t.import_id, previous: last });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[bestbuy-inventory] FAILED:", message);
    return json({ error: message }, 500);
  }
});
