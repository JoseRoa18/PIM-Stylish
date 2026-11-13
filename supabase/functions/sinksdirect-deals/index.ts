// Flash deals, MK events and peak season events on the Sinks Direct stores
// (user, 2026-11-11: "que apenas se genere el deal … se suba dependiendo de la
// fecha; si se pone la fecha de hoy, se envía de una vez"). Until then only the
// monthly promotion reached those stores by itself.
//
// Every run works out which deal price each product should carry on each store
// TODAY — the very expected price Price Alignment shows (_shared/
// priceAlignmentReport.js: a deal running by its dates on that store, the later
// start winning) — and changes only what differs from what the PIM already put
// there (table sinksdirect_deal_prices). A deal starting, ending, being ended
// early or deleted, a product leaving its list, a new price or a new date all
// take the same path:
//   - a product in a running deal gets the deal's price;
//   - a product whose deal is over goes back to the monthly promotion's price
//     when it is in the one running, else to its regular price (MAP).
//
// How each store takes a price (the way promo-apply does the monthly one):
//   Sinks Direct Canada  the PIM's sale fields (on_sale + sale_price_cad) hold
//                        the price and Wix shows MAP with a discount;
//   Sinks Direct USA     the price itself, no discount.
//
// A price the PIM put on a store is put back when something else pushed over it:
// wix-push-product stamps wix_links.synced_at on every push (a product's "Push
// <store>", Price Alignment's fix, promo-apply at a monthly boundary), and on
// Sinks Direct Canada the PIM's own sale fields are compared too.
//
// Wix lets about 30 changes through and then asks to wait about a minute: a run
// stops when its time is up and the next one (cron every 5 minutes, or the
// Pricing page calling again) goes on. A change Wix refuses waits longer each
// time (15 minutes, 30, an hour… up to 12 hours).
//
// Auth: x-cron-secret, a service-role bearer, or a signed-in admin / editor (the
// Pricing page calls it when a deal is created or changed). Every run honours
// the promotion automation switches in Settings. Body:
//   { dryRun: true, asOf?: "YYYY-MM-DD" }  the plan, nothing written
//   { sites?: ["sinksdirect_us"], limit?: 5 }  a part of the work (tests)
//   { force: true }                        try again now what Wix refused
// The last run's report is app_settings.sinksdirect_deals_run.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { etToday } from "../_shared/promoCalendar.ts";
import { isServiceRole } from "../_shared/serviceRole.ts";
import { WIX_SITES, type WixSite } from "../_shared/wixSites.ts";
import { createPriceAlignment } from "../_shared/priceAlignmentReport.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const SITE_KEYS = ["sinksdirect_ca", "sinksdirect_us"];
const DEAL_KINDS = ["flash", "mk_event", "special"];
const TABLE = "sinksdirect_deal_prices";
const RUN_KEY = "sinksdirect_deals_run";
const LOCK_KEY = "sinksdirect_deals_lock";

const RUN_BUDGET_MS = 100_000;
const WIX_CALL_TIMEOUT_MS = 20_000;
const WORKERS = 2; // per store
const GAP_MS = 250;
const MAX_LIST = 25;
const RETRY_FIRST_MS = 15 * 60_000;
const RETRY_MAX_MS = 12 * 3600_000;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const same = (a: number | null, b: number | null) => (a == null || b == null ? a == b : Math.abs(a - b) < 0.005);
const round2 = (n: number) => Math.round(n * 100) / 100;

const admin = createClient(SUPABASE_URL, SERVICE_KEY);
function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

type Tracked = {
  site: string; sku: string; promotion_id: number | null; price: number; base_price: number | null; live_price: number | null;
  confirmed: boolean; applied_at: string; attempts: number; last_error: string | null; next_try_at: string | null;
};
type Pim = { on_sale: boolean | null; sale_price_cad: number | null };
type SetJob = { kind: "set"; site: WixSite; sku: string; wixId: string; price: number; base: number; promotion_id: number | null; deal: string; why: string; row: Tracked | null; pim: Pim | null };
type BackJob = { kind: "back"; site: WixSite; sku: string; wixId: string | null; base: number | null; monthly: number | null; row: Tracked; pim: Pim | null };
type Job = SetJob | BackJob;
type Skip = { sku: string; deal: string; reason: string };

