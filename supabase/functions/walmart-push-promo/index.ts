// Stylish PIM → Walmart Canada: schedule a promotion's prices as Walmart
// promotional prices (feed PRICE_AND_PROMOTION, Canada payload 5.0).
//
// Each line carries the product's REGULAR price (the PIM's MAP CAD, what
// Walmart Canada sells at), its MSRP, and the promotion: promotionType
// Reduced, promotionPrice = the PIM's promo MAP CAD, start/end = the Canada
// promo window (first Thursday 00:00 ET → the day before the next first
// Thursday 23:59:59 ET). Walmart turns it on and off by itself.
//
// Body: {
//   mode?: "push" | "status" | "promo"   (default push)
//   promotionId: number,                   push: which promotion
//   skus?: string[],                       push: subset (controlled tests)
//   dryRun?: boolean,                      push: build the payload, POST nothing
//   feedId?: string,                       status: read a feed's per-item outcome
//   sku?: string,                          promo: read the live promo of one SKU
// }
// Caller: authenticated admin/editor, or the service-role key (automation).
// Secrets: WALMART_CA_CLIENT_ID, WALMART_CA_CLIENT_SECRET.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { marketWindow } from "../_shared/promoCalendar.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BASE = "https://marketplace.walmartapis.com";
const FEED_VERSION = "5.0.20250801-18_47_55";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function wmHeaders(extra: Record<string, string>) {
  return { "WM_SVC.NAME": "Walmart Marketplace", "WM_QOS.CORRELATION_ID": crypto.randomUUID(), "Accept": "application/json", "WM_MARKET": "ca", ...extra };
}

