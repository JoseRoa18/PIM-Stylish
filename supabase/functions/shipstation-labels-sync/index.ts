// shipstation-labels-sync — copies ShipStation's shipping labels (both
// accounts, API v2) into public.shipstation_labels (user, 2026-11-05: "que
// quede la data lo más real y pura posible"). A label says when a shipment
// was prepared and what it really cost; Odoo's deliveries copy the first only
// approximately (a batch validated late is dated the day of the validation)
// and the second not at all. scorecard-fill matches labels to Odoo
// deliveries by tracking number.
//
// Body: { mode: "sync" | "backfill" | "status", account?: "us" | "ca", from?: "YYYY-MM-DD", to?: "YYYY-MM-DD" }
//   sync      — each account (or `account`) from 3 days before its newest
//               stored label up to now (re-reads the last days, so a label
//               voided since is updated). Daily cron.
//   backfill  — one account, labels created in [from, to). The API takes
//               ~45 s for a week of the Canada account: a week per call.
//   status    — labels stored per account, oldest and newest.
// Caller: cron (x-cron-secret), the service-role key, or an admin.
// Secrets: SHIPSTATION_API_KEY (USA account), SHIPSTATION_CA_API_KEY (Canada account), CRON_SECRET.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isServiceRole } from "../_shared/serviceRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SS = "https://api.shipstation.com/v2";
const ACCOUNTS: Record<string, string> = { us: "SHIPSTATION_API_KEY", ca: "SHIPSTATION_CA_API_KEY" };
const DAY = 86400000;

interface Label {
  label_id: string; shipment_id?: string; tracking_number?: string; created_at: string; ship_date?: string;
  shipment_cost?: { amount?: number; currency?: string }; insurance_cost?: { amount?: number };
  carrier_code?: string; service_code?: string; voided?: boolean; is_return_label?: boolean;
}

/** Labels created in [fromIso, toIso) of one account, every page. One retry on 429. */
async function fetchLabels(account: string, fromIso: string, toIso: string): Promise<Label[]> {
  const key = Deno.env.get(ACCOUNTS[account]);
  if (!key) throw new Error(`No ShipStation key for the ${account} account.`);
  const out: Label[] = [];
  for (let page = 1; page <= 100; page++) {
    const url = `${SS}/labels?created_at_start=${encodeURIComponent(fromIso)}&created_at_end=${encodeURIComponent(toIso)}&page_size=500&page=${page}`;
    let r = await fetch(url, { headers: { "api-key": key, Accept: "application/json" } });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, Math.min(Math.max(Number(r.headers.get("Retry-After") ?? "5"), 1), 30) * 1000));
      r = await fetch(url, { headers: { "api-key": key, Accept: "application/json" } });
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`ShipStation ${account} ${r.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    out.push(...((j.labels ?? []) as Label[]));
    if (page >= (j.pages ?? 1)) break;
  }
  return out;
}

const row = (account: string, l: Label) => ({
  label_id: l.label_id,
  account,
  tracking_number: l.tracking_number ? String(l.tracking_number).trim() : null,
  shipment_id: l.shipment_id ?? null,
  created_at: l.created_at,
  ship_date: l.ship_date ? l.ship_date.slice(0, 10) : null,
  cost: l.shipment_cost?.amount ?? null,
  insurance_cost: l.insurance_cost?.amount ?? null,
  currency: l.shipment_cost?.currency ? l.shipment_cost.currency.toUpperCase() : null,
  carrier_code: l.carrier_code ?? null,
  service_code: l.service_code ? l.service_code.trim() : null,
  voided: Boolean(l.voided),
  is_return: Boolean(l.is_return_label),
  synced_at: new Date().toISOString(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  try {
    const cronSecret = Deno.env.get("CRON_SECRET");
    const viaCron = Boolean(cronSecret && req.headers.get("x-cron-secret") === cronSecret);
    if (!viaCron) {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!token) return json({ error: "Missing Authorization header." }, 401);
      if (!(await isServiceRole(SUPABASE_URL, token, SERVICE_ROLE))) {
        const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
        const { data: { user } } = await caller.auth.getUser();
        if (!user) return json({ error: "Invalid or expired session." }, 401);
        const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
        if (profile?.role !== "admin") return json({ error: "Only admins can sync ShipStation labels." }, 403);
      }
    }
    const body = await req.json().catch(() => ({}));
    const mode: string = body.mode ?? "sync";
    const accounts = body.account ? [body.account] : Object.keys(ACCOUNTS);
    if (accounts.some((a: string) => !ACCOUNTS[a])) return json({ error: `Unknown account "${body.account}".` }, 400);

    if (mode === "status") {
      const out: Record<string, unknown> = {};
      for (const account of accounts) {
        const { count } = await admin.from("shipstation_labels").select("label_id", { count: "exact", head: true }).eq("account", account);
        const { data: oldest } = await admin.from("shipstation_labels").select("created_at").eq("account", account).order("created_at", { ascending: true }).limit(1);
        const { data: newest } = await admin.from("shipstation_labels").select("created_at").eq("account", account).order("created_at", { ascending: false }).limit(1);
        out[account] = { labels: count ?? 0, oldest: oldest?.[0]?.created_at ?? null, newest: newest?.[0]?.created_at ?? null };
      }
      return json({ ok: true, mode, ...out });
    }

    const results: Record<string, unknown> = {};
    for (const account of accounts) {
      let fromIso: string;
      let toIso: string;
      if (mode === "backfill") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.from ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(body.to ?? "")) return json({ error: "backfill needs from and to (YYYY-MM-DD)." }, 400);
        fromIso = `${body.from}T00:00:00Z`;
        toIso = `${body.to}T00:00:00Z`;
      } else if (mode === "sync") {
        const { data: newest } = await admin.from("shipstation_labels").select("created_at").eq("account", account).order("created_at", { ascending: false }).limit(1);
        const start = newest?.[0]?.created_at ? Date.parse(newest[0].created_at) - 3 * DAY : Date.now() - 3 * DAY;
        fromIso = new Date(start).toISOString();
        toIso = new Date(Date.now() + 3600000).toISOString();
      } else return json({ error: `Unknown mode "${mode}".` }, 400);

      const labels = await fetchLabels(account, fromIso, toIso);
      const rows = labels.filter((l) => l.label_id && l.created_at).map((l) => row(account, l));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await admin.from("shipstation_labels").upsert(rows.slice(i, i + 500), { onConflict: "label_id" });
        if (error) throw error;
      }
      results[account] = { from: fromIso, to: toIso, labels: rows.length, withCost: rows.filter((r) => Number(r.cost) > 0).length, voided: rows.filter((r) => r.voided).length };
    }
    if (mode === "sync") await admin.from("app_settings").upsert({ key: "shipstation_labels_sync", value: { at: new Date().toISOString(), ok: true, ...results } }, { onConflict: "key" });
    return json({ ok: true, mode, ...results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin.from("app_settings").upsert({ key: "shipstation_labels_sync", value: { at: new Date().toISOString(), ok: false, error: message } }, { onConflict: "key" });
    return json({ error: message }, 500);
  }
});