/** What one store should carry on `today` against what the PIM put there: the changes to make. */
async function planSite(site: WixSite, today: string, force: boolean, prices: ReturnType<typeof createPriceAlignment>) {
  const cfg = { ...site, promoChannel: `wix_${site.key}` };
  const { baseBySku, promoBySku } = await prices.loadExpectedPrices(cfg, { today });
  const deals = new Map<string, { price: unknown; name?: string; id?: number }>();
  const monthly = new Map<string, number>();
  for (const [sku, p] of promoBySku as Map<string, { price: unknown; kind: string; name?: string; id?: number }>) {
    if (p.kind === "monthly") { const m = num(p.price); if (m != null) monthly.set(sku, m); }
    else deals.set(sku, p);
  }
  const tracked = new Map<string, Tracked>();
  for (const r of must(await admin.from(TABLE).select("*").eq("site", site.key).range(0, 4999), "Read the deal prices on the stores") as Tracked[]) tracked.set(r.sku, r);

  const out = { jobs: [] as Job[], skipped: [] as Skip[], waiting: 0, relabel: [] as { sku: string; promotion_id: number | null }[], running: [...new Set([...deals.values()].map((d) => d.name ?? "?"))], wanted: 0, onStore: 0 };
  const skus = [...new Set([...deals.keys(), ...tracked.keys()])];
  if (!skus.length) return out;

  // The store's product of each SKU and when it was last pushed to; on Sinks
  // Direct Canada also the PIM's sale fields (and the link of older products).
  const links = new Map<string, { id: string; syncedAt: string | null }>();
  const pimBySku = new Map<string, Pim>();
  for (const part of chunk(skus, 200)) {
    const [ls, ps] = await Promise.all([
      admin.from("wix_links").select("sku, wix_product_id, synced_at").eq("site", site.key).in("sku", part),
      site.hasSale ? admin.from("products").select("sku, wix_product_id, on_sale, sale_price_cad").in("sku", part) : Promise.resolve({ data: [], error: null }),
    ]);
    for (const p of must(ps, "Read the products") as { sku: string; wix_product_id: string | null; on_sale: boolean | null; sale_price_cad: unknown }[]) {
      pimBySku.set(p.sku, { on_sale: p.on_sale, sale_price_cad: num(p.sale_price_cad) });
      if (site.legacyColumns && p.wix_product_id) links.set(p.sku, { id: p.wix_product_id, syncedAt: null });
    }
    for (const l of must(ls, "Read the store links") as { sku: string; wix_product_id: string | null; synced_at: string | null }[]) {
      if (l.wix_product_id) links.set(l.sku, { id: l.wix_product_id, syncedAt: l.synced_at });
    }
  }

  const now = Date.now();
  const waits = (row: Tracked | null) => !force && row?.next_try_at != null && Date.parse(row.next_try_at) > now;

  // The products a running deal gives a price that can go to the store.
  const wanted = new Map<string, { price: number; base: number; wixId: string; promotion_id: number | null; deal: string }>();
  for (const [sku, d] of deals) {
    const price = num(d.price);
    const base = num(baseBySku.get(sku));
    const deal = d.name ?? "?";
    if (price == null || price <= 0) continue;
    if (base == null) { out.skipped.push({ sku, deal, reason: "no regular price in the PIM" }); continue; }
    if (price >= base) { out.skipped.push({ sku, deal, reason: `the deal's price (${price}) is not under the regular price (${base})` }); continue; }
    const link = links.get(sku);
    if (!link) { out.skipped.push({ sku, deal, reason: "not on this store" }); continue; }
    wanted.set(sku, { price, base, wixId: link.id, promotion_id: d.id ?? null, deal });
  }
  out.wanted = wanted.size;

  // A deal that is over goes first: its price must not wait behind new ones.
  for (const [sku, row] of tracked) {
    if (wanted.has(sku)) continue;
    if (waits(row)) { out.waiting += 1; continue; }
    out.jobs.push({ kind: "back", site, sku, wixId: links.get(sku)?.id ?? null, base: num(baseBySku.get(sku)), monthly: monthly.get(sku) ?? null, row, pim: pimBySku.get(sku) ?? null });
  }
  for (const [sku, w] of wanted) {
    const row = tracked.get(sku) ?? null;
    const pim = pimBySku.get(sku) ?? null;
    const syncedAt = links.get(sku)?.syncedAt ?? null;
    let why: string | null = null;
    if (!row) why = "the deal runs today";
    else if (!same(num(row.price), w.price)) why = "the deal's price changed";
    else if (site.hasSale && !same(num(row.base_price), w.base)) why = "the regular price changed";
    else if (!row.confirmed) why = "not on the store yet";
    else if (site.hasSale && (pim?.on_sale !== true || !same(pim?.sale_price_cad ?? null, w.price))) why = "the PIM's sale price was changed";
    else if (syncedAt && Date.parse(syncedAt) > Date.parse(row.applied_at)) why = "another push went over it";
    if (!why) {
      out.onStore += 1;
      if (row && row.promotion_id !== w.promotion_id) out.relabel.push({ sku, promotion_id: w.promotion_id });
      continue;
    }
    if (waits(row)) { out.waiting += 1; continue; }
    out.jobs.push({ kind: "set", site, sku, wixId: w.wixId, price: w.price, base: w.base, promotion_id: w.promotion_id, deal: w.deal, why, row, pim });
  }
  return out;
}