async function getToken(cid: string, sec: string): Promise<string> {
  const res = await fetch(`${BASE}/v3/token`, {
    method: "POST",
    headers: wmHeaders({ Authorization: `Basic ${btoa(`${cid}:${sec}`)}`, "Content-Type": "application/x-www-form-urlencoded" }),
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Walmart token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

// A local Eastern-time wall clock ("2026-10-01", "00:00:00") as a UTC instant,
// DST-aware (EDT -04:00 / EST -05:00), in the ISO form the feed wants.
function etInstant(day: string, time: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  for (const off of ["-04:00", "-05:00"]) {
    const d = new Date(`${day}T${time}${off}`);
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    const hh = p.hour === "24" ? "00" : p.hour;
    if (`${p.year}-${p.month}-${p.day}` === day && `${hh}:${p.minute}:${p.second}` === time) return d.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return new Date(`${day}T${time}-05:00`).toISOString().replace(/\.\d{3}Z$/, "Z");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const CID = Deno.env.get("WALMART_CA_CLIENT_ID");
    const SEC = Deno.env.get("WALMART_CA_CLIENT_SECRET");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    if (!CID || !SEC) return json({ error: "Walmart Canada secrets are not set." }, 500);

    // --- caller: admin/editor session, or the service-role key --------------
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Missing Authorization header." }, 401);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    if (token !== SERVICE_ROLE) {
      const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
      const { data: { user: caller } } = await callerClient.auth.getUser();
      if (!caller) return json({ error: "Invalid or expired session." }, 401);
      const { data: profile } = await admin.from("profiles").select("role").eq("id", caller.id).maybeSingle();
      if (!["admin", "editor"].includes(profile?.role ?? "")) return json({ error: "Only admins and editors can push promotions." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const mode: string = body.mode ?? "push";
    const wm = await getToken(CID, SEC);
    const wmGet = async (path: string) => {
      const res = await fetch(`${BASE}${path}`, { headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": wm }) });
      const text = await res.text();
      let data: unknown = text;
      try { data = JSON.parse(text); } catch { /* keep text */ }
      return { status: res.status, data };
    };

    if (mode === "promo") {
      if (!body.sku) return json({ error: "sku is required." }, 400);
      return json({ ok: true, ...(await wmGet(`/v3/promo/sku/${encodeURIComponent(body.sku)}`)) });
    }
    if (mode === "status") {
      if (!body.feedId) return json({ error: "feedId is required." }, 400);
      const items: unknown[] = [];
      let offset = 0;
      let summary: Record<string, unknown> = {};
      for (let page = 0; page < 20; page++) {
        const r = await wmGet(`/v3/feeds/${encodeURIComponent(body.feedId)}?includeDetails=true&limit=50&offset=${offset}`);
        if (r.status !== 200) return json({ ok: false, ...r }, 502);
        const d = r.data as Record<string, unknown>;
        summary = { feedStatus: d.feedStatus, itemsReceived: d.itemsReceived, itemsSucceeded: d.itemsSucceeded, itemsFailed: d.itemsFailed, itemsProcessing: d.itemsProcessing };
        const page_ = ((d.itemDetails as Record<string, unknown>)?.itemIngestionStatus ?? []) as unknown[];
        items.push(...page_);
        offset += 50;
        if (page_.length < 50 || offset >= Number(d.itemsReceived ?? 0)) break;
      }
      const failed = items.filter((it) => (it as Record<string, unknown>).ingestionStatus !== "SUCCESS");
      return json({ ok: true, ...summary, failed });
    }

    // --- push ---------------------------------------------------------------
    const promotionId = Number(body.promotionId);
    if (!promotionId) return json({ error: "promotionId is required." }, 400);
    const dryRun = body.dryRun === true;
    const only: string[] | null = Array.isArray(body.skus) && body.skus.length ? body.skus : null;

    const { data: promo, error: pErr } = await admin.from("promotions").select("id, name, period, status").eq("id", promotionId).maybeSingle();
    if (pErr) throw pErr;
    if (!promo) return json({ error: `Promotion ${promotionId} not found.` }, 404);
    const { data: prices, error: prErr } = await admin.from("promotion_prices").select("sku, promo_price_cad").eq("promotion_id", promotionId).not("promo_price_cad", "is", null);
    if (prErr) throw prErr;
    let members = (prices ?? []) as { sku: string; promo_price_cad: number }[];
    if (only) members = members.filter((m) => only.includes(m.sku));
    if (!members.length) return json({ error: "No Canada promo prices to send." }, 400);

    const skus = members.map((m) => m.sku);
    const pim = new Map<string, { map_cad: number | null; msrp_cad: number | null }>();
    for (let i = 0; i < skus.length; i += 100) {
      const { data } = await admin.from("products").select("sku, map_cad, msrp_cad").in("sku", skus.slice(i, i + 100));
      for (const p of data ?? []) pim.set(p.sku, { map_cad: p.map_cad, msrp_cad: p.msrp_cad });
    }
    // Listed on Walmart Canada = present in the latest inventory-feed snapshot
    // (rows keyed by PIM SKU). Products Walmart lists under an alias
    // ("S-300XG-1") are sent under that alias.
    const { data: snap } = await admin.from("channel_health").select("results").eq("channel", "walmart_ca").order("run_at", { ascending: false }).limit(1).maybeSingle();
    const listed = snap?.results ? new Set((snap.results as { sku: string }[]).map((r) => r.sku)) : null;
    const { data: aliasRows } = await admin.from("product_aliases").select("alias, sku").eq("marketplace", "Walmart CA").in("sku", skus);
    const walmartSku = new Map<string, string>((aliasRows ?? []).map((r: { alias: string; sku: string }) => [r.sku, r.alias]));

    const window = marketWindow(promo.period, "ca");
    let start = etInstant(window.start, "00:00:00");
    const end = etInstant(window.end, "23:59:59");
    const nowIso = new Date(Date.now() + 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    if (start < nowIso) start = nowIso; // a window already open starts in a few minutes
    if (end <= start) return json({ error: `The Canada window for ${promo.period} already ended (${window.end}).` }, 400);

    const lines: Record<string, unknown>[] = [];
    let aliased = 0;
    const notListed: string[] = [];
    const noMap: string[] = [];
    const atOrAboveMap: string[] = [];
    for (const m of members) {
      if (listed && !listed.has(m.sku)) { notListed.push(m.sku); continue; }
      const p = pim.get(m.sku);
      if (!p || p.map_cad == null) { noMap.push(m.sku); continue; }
      if (Number(m.promo_price_cad) >= Number(p.map_cad)) { atOrAboveMap.push(m.sku); continue; }
      const wsku = walmartSku.get(m.sku) ?? m.sku;
      if (wsku !== m.sku) aliased += 1;
      const price: Record<string, unknown> = {
        sku: wsku,
        price: Number(p.map_cad),
        promotionInformation: {
          promotionSettingAction: "Create",
          promotionType: "Reduced",
          promotionPrice: Number(m.promo_price_cad),
          promotionPriceStartDateTime: start,
          promotionPriceEndDateTime: end,
        },
      };
      if (p.msrp_cad != null) price.msrp = Number(p.msrp_cad);
      lines.push({ Price: price });
    }
    const payload = {
      MPItemFeedHeader: {
        subCategory: "price-mp",
        mart: "WALMART_CA",
        feedType: "PRICE_AND_PROMOTION",
        processMode: "REPLACE",
        locale: ["en", "fr"],
        version: FEED_VERSION,
        subset: "EXTERNAL",
        tenant: "WALMART_CA",
      },
      MPItem: lines,
    };
    const report: Record<string, unknown> = {
      promotion: promo.name, period: promo.period, window: { start, end },
      attempted: lines.length, sent_under_alias: aliased, not_listed: notListed.length, no_map: noMap, at_or_above_map: atOrAboveMap,
    };
    if (dryRun) return json({ ok: true, dryRun: true, ...report, listed_known: listed != null, payload });
    if (!lines.length) return json({ error: "Nothing to send: no member is listed on Walmart Canada with a promo price below its MAP.", ...report }, 400);

    const res = await fetch(`${BASE}/v3/feeds?feedType=PRICE_AND_PROMOTION`, {
      method: "POST",
      headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": wm, "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) return json({ error: `Walmart feed ${res.status}: ${text.slice(0, 400)}`, ...report }, 502);
    let feedId: string | null = null;
    try { feedId = JSON.parse(text).feedId ?? null; } catch { /* keep null */ }

    // Give Walmart a moment and read back what it did with each line.
    let outcome: Record<string, unknown> = {};
    if (feedId) {
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise((r) => setTimeout(r, 6000));
        const r = await wmGet(`/v3/feeds/${encodeURIComponent(feedId)}?includeDetails=true&limit=50&offset=0`);
        if (r.status !== 200) continue;
        const d = r.data as Record<string, unknown>;
        outcome = { feedStatus: d.feedStatus, itemsReceived: d.itemsReceived, itemsSucceeded: d.itemsSucceeded, itemsFailed: d.itemsFailed, itemsProcessing: d.itemsProcessing };
        const items = ((d.itemDetails as Record<string, unknown>)?.itemIngestionStatus ?? []) as Record<string, unknown>[];
        outcome.failed = items.filter((it) => it.ingestionStatus !== "SUCCESS").slice(0, 20);
        if (d.feedStatus === "PROCESSED" || d.feedStatus === "ERROR") break;
      }
    }

    const schedule = { at: new Date().toISOString(), feed_id: feedId, ...report, ...outcome };
    if (!only) {
      await admin.from("promotions").update({ wm_ca_scheduled_at: schedule.at, wm_ca_schedule: schedule }).eq("id", promotionId);
    }
    return json({ ok: true, feedId, ...schedule });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[walmart-push-promo] FAILED:", message);
    return json({ error: message }, 500);
  }
});