type WixAnswer =
  | { ok: true; live: number | null }
  | { ok: false; limited: boolean; gone: boolean; waitMs: number; message: string };

async function patchWix(site: WixSite, wixId: string, product: Record<string, unknown>): Promise<WixAnswer> {
  const r = await fetch(`https://www.wixapis.com/stores/v1/products/${wixId}`, {
    method: "PATCH",
    headers: { Authorization: Deno.env.get("WIX_API_KEY")!, "wix-site-id": site.siteId, "Content-Type": "application/json" },
    body: JSON.stringify({ product }),
    signal: AbortSignal.timeout(WIX_CALL_TIMEOUT_MS),
  });
  const text = await r.text();
  if (r.ok) {
    let live: number | null = null;
    try { live = num(JSON.parse(text)?.product?.priceData?.discountedPrice); } catch { /* the change went through all the same */ }
    return { ok: true, live };
  }
  const limited = r.status === 429 || /rate limit|too many requests/i.test(text);
  // Wix says "Retry after 56003ms."
  const m = text.match(/retry after\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|seconds)?/i);
  const n = m ? Number(m[1]) : NaN;
  const asked = !Number.isFinite(n) || n <= 0 ? 30_000 : /^s/i.test(m?.[2] ?? "") || (!m?.[2] && n < 300) ? n * 1000 : n;
  return { ok: false, limited, gone: r.status === 404, waitMs: Math.min(65_000, Math.max(2_000, asked + 500)), message: `${r.status} ${text.slice(0, 160)}` };
}

type Totals = { set: number; back: number; failed: number; new_failures: number; owed: number; errors: string[]; mismatches: string[] };

/** A change Wix refused: tried again later, a little later each time. */
async function refused(site: WixSite, sku: string, row: Tracked | null, message: string, backOff: boolean, totals: Totals) {
  const attempts = (row?.attempts ?? 0) + (backOff ? 1 : 0);
  const wait = backOff ? Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, attempts - 1)) : 0;
  await admin.from(TABLE).update({ attempts, last_error: message.slice(0, 300), next_try_at: wait ? new Date(Date.now() + wait).toISOString() : null }).eq("site", site.key).eq("sku", sku);
  totals.failed += 1;
  if (attempts <= 1) totals.new_failures += 1;
  if (totals.errors.length < MAX_LIST) totals.errors.push(`${site.label} ${sku}: ${message}`);
}

/** One store's changes, two at a time, at Wix's pace. */
async function runSite(site: WixSite, jobs: Job[], deadline: number, totals: Totals) {
  let next = 0;
  let pausedUntil = 0;
  let stopped = false;

  async function one(job: Job): Promise<"done" | "stop" | "failed"> {
    const { sku } = job;
    let product: Record<string, unknown>;
    if (job.kind === "set") {
      // Written first: whatever happens next, the store's deal price is on record.
      const fields = { promotion_id: job.promotion_id, price: job.price, base_price: job.base, confirmed: false };
      if (job.row) must(await admin.from(TABLE).update(fields).eq("site", site.key).eq("sku", sku), "Save the deal price");
      else must(await admin.from(TABLE).insert({ site: site.key, sku, ...fields, before: site.hasSale ? job.pim : null }), "Save the deal price");
      if (site.hasSale) {
        // Sinks Direct Canada sells from the PIM's sale fields: any other push
        // of the product then carries the deal's price too.
        if (job.pim?.on_sale !== true || !same(job.pim?.sale_price_cad ?? null, job.price)) {
          must(await admin.from("products").update({ on_sale: true, sale_price_cad: job.price }).eq("sku", sku), "Save the sale price");
        }
        product = { priceData: { price: job.base, currency: site.currency }, discount: { type: "AMOUNT", value: round2(job.base - job.price) } };
      } else {
        product = { priceData: { price: job.price, currency: site.currency }, discount: { type: "AMOUNT", value: 0 } };
      }
    } else {
      // The deal is over: the monthly promotion's price when the product is in
      // the one running, else its regular price.
      const promo = job.monthly != null && job.base != null && job.monthly < job.base ? job.monthly : null;
      if (site.hasSale) {
        const sale = promo != null ? { on_sale: true, sale_price_cad: promo } : { on_sale: false, sale_price_cad: null };
        if (job.pim && (Boolean(job.pim.on_sale) !== sale.on_sale || !same(job.pim.sale_price_cad, sale.sale_price_cad))) {
          must(await admin.from("products").update(sale).eq("sku", sku), "Save the sale price");
        }
        product = { ...(job.base != null ? { priceData: { price: job.base, currency: site.currency } } : {}), discount: { type: "AMOUNT", value: promo != null ? round2(job.base! - promo) : 0 } };
      } else {
        const price = job.monthly ?? job.base;
        if (price == null && job.wixId) { await refused(site, sku, job.row, "no regular price in the PIM to go back to", true, totals); return "failed"; }
        product = { priceData: { price, currency: site.currency }, discount: { type: "AMOUNT", value: 0 } };
      }
      if (!job.wixId) {
        // The product left the store: nothing on Wix to take back.
        must(await admin.from(TABLE).delete().eq("site", site.key).eq("sku", sku), "Clear the deal price");
        totals.back += 1;
        return "done";
      }
    }
    const wixId = job.wixId as string;
    for (;;) {
      let r: WixAnswer;
      try {
        r = await patchWix(site, wixId, product);
      } catch (err) {
        // Too slow or the network failed: the next run tries again.
        await refused(site, sku, job.row, (err as Error).message, false, totals);
        return "failed";
      }
      if (r.ok) {
        if (job.kind === "set") {
          must(await admin.from(TABLE).update({ confirmed: true, live_price: r.live, applied_at: new Date().toISOString(), attempts: 0, last_error: null, next_try_at: null }).eq("site", site.key).eq("sku", sku), "Confirm the deal price");
          if (r.live != null && Math.abs(r.live - job.price) > 0.05 && totals.mismatches.length < MAX_LIST) totals.mismatches.push(`${site.label} ${sku}: the store shows ${r.live}, the deal says ${job.price}`);
          totals.set += 1;
        } else {
          must(await admin.from(TABLE).delete().eq("site", site.key).eq("sku", sku), "Clear the deal price");
          totals.back += 1;
        }
        return "done";
      }
      if (r.limited) {
        pausedUntil = Math.max(pausedUntil, Date.now() + r.waitMs);
        if (pausedUntil + WIX_CALL_TIMEOUT_MS >= deadline) return "stop";
        await sleep(pausedUntil - Date.now());
        continue;
      }
      if (r.gone && job.kind === "back") {
        // Wix no longer has the product: nothing to take back.
        must(await admin.from(TABLE).delete().eq("site", site.key).eq("sku", sku), "Clear the deal price");
        totals.back += 1;
        return "done";
      }
      await refused(site, sku, job.row, r.gone ? "Wix no longer has this product (404)" : r.message, true, totals);
      return "failed";
    }
  }

  const worker = async () => {
    while (next < jobs.length && !stopped) {
      if (pausedUntil > Date.now()) await sleep(pausedUntil - Date.now());
      if (stopped || Date.now() + WIX_CALL_TIMEOUT_MS > deadline) return;
      const job = jobs[next++];
      let r: "done" | "stop" | "failed";
      try {
        r = await one(job);
      } catch (err) {
        // The database refused a write: said once, tried again by the next run.
        totals.failed += 1;
        if (totals.errors.length < MAX_LIST) totals.errors.push(`${site.label} ${job.sku}: ${(err as Error).message}`);
        r = "failed";
      }
      if (r === "stop") { totals.owed += 1; stopped = true; return; }
      await sleep(GAP_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, jobs.length) }, worker));
  totals.owed += Math.max(0, jobs.length - next);
}

/** Asks health-refresh for these stores' snapshots (it answers at once and takes them on its own). */
async function askSnapshot(keys: string[]) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/health-refresh`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      // a store's catalog can take a few seconds to show a price just changed
      body: JSON.stringify({ only: keys, after_ms: 20_000 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error(`[sinksdirect-deals] the snapshot of ${keys.join(", ")} was not taken: health-refresh answered ${res.status}`);
    else await res.body?.cancel();
  } catch (err) {
    // The two daily snapshots come anyway.
    console.error(`[sinksdirect-deals] the snapshot of ${keys.join(", ")} was not asked for:`, err instanceof Error ? err.message : err);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  let locked = false;
  try {
    // --- caller: the cron, the service role, or a signed-in admin / editor ----
    const cronSecret = Deno.env.get("CRON_SECRET");
    const viaCron = Boolean(cronSecret && req.headers.get("x-cron-secret") === cronSecret);
    let actor: { actor_id: string; actor_email: string | null; actor_name: string | null } | null = null;
    if (!viaCron) {
      const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!bearer) return json({ error: "Missing Authorization header." }, 401);
      if (!(await isServiceRole(SUPABASE_URL, bearer, SERVICE_KEY))) {
        const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
        const { data: { user } } = await callerClient.auth.getUser();
        if (!user) return json({ error: "Invalid or expired session." }, 401);
        const { data: profile } = await admin.from("profiles").select("role, full_name").eq("id", user.id).maybeSingle();
        if (!["admin", "editor"].includes(profile?.role ?? "")) return json({ error: "Only admins and editors can send deal prices to the stores." }, 403);
        actor = { actor_id: user.id, actor_email: user.email ?? null, actor_name: profile?.full_name ?? user.email ?? null };
      }
    }

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun === true;
    const force = body.force === true;
    const today = dryRun && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf ?? "") ? body.asOf : etToday();
    const siteKeys = Array.isArray(body.sites) ? SITE_KEYS.filter((k) => body.sites.includes(k)) : SITE_KEYS;
    const limit = Number.isInteger(body.limit) && body.limit > 0 ? body.limit : null;

    if (!dryRun) {
      const { data } = await admin.from("app_settings").select("value").eq("key", "promo_automation").maybeSingle();
      const switches = (data?.value ?? {}) as { enabled?: boolean; wix?: boolean };
      if (switches.enabled === false || switches.wix === false) return json({ today, skipped: "The promotion automation is off in Settings." });
    }

    // Nothing on the stores and no deal for them: most runs end here.
    const [onStores, anyDeal] = await Promise.all([
      admin.from(TABLE).select("sku", { count: "exact", head: true }),
      admin.from("promotions").select("id").in("kind", DEAL_KINDS).neq("status", "ended").overlaps("marketplaces", SITE_KEYS.map((k) => `wix_${k}`)).limit(1),
    ]);
    if (onStores.error) throw new Error(`Read the deal prices on the stores: ${onStores.error.message}`);
    if (!onStores.count && !(must(anyDeal, "Read the deals") as unknown[]).length) return json({ today, nothing_to_do: true, to_set: 0, to_back: 0, owed: 0 });

    // One run reads each thing once (products, monthly promotions, deals).
    const memo = new Map<string, Promise<unknown>>();
    const sharedLoad = (key: string, loader: () => Promise<unknown>) => {
      if (!memo.has(key)) memo.set(key, loader());
      return memo.get(key);
    };
    const prices = createPriceAlignment({ db: admin, sharedLoad });
    const sites = siteKeys.map((k) => WIX_SITES[k]);
    const plans = await Promise.all(sites.map((site) => planSite(site, today, force, prices)));

    // `limit` (tests): only the first changes, the rest are owed.
    let left = limit ?? Infinity;
    const work = plans.map((p) => { const take = p.jobs.slice(0, Math.max(0, left)); left -= take.length; return take; });
    const allJobs = plans.flatMap((p) => p.jobs);
    const perSite = Object.fromEntries(sites.map((site, i) => [site.key, {
      deals: plans[i].running,
      products: plans[i].wanted,
      on_store: plans[i].onStore,
      to_set: plans[i].jobs.filter((j) => j.kind === "set").length,
      to_back: plans[i].jobs.filter((j) => j.kind === "back").length,
      waiting: plans[i].waiting,
      skipped: plans[i].skipped.slice(0, 200),
    }]));
    const plan = {
      today,
      to_set: allJobs.filter((j) => j.kind === "set").length,
      to_back: allJobs.filter((j) => j.kind === "back").length,
      on_store: plans.reduce((n, p) => n + p.onStore, 0),
      waiting: plans.reduce((n, p) => n + p.waiting, 0),
      sites: perSite,
    };
    if (dryRun) {
      return json({
        dryRun: true, ...plan,
        lines: allJobs.slice(0, 400).map((j) => j.kind === "set"
          ? { action: "set", site: j.site.key, sku: j.sku, price: j.price, regular: j.base, deal: j.deal, why: j.why }
          : { action: "back", site: j.site.key, sku: j.sku, to: j.monthly != null && j.base != null && j.monthly < j.base ? j.monthly : j.base, monthly: j.monthly, regular: j.base, on_store: j.wixId != null }),
      });
    }

    // The same price from another deal: only whose it is changes.
    for (const [i, p] of plans.entries()) {
      for (const r of p.relabel) await admin.from(TABLE).update({ promotion_id: r.promotion_id }).eq("site", sites[i].key).eq("sku", r.sku);
    }
    if (!allJobs.length) return json({ ...plan, nothing_to_do: true, owed: 0 });

    // One run at a time: a second one (the cron while the Pricing page is
    // sending, or the reverse) leaves the work to the first.
    const { data: lock } = await admin.from("app_settings").select("value").eq("key", LOCK_KEY).maybeSingle();
    const until = (lock?.value as { until?: string | null } | null)?.until;
    if (until && Date.parse(until) > Date.now()) return json({ ...plan, busy: true, owed: allJobs.length });
    const setLock = (value: string | null) => admin.from("app_settings").upsert({ key: LOCK_KEY, value: { until: value }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    await setLock(new Date(Date.now() + RUN_BUDGET_MS + 45_000).toISOString());
    locked = true;

    const totals: Totals = { set: 0, back: 0, failed: 0, new_failures: 0, owed: allJobs.length - work.reduce((n, w) => n + w.length, 0), errors: [], mismatches: [] };
    const deadline = Date.now() + RUN_BUDGET_MS;
    await Promise.all(sites.map((site, i) => runSite(site, work[i], deadline, totals)));
    await setLock(null);
    locked = false;

    // Price Alignment and Listing Health read a store's LAST snapshot, taken
    // twice a day: a deal made, changed or ended during the day read as wrong
    // prices until the next one (user, 2026-11-13, after Best Buy and Walmart
    // showed it). So the stores whose prices this run changed are read again
    // now — health-refresh takes their snapshot on its own, nothing waits for it.
    const snapshot = totals.set || totals.back ? sites.filter((_, i) => work[i].length > 0).map((site) => site.key) : [];
    if (snapshot.length) await askSnapshot(snapshot);

    const report = { at: new Date().toISOString(), ...plan, ...totals, ...(snapshot.length ? { snapshot } : {}), by: actor?.actor_name ?? (viaCron ? "cron" : "service role") };
    await admin.from("app_settings").upsert({ key: RUN_KEY, value: report, updated_at: report.at }, { onConflict: "key" });
    // The Activity Log hears what changed, and a refusal the first time only.
    if (totals.set || totals.back || totals.new_failures) {
      const s = (n: number) => (n === 1 ? "" : "s");
      const { error: logErr } = await admin.from("audit_log").insert({
        action: "push", entity_type: "promotion", entity_id: "sinksdirect", target: "wix", ...(actor ?? {}),
        summary: `Sinks Direct deals: ${totals.set} price${s(totals.set)} put on the stores, ${totals.back} back at ${totals.back === 1 ? "its" : "their"} regular price` +
          `${totals.owed ? `, ${totals.owed} left for the next run` : ""}${totals.failed ? `, ${totals.failed} failed` : ""}`,
        metadata: report,
      });
      if (logErr) console.error("[sinksdirect-deals] activity log failed:", logErr.message);
    }
    return json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sinksdirect-deals] FAILED:", message);
    if (locked) await admin.from("app_settings").upsert({ key: LOCK_KEY, value: { until: null }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    return json({ error: message }, 500);
  }
});
