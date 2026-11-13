// Flash deals, MK events and peak season events on the marketplaces the PIM is
// connected to — Best Buy Canada, Walmart Canada, Walmart USA (user,
// 2026-11-13: "Haz que se haga eso con todos los que tengamos conexión": the
// deal's price goes on the day it starts and comes off when it ends, as on the
// Sinks Direct stores). Until then only the monthly promotion reached them by
// itself, and no deal had ever been sent to either through the API.
//
// Every run works out which deal price each product should carry on each
// channel TODAY — the very expected price Price Alignment shows (_shared/
// priceAlignmentReport.js: a deal running by its dates with that channel among
// its portals, the later start winning, its members of that country with a
// price) — and changes only what differs from what is there. A deal starting,
// ending, ended early or deleted, a product leaving its list, a new price or
// new dates all take the same path. Table channel_deal_prices holds what the
// PIM put on each channel.
//
//   Best Buy     an offer holds ONE discount. The deal's goes on for its days
//                (it takes the monthly promotion's place); when the deal is
//                over the monthly promotion's discount is sent again for the
//                products in the one running. The live offers are read every
//                run, so a discount something else sent over is put back.
//   Walmart      a SKU cannot hold two promotions on the same days. The deal
//                is carved out of what is there (_shared/walmartPromoPlan.js):
//                what touches its days is deleted, the deal's promotion is
//                created, and the rest of a deleted promotion is created again
//                after it — so Walmart goes back to the monthly price by
//                itself. A product already at the deal's price is left alone.
//                Canada goes by the PRICE_AND_PROMOTION feed (Delete, then
//                Create), the USA by one call per product.
//
// Left out, each named in the report: a product switched off for the channel,
// not listed there, without a regular price, or whose deal price is not under
// it. Honours the promotion automation switches in Settings (enabled, and the
// channel's own: bestbuy, walmart_ca, walmart_us).
//
// Auth: x-cron-secret (cron channel-deals, every 10 minutes), a service-role
// bearer, or a signed-in admin / editor. Body:
//   { dryRun: true, asOf?: "YYYY-MM-DD" }   the plan, nothing sent or written
//   { channels?: ["bestbuy"], limit?: 3 }   a part of the work (tests)
//   { force: true }                         do not wait for what was sent or refused
// The last run's report is app_settings.channel_deals_run.
// Shared files to upload with it: promoCalendar.ts, serviceRole.ts,
// exclusions.ts, bestbuyDiscount.ts, walmartPromoPlan.js,
// priceAlignmentReport.js (and what it imports: pageStores.js,
// homeDepotCaNlp.js, priceTolerance.js).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { etToday } from "../_shared/promoCalendar.ts";
import { isServiceRole } from "../_shared/serviceRole.ts";
import { excludedSet } from "../_shared/exclusions.ts";
import { bbDiscount, discountRunning } from "../_shared/bestbuyDiscount.ts";
import { createPriceAlignment, alignTargets } from "../_shared/priceAlignmentReport.js";
import { planDeal, planBack, readWalmartPromos, LEAD_MS } from "../_shared/walmartPromoPlan.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CHANNELS = ["bestbuy", "walmart_ca", "walmart_us"] as const;
type Channel = typeof CHANNELS[number];
const LABEL: Record<Channel, string> = { bestbuy: "Best Buy", walmart_ca: "Walmart Canada", walmart_us: "Walmart USA" };
const DEAL_KINDS = ["flash", "mk_event", "special"];
const TABLE = "channel_deal_prices";
const RUN_KEY = "channel_deals_run";
const LOCK_KEY = "channel_deals_lock";

const RUN_BUDGET_MS = 110_000;
const WM_SKUS_PER_RUN = 40;            // each one is a read of its promotions on Walmart
const WM_FEED_WAIT_MS = 36_000;        // how long a run waits for a Walmart Canada feed
const SENT_WAIT_MS = 15 * 60_000;      // a change sent is looked at again after this
const RETRY_FIRST_MS = 20 * 60_000;
const RETRY_MAX_MS = 12 * 3600_000;
const RECHECK_MS = 24 * 3600_000;      // a Walmart price on record is read again once a day
const MAX_LIST = 30;

const MIRAKL_BASE = "https://marketplace.bestbuy.ca";
const WM_BASE = "https://marketplace.walmartapis.com";
const CA_FEED_VERSION = "5.0.20250801-18_47_55";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const same = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) < 0.005;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// A local Eastern-time wall clock ("2026-10-01", "00:00:00") as a UTC instant, DST-aware.
function etInstant(day: string, time: string): number {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  for (const off of ["-04:00", "-05:00"]) {
    const d = new Date(`${day}T${time}${off}`);
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    const hh = p.hour === "24" ? "00" : p.hour;
    if (`${p.year}-${p.month}-${p.day}` === day && `${hh}:${p.minute}:${p.second}` === time) return d.getTime();
  }
  return new Date(`${day}T${time}-05:00`).getTime();
}
// The Pacific calendar day a Mirakl discount ends on (Best Buy keeps whole Pacific days).
const pacificDay = (v: unknown): string | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t - 1000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) : null;
};

const admin = createClient(SUPABASE_URL, SERVICE_KEY);
function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

type Row = {
  channel: Channel; sku: string; promotion_id: number | null; price: number; ends_on: string; mode: "discount" | "created" | "found";
  live_start: string | null; live_end: string | null; pending: Segment[] | null; confirmed: boolean; applied_at: string; checked_at: string | null;
  attempts: number; last_error: string | null; next_try_at: string | null;
};
type Segment = { what: string; price: number; start: number; end: number };
type Deal = { price: number; base: number; id: number | null; name: string; start: string; end: string };
type Monthly = { price: number; start: string; end: string };
type Skip = { sku: string; deal: string; reason: string };
type Totals = { set: number; back: number; failed: number; new_failures: number; owed: number; errors: string[] };
type Line = Record<string, unknown>;

const waits = (row: Row | null | undefined, force: boolean) => !force && row?.next_try_at != null && Date.parse(row.next_try_at) > Date.now();
const backoff = (attempts: number) => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, attempts - 1));

async function saveRow(channel: Channel, sku: string, fields: Partial<Row>) {
  must(await admin.from(TABLE).upsert({ channel, sku, ...fields }, { onConflict: "channel,sku" }), "Save the deal price");
}
async function dropRow(channel: Channel, sku: string) {
  must(await admin.from(TABLE).delete().eq("channel", channel).eq("sku", sku), "Clear the deal price");
}
async function refused(channel: Channel, sku: string, row: Row | null, message: string, totals: Totals) {
  const attempts = (row?.attempts ?? 0) + 1;
  await admin.from(TABLE).update({ attempts, last_error: message.slice(0, 300), next_try_at: new Date(Date.now() + backoff(attempts)).toISOString() }).eq("channel", channel).eq("sku", sku);
  totals.failed += 1;
  if (attempts <= 1) totals.new_failures += 1;
  if (totals.errors.length < MAX_LIST) totals.errors.push(`${LABEL[channel]} ${sku}: ${message}`.slice(0, 260));
}

/** What a channel should carry today, from the PIM: the deals' products and the monthly promotion's. */
async function expected(channel: Channel, today: string, prices: ReturnType<typeof createPriceAlignment>, rows: Map<string, Row>) {
  const cfg = (alignTargets({}) as Record<string, Record<string, unknown>>)[channel];
  const { baseBySku, promoBySku } = await prices.loadExpectedPrices(cfg, { today });
  const deals = new Map<string, Deal>();
  const monthly = new Map<string, Monthly>();
  const skipped: Skip[] = [];
  const names = new Set<string>();
  const candidates: [string, { price: unknown; kind: string; name?: string; id?: number; windowStart: string; windowEnd: string }][] = [...promoBySku];
  const off = await excludedSet(admin, [...new Set([...candidates.map(([sku]) => sku), ...rows.keys()])], channel);
  for (const [sku, p] of candidates) {
    const price = num(p.price);
    const base = num(baseBySku.get(sku));
    if (price == null || price <= 0) continue;
    if (p.kind === "monthly") {
      if (base != null && price < base && !off.has(sku)) monthly.set(sku, { price, start: p.windowStart, end: p.windowEnd });
      continue;
    }
    const deal = p.name ?? "?";
    names.add(deal);
    if (off.has(sku)) { skipped.push({ sku, deal, reason: `switched off for ${LABEL[channel]}` }); continue; }
    if (base == null) { skipped.push({ sku, deal, reason: "no regular price in the PIM" }); continue; }
    if (price >= base) { skipped.push({ sku, deal, reason: `the deal's price (${price}) is not under the regular price (${base})` }); continue; }
    deals.set(sku, { price, base, id: p.id ?? null, name: deal, start: p.windowStart, end: p.windowEnd });
  }
  return { deals, monthly, baseBySku: baseBySku as Map<string, unknown>, skipped, names: [...names] };
}

// ============================== Best Buy ==============================

type Offer = { price: number | null; quantity: number; discount: Record<string, unknown> | null };
async function readOffers(key: string): Promise<Map<string, Offer>> {
  const live = new Map<string, Offer>();
  let offset = 0;
  for (;;) {
    let res: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(`${MIRAKL_BASE}/api/offers?max=100&offset=${offset}`, { headers: { Authorization: key, Accept: "application/json" } });
      if (res.status !== 429) break;
      await sleep(4000 * (attempt + 1));
    }
    if (!res || !res.ok) throw new Error(`Best Buy's offers could not be read (${res?.status ?? "no answer"}) — nothing was sent to Best Buy`);
    const data = await res.json();
    for (const o of data.offers ?? []) live.set(o.shop_sku, { price: o.price ?? null, quantity: o.quantity ?? 0, discount: o.discount ?? null });
    offset += 100;
    if (!data.offers?.length || offset >= (data.total_count ?? 0)) break;
  }
  return live;
}
const discountPrice = (d: Record<string, unknown> | null) =>
  !d ? null : typeof d.discount_price === "number" ? d.discount_price : num((d.ranges as { price?: unknown }[] | undefined)?.[0]?.price);
// The offer's own price: while a discount runs Mirakl's `price` is the discounted one.
const offerPrice = (o: Offer) => num(o.discount?.origin_price) ?? o.price;
/** Does the offer carry this discount (price and last day), still to end? */
function hasDiscount(o: Offer, price: number, end: string) {
  const d = o.discount;
  if (!d) return false;
  const ends = typeof d.end_date === "string" ? Date.parse(d.end_date) : NaN;
  return same(discountPrice(d), price) && pacificDay(d.end_date) === end && (!Number.isFinite(ends) || ends > Date.now());
}

type BbJob =
  | { kind: "set"; sku: string; row: Row | null; line: Line; deal: Deal; why: string }
  | { kind: "back"; sku: string; row: Row; line: Line; to: number | null };

async function planBestBuy(today: string, force: boolean, prices: ReturnType<typeof createPriceAlignment>, rows: Map<string, Row>) {
  const key = Deno.env.get("BESTBUY_API_KEY");
  if (!key) throw new Error("BESTBUY_API_KEY is not set");
  const e = await expected("bestbuy", today, prices, rows);
  const offers = await readOffers(key);
  const out = {
    jobs: [] as BbJob[], adopt: [] as { sku: string; fields: Partial<Row> }[], drop: [] as string[], skipped: e.skipped, running: e.names, wanted: 0, on: 0, waiting: 0, key,
    // how Best Buy writes a discount today, and how many offers carry the monthly promotion's (a check of the reading)
    sample: [...offers].filter(([, o]) => o.discount).slice(0, 2).map(([sku, o]) => ({ sku, price: o.price, discount: o.discount, ends: pacificDay(o.discount?.end_date) })),
    monthly_on: [...e.monthly].filter(([sku, m]) => { const o = offers.get(sku); return o ? hasDiscount(o, m.price, m.end) : false; }).length,
    monthly_members: [...e.monthly].filter(([sku]) => offers.has(sku)).length,
  };
  const line = (sku: string, o: Offer, base: number | null, discount: Record<string, unknown> | null): Line => ({
    shop_sku: sku, update_delete: "update", price: base ?? offerPrice(o), quantity: o.quantity, ...(discount ? { discount } : {}),
  });

  // What is over goes first.
  for (const [sku, row] of rows) {
    if (e.deals.has(sku)) continue;
    const o = offers.get(sku);
    if (!o) { out.drop.push(sku); continue; }
    const m = e.monthly.get(sku);
    const base = num(e.baseBySku.get(sku));
    if (m) {
      // Back to the monthly promotion's discount, for what is left of its days.
      if (hasDiscount(o, m.price, m.end)) { out.drop.push(sku); continue; }
      if (waits(row, force)) { out.waiting += 1; continue; }
      out.jobs.push({ kind: "back", sku, row, to: m.price, line: line(sku, o, base, bbDiscount(m.price, m.start, m.end)) });
    } else if (row.mode === "discount" && discountRunning(o.discount) && same(discountPrice(o.discount), num(row.price))) {
      // Ended early (or the product left the list): the deal's discount is still on.
      // (One the PIM only found at that price — mode "found" — is never taken off.)
      if (waits(row, force)) { out.waiting += 1; continue; }
      out.jobs.push({ kind: "back", sku, row, to: null, line: line(sku, o, base, null) });
    } else out.drop.push(sku);
  }
  for (const [sku, d] of e.deals) {
    const o = offers.get(sku);
    if (!o) { out.skipped.push({ sku, deal: d.name, reason: "no offer on Best Buy" }); continue; }
    out.wanted += 1;
    const row = rows.get(sku) ?? null;
    if (hasDiscount(o, d.price, d.end)) {
      out.on += 1;
      if (!row || !row.confirmed || row.promotion_id !== d.id || !same(num(row.price), d.price) || row.ends_on !== d.end) {
        out.adopt.push({ sku, fields: { promotion_id: d.id, price: d.price, ends_on: d.end, mode: "discount", confirmed: true, checked_at: new Date().toISOString(), attempts: 0, last_error: null, next_try_at: null, pending: null } });
      }
      continue;
    }
    if (discountRunning(o.discount) && same(discountPrice(o.discount), d.price)) {
      // Already sells at the deal's price today under another discount (the monthly
      // promotion at the same price): left as it is — replacing it would only cut its
      // days short. If that discount ends before the deal does, a later run sends the deal's.
      out.on += 1;
      if (!row || !row.confirmed || row.promotion_id !== d.id || !same(num(row.price), d.price) || row.ends_on !== d.end) {
        out.adopt.push({ sku, fields: { promotion_id: d.id, price: d.price, ends_on: d.end, mode: row?.mode === "discount" ? "discount" : "found", confirmed: true, checked_at: new Date().toISOString(), attempts: 0, last_error: null, next_try_at: null, pending: null } });
      }
      continue;
    }
    if (waits(row, force)) { out.waiting += 1; continue; }
    const why = !row ? "the deal runs today" : !same(num(row.price), d.price) ? "the deal's price changed" : row.ends_on !== d.end ? "the deal's last day changed" : row.confirmed ? "another discount went over it" : "not on Best Buy yet";
    out.jobs.push({ kind: "set", sku, row, deal: d, why, line: line(sku, o, d.base, bbDiscount(d.price, d.start, d.end)) });
  }
  return out;
}

async function runBestBuy(plan: Awaited<ReturnType<typeof planBestBuy>>, jobs: BbJob[], totals: Totals) {
  // On record first: whatever happens next, the deal's discount is known here.
  const sentAt = new Date().toISOString();
  for (const j of jobs) {
    // Sent before and still not there: one more try, a little later each time.
    const attempts = j.row && !j.row.confirmed ? (j.row.attempts ?? 0) + 1 : j.kind === "back" ? (j.row.attempts ?? 0) + 1 : 0;
    const wait = new Date(Date.now() + (attempts > 1 ? backoff(attempts - 1) : SENT_WAIT_MS)).toISOString();
    if (j.kind === "set") {
      await saveRow("bestbuy", j.sku, { promotion_id: j.deal.id, price: j.deal.price, ends_on: j.deal.end, mode: "discount", confirmed: false, applied_at: sentAt, attempts, next_try_at: wait, pending: null });
    } else {
      await admin.from(TABLE).update({ attempts, next_try_at: wait }).eq("channel", "bestbuy").eq("sku", j.sku);
    }
  }
  const submit = await fetch(`${MIRAKL_BASE}/api/offers`, {
    method: "POST",
    headers: { Authorization: plan.key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ offers: jobs.map((j) => j.line) }),
  });
  const body = await submit.json().catch(() => ({}));
  if (!submit.ok || !body.import_id) {
    const message = `Best Buy refused the import (${submit.status}): ${JSON.stringify(body).slice(0, 160)}`;
    for (const j of jobs) await refused("bestbuy", j.sku, j.row, message, totals);
    return { import_id: null, error: message };
  }
  let status = "WAITING";
  let inError = 0;
  for (let i = 0; i < 9; i++) {
    await sleep(2000);
    const chk = await fetch(`${MIRAKL_BASE}/api/offers/imports/${body.import_id}`, { headers: { Authorization: plan.key, Accept: "application/json" } });
    if (!chk.ok) continue;
    const st = await chk.json();
    status = String(st.status ?? status);
    inError = st.lines_in_error ?? inError;
    if (status === "COMPLETE" || status === "FAILED") break;
  }
  let errorReport: string | null = null;
  if (inError > 0) {
    const rep = await fetch(`${MIRAKL_BASE}/api/offers/imports/${body.import_id}/error_report`, { headers: { Authorization: plan.key } });
    if (rep.ok) errorReport = (await rep.text()).slice(0, 800);
    if (totals.errors.length < MAX_LIST) totals.errors.push(`Best Buy import ${body.import_id}: ${inError} line${inError === 1 ? "" : "s"} refused — ${errorReport ?? "no report"}`.slice(0, 400));
  }
  // What Best Buy took is known at the next run, which reads the offers again:
  // a deal's row is confirmed there, a product that went back is dropped there.
  totals.set += jobs.filter((j) => j.kind === "set").length;
  totals.back += jobs.filter((j) => j.kind === "back").length;
  if (inError > 0) { totals.failed += inError; totals.new_failures += inError; }
  return { import_id: body.import_id, status, lines: jobs.length, lines_in_error: inError };
}

// ============================== Walmart ==============================

const WM: Record<"ca" | "us", { channel: Channel; wmMarket: string | null; cid: string; sec: string; alias: string; snapshot: string; currency: string }> = {
  ca: { channel: "walmart_ca", wmMarket: "ca", cid: "WALMART_CA_CLIENT_ID", sec: "WALMART_CA_CLIENT_SECRET", alias: "Walmart CA", snapshot: "walmart_ca", currency: "CAD" },
  us: { channel: "walmart_us", wmMarket: null, cid: "WALMART_US_PROD_CLIENT_ID", sec: "WALMART_US_PROD_CLIENT_SECRET", alias: "Walmart US", snapshot: "walmart_us", currency: "USD" },
};
const wmHeaders = (extra: Record<string, string>, wmMarket: string | null) =>
  ({ "WM_SVC.NAME": "Walmart Marketplace", "WM_QOS.CORRELATION_ID": crypto.randomUUID(), Accept: "application/json", ...(wmMarket ? { WM_MARKET: wmMarket } : {}), ...extra });

async function wmToken(market: "ca" | "us"): Promise<string> {
  const cfg = WM[market];
  const cid = Deno.env.get(cfg.cid);
  const sec = Deno.env.get(cfg.sec);
  if (!cid || !sec) throw new Error(`${LABEL[cfg.channel]}'s keys are not set`);
  const res = await fetch(`${WM_BASE}/v3/token`, {
    method: "POST",
    headers: wmHeaders({ Authorization: `Basic ${btoa(`${cid}:${sec}`)}`, "Content-Type": "application/x-www-form-urlencoded" }, cfg.wmMarket),
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Walmart token ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).access_token;
}

/** The promotions Walmart holds for a SKU right now (none = an empty list). */
async function wmPromos(market: "ca" | "us", token: string, wsku: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${WM_BASE}/v3/promo/sku/${encodeURIComponent(wsku)}`, { headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": token }, WM[market].wmMarket) });
    if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
    const text = await res.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (res.status === 404) return [];
    if (!res.ok || data == null) throw new Error(`Walmart could not read the promotions of ${wsku} (${res.status}): ${text.slice(0, 120)}`);
    return readWalmartPromos(data);
  }
  throw new Error(`Walmart asked to slow down reading ${wsku}`);
}

type WmOp = {
  kind: "set" | "back"; sku: string; wsku: string; row: Row | null; base: number | null; deal?: Deal & { endMs: number };
  deletes: { price: number; regular: number | null; start: number; end: number }[]; creates: Segment[]; carrier: { start: number; end: number } | null; why: string;
};
type WmCandidate = { kind: "set" | "back"; sku: string; row: Row | null; why: string };

async function planWalmart(market: "ca" | "us", today: string, force: boolean, prices: ReturnType<typeof createPriceAlignment>, rows: Map<string, Row>, now: number) {
  const cfg = WM[market];
  const e = await expected(cfg.channel, today, prices, rows);
  const skus = [...new Set([...e.deals.keys(), ...rows.keys()])];
  const out = { candidates: [] as WmCandidate[], skipped: e.skipped, running: e.names, wanted: 0, on: 0, waiting: 0, e, wsku: new Map<string, string>() };
  if (!skus.length) return out;
  // Listed on this Walmart = in its latest items snapshot, under our SKU or its alias there.
  const snap = must(await admin.from("channel_health").select("results").eq("channel", cfg.snapshot).order("run_at", { ascending: false }).limit(1).maybeSingle(), "Read Walmart's items");
  const listed = snap?.results ? new Set((snap.results as { sku: string }[]).map((r) => r.sku)) : null;
  for (const part of chunk(skus, 200)) {
    for (const a of must(await admin.from("product_aliases").select("alias, sku").eq("marketplace", cfg.alias).in("sku", part), "Read the Walmart SKUs") as { alias: string; sku: string }[]) out.wsku.set(a.sku, a.alias);
  }
  for (const [sku, d] of [...e.deals]) {
    const wsku = out.wsku.get(sku) ?? sku;
    if (listed && !listed.has(sku) && !listed.has(wsku)) { out.skipped.push({ sku, deal: d.name, reason: `not listed on ${LABEL[cfg.channel]}` }); e.deals.delete(sku); }
  }
  for (const [sku, row] of rows) {
    if (e.deals.has(sku)) continue;
    if (waits(row, force)) { out.waiting += 1; continue; }
    out.candidates.push({ kind: "back", sku, row, why: "its deal is over" });
  }
  const order: WmCandidate[][] = [[], [], [], []];
  for (const [sku, d] of e.deals) {
    out.wanted += 1;
    const row = rows.get(sku) ?? null;
    const changed = row && (!same(num(row.price), d.price) || row.ends_on !== d.end);
    const expired = row?.live_end != null && Date.parse(row.live_end) <= now;
    const stale = row != null && (!row.checked_at || now - Date.parse(row.checked_at) > RECHECK_MS);
    const why = !row ? "the deal runs today" : changed ? "the deal changed" : !row.confirmed ? "not on Walmart yet" : expired ? "the promotion that gave its price ended" : stale ? "read again (once a day)" : null;
    if (!why) { out.on += 1; continue; }
    if (waits(row, force)) { out.waiting += 1; continue; }
    order[!row ? 0 : changed || !row.confirmed ? 1 : expired ? 2 : 3].push({ kind: "set", sku, row, why });
  }
  out.candidates.push(...order.flat());
  return out;
}

/** Read what Walmart holds for each candidate and work out what to delete and create. */
async function walmartOps(market: "ca" | "us", token: string, plan: Awaited<ReturnType<typeof planWalmart>>, take: WmCandidate[], now: number, dryRun: boolean, totals: Totals) {
  const cfg = WM[market];
  const ops: WmOp[] = [];
  const settled = { on: 0, back: 0 };
  for (const c of take) {
    const wsku = plan.wsku.get(c.sku) ?? c.sku;
    let promos: ReturnType<typeof readWalmartPromos>;
    try {
      promos = await wmPromos(market, token, wsku);
    } catch (err) {
      if (!dryRun && c.row) await refused(cfg.channel, c.sku, c.row, (err as Error).message, totals);
      else if (totals.errors.length < MAX_LIST) totals.errors.push(`${LABEL[cfg.channel]} ${c.sku}: ${(err as Error).message}`.slice(0, 260));
      continue;
    }
    const base = num(plan.e.baseBySku.get(c.sku));
    const checked = new Date(now).toISOString();
    if (c.kind === "set") {
      const d = plan.e.deals.get(c.sku)!;
      const endMs = etInstant(d.end, "23:59:59");
      // What a run before this one left to create, once nothing is in its way.
      const pending = (c.row?.pending ?? []).filter((s) => s.end > now + LEAD_MS).map((s) => (s.start < now + LEAD_MS ? { ...s, start: now + LEAD_MS } : s));
      const inTheWay = pending.length ? promos.filter((p) => pending.some((s) => p.end > s.start && p.start < s.end)) : [];
      const p = pending.length && !inTheWay.length && same(pending[0].price, d.price) && pending[0].what === "deal"
        ? { state: "change", deletes: [], creates: pending, carrier: { start: pending[0].start, end: pending[0].end } }
        : planDeal({ promos, price: d.price, end: endMs, now });
      if (p.state === "over") continue;
      if (p.state === "ok") {
        // Already at the deal's price. A promotion that ends with the deal is the deal's own (sent by hand,
        // or by a run cut short): taken off if the deal ends early. Any other one is only found.
        const own = c.row?.mode === "created" || Math.abs(p.carrier!.end - endMs) < 24 * 3600_000;
        if (!dryRun) await saveRow(cfg.channel, c.sku, { promotion_id: d.id, price: d.price, ends_on: d.end, mode: own ? "created" : "found", live_start: iso(p.carrier!.start), live_end: iso(p.carrier!.end), pending: null, confirmed: true, checked_at: checked, attempts: 0, last_error: null, next_try_at: null });
        settled.on += 1;
        continue;
      }
      ops.push({ kind: "set", sku: c.sku, wsku, row: c.row, base, deal: { ...d, endMs }, deletes: p.deletes, creates: p.creates as Segment[], carrier: p.carrier, why: c.why });
    } else {
      const row = c.row!;
      const m = plan.e.monthly.get(c.sku);
      const p = planBack({ promos, row: { mode: row.mode, price: num(row.price), live_end: row.live_end ? Date.parse(row.live_end) : null }, monthly: m ? { price: m.price, end: etInstant(m.end, "23:59:59") } : null, now });
      if (!p.deletes.length && !p.creates.length) {
        if (!dryRun) await dropRow(cfg.channel, c.sku);
        settled.back += 1;
        continue;
      }
      ops.push({ kind: "back", sku: c.sku, wsku, row, base, deletes: p.deletes, creates: p.creates as Segment[], carrier: null, why: c.why });
    }
    await sleep(120);
  }
  return { ops, settled };
}

// ---- Walmart Canada: the PRICE_AND_PROMOTION feed ----
const caLine = (wsku: string, regular: number | null, action: "Create" | "Delete", price: number, start: number, end: number): Line => ({
  Price: {
    sku: wsku,
    price: regular,
    promotionInformation: { promotionSettingAction: action, promotionType: "Reduced", promotionPrice: price, promotionPriceStartDateTime: iso(start), promotionPriceEndDateTime: iso(end) },
  },
});
/** Send one feed and wait a little for it: per Walmart SKU, "ok" | "failed: why" | "processing". */
async function caFeed(token: string, lines: Line[], waitMs: number): Promise<{ feedId: string | null; error: string | null; of: (wsku: string) => string }> {
  const payload = {
    MPItemFeedHeader: { subCategory: "price-mp", mart: "WALMART_CA", feedType: "PRICE_AND_PROMOTION", processMode: "REPLACE", locale: ["en", "fr"], version: CA_FEED_VERSION, subset: "EXTERNAL", tenant: "WALMART_CA" },
    MPItem: lines,
  };
  const res = await fetch(`${WM_BASE}/v3/feeds?feedType=PRICE_AND_PROMOTION`, {
    method: "POST",
    headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": token, "Content-Type": "application/json" }, "ca"),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let feedId: string | null = null;
  try { feedId = JSON.parse(text).feedId ?? null; } catch { /* keep null */ }
  if (!res.ok || !feedId) {
    const error = `Walmart Canada refused the feed (${res.status}): ${text.slice(0, 200)}`;
    return { feedId: null, error, of: () => `failed: ${error}` };
  }
  const failed = new Map<string, string>();
  const seen = new Set<string>();
  let done = false;
  let whole: string | null = null;
  let unnamed = false; // Walmart counts failures it does not name: nothing is taken for a success
  const until = Date.now() + waitMs;
  while (Date.now() < until && !done) {
    await sleep(6000);
    failed.clear();
    seen.clear();
    let offset = 0;
    let total = 0;
    let status = "";
    for (let page = 0; page < 10; page++) {
      const r = await fetch(`${WM_BASE}/v3/feeds/${encodeURIComponent(feedId)}?includeDetails=true&limit=50&offset=${offset}`, { headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": token }, "ca") });
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      status = String(d.feedStatus ?? "");
      total = Number(d.itemsReceived ?? 0);
      unnamed = Number(d.itemsFailed ?? 0) > 0;
      const items = ((d.itemDetails?.itemIngestionStatus ?? []) as Record<string, unknown>[]);
      for (const it of items) {
        const sku = String(it.sku ?? "");
        if (!sku) continue;
        seen.add(sku);
        if (it.ingestionStatus !== "SUCCESS" && it.ingestionStatus !== "INPROGRESS") {
          const errs = ((it.ingestionErrors as Record<string, unknown>)?.ingestionError ?? []) as Record<string, unknown>[];
          failed.set(sku, String(errs.map((x) => x.description ?? x.code).join(" · ") || it.ingestionStatus).slice(0, 200));
        }
      }
      if (status === "ERROR") whole = `Walmart Canada rejected the whole feed ${feedId}`;
      offset += 50;
      if (items.length < 50 || offset >= total) break;
    }
    done = status === "PROCESSED" || status === "ERROR";
  }
  return {
    feedId,
    error: whole,
    of: (wsku) => (whole ? `failed: ${whole}` : failed.has(wsku) ? `failed: ${failed.get(wsku)}` : done && seen.has(wsku) && !(unnamed && !failed.size) ? "ok" : "processing"),
  };
}

// ---- Walmart USA: one call per product and promotion ----
async function usPromo(token: string, wsku: string, mode: "UPSERT" | "DELETE", price: number, regular: number | null, start: number, end: number): Promise<string> {
  const body = {
    sku: wsku,
    pricing: [{
      currentPriceType: "REDUCED", currentPrice: { currency: "USD", amount: price },
      ...(regular != null ? { comparisonPriceType: "BASE", comparisonPrice: { currency: "USD", amount: regular } } : {}),
      effectiveDate: iso(start), expirationDate: iso(end), processMode: mode,
    }],
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${WM_BASE}/v3/price?promo=true`, {
      method: "PUT",
      headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": token, "Content-Type": "application/json" }, null),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
    if (res.ok) return "ok";
    let detail = text.slice(0, 200);
    try {
      const errs = (JSON.parse(text).errors ?? []) as Record<string, unknown>[];
      if (errs.length) detail = errs.map((x) => String(x.description || x.info || x.code)).join(" · ").slice(0, 200);
    } catch { /* keep the text */ }
    return `failed: HTTP ${res.status}: ${detail}`;
  }
  return "failed: Walmart asked to slow down (429)";
}

async function runWalmart(market: "ca" | "us", token: string, ops: WmOp[], deadline: number, totals: Totals) {
  const cfg = WM[market];
  const now = new Date().toISOString();
  const soon = new Date(Date.now() + SENT_WAIT_MS).toISOString();
  // On record first.
  for (const op of ops) {
    if (op.kind === "set") {
      await saveRow(cfg.channel, op.sku, {
        promotion_id: op.deal!.id, price: op.deal!.price, ends_on: op.deal!.end, mode: "created",
        live_start: iso(op.carrier!.start), live_end: iso(op.carrier!.end), pending: op.creates, confirmed: false, applied_at: now, next_try_at: soon,
      });
    } else {
      await admin.from(TABLE).update({ next_try_at: soon }).eq("channel", cfg.channel).eq("sku", op.sku);
    }
  }
  const state = new Map<string, "go" | "wait" | "failed">(ops.map((op) => [op.sku, "go"]));
  const fail = async (op: WmOp, message: string) => { state.set(op.sku, "failed"); await refused(cfg.channel, op.sku, op.row ?? ({ attempts: 0 } as Row), message, totals); };

  // 1. What is in the way comes off.
  const withDeletes = ops.filter((op) => op.deletes.length);
  if (withDeletes.length) {
    if (market === "ca") {
      const lines = withDeletes.flatMap((op) => op.deletes.map((p) => caLine(op.wsku, p.regular ?? op.base, "Delete", p.price, p.start, p.end)));
      const feed = await caFeed(token, lines, Math.min(WM_FEED_WAIT_MS, Math.max(8000, deadline - Date.now() - 45_000)));
      for (const op of withDeletes) {
        const r = feed.of(op.wsku);
        if (r === "processing") state.set(op.sku, "wait");
        else if (r !== "ok") await fail(op, `the promotion in its way could not be taken off — ${r.slice(8)}`);
      }
    } else {
      for (const op of withDeletes) {
        for (const p of op.deletes) {
          const r = await usPromo(token, op.wsku, "DELETE", p.price, p.regular ?? op.base, p.start, p.end);
          if (r !== "ok") { await fail(op, `the promotion in its way could not be taken off — ${r.slice(8)}`); break; }
          await sleep(250);
        }
      }
    }
  }
  // 2. The deal's promotion (and what is left of the monthly one after it) goes on.
  const ready = ops.filter((op) => state.get(op.sku) === "go" && op.creates.length);
  const outcome = new Map<string, string>();
  if (ready.length) {
    if (market === "ca") {
      const lines = ready.flatMap((op) => op.creates.map((s) => caLine(op.wsku, op.base, "Create", s.price, s.start, s.end)));
      const feed = await caFeed(token, lines, Math.min(WM_FEED_WAIT_MS, Math.max(8000, deadline - Date.now() - 8_000)));
      for (const op of ready) outcome.set(op.sku, feed.of(op.wsku));
    } else {
      for (const op of ready) {
        let r = "ok";
        for (const s of op.creates) {
          r = await usPromo(token, op.wsku, "UPSERT", s.price, op.base, s.start, s.end);
          if (r !== "ok") break;
          await sleep(250);
        }
        outcome.set(op.sku, r);
      }
    }
  }
  // 3. What happened, product by product.
  for (const op of ops) {
    const st = state.get(op.sku);
    if (st === "failed") continue;
    const r = st === "wait" ? "processing" : op.creates.length ? outcome.get(op.sku) ?? "processing" : "ok";
    if (r.startsWith("failed")) { await fail(op, r.slice(8)); continue; }
    if (op.kind === "set") {
      if (r === "ok") {
        await admin.from(TABLE).update({ confirmed: true, pending: null, checked_at: new Date().toISOString(), attempts: 0, last_error: null, next_try_at: null }).eq("channel", cfg.channel).eq("sku", op.sku);
        totals.set += 1;
      } else totals.owed += 1; // Walmart is still working on it: the next run reads the product again
    } else if (r === "ok") {
      await dropRow(cfg.channel, op.sku);
      totals.back += 1;
    } else totals.owed += 1;
  }
}

// ============================== the run ==============================

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
        if (!["admin", "editor"].includes(profile?.role ?? "")) return json({ error: "Only admins and editors can send deal prices to the marketplaces." }, 403);
        actor = { actor_id: user.id, actor_email: user.email ?? null, actor_name: profile?.full_name ?? user.email ?? null };
      }
    }

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun === true;
    const force = body.force === true;
    const asOf = dryRun && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf ?? "") ? String(body.asOf) : null;
    const today = asOf ?? etToday();
    // A dry run of another day stands a few minutes after its Eastern midnight.
    const now = asOf ? etInstant(asOf, "00:10:00") : Date.now();
    let channels: Channel[] = Array.isArray(body.channels) ? CHANNELS.filter((c) => body.channels.includes(c)) : [...CHANNELS];
    const limit = Number.isInteger(body.limit) && body.limit > 0 ? Number(body.limit) : null;

    const { data: setting } = await admin.from("app_settings").select("value").eq("key", "promo_automation").maybeSingle();
    const switches = (setting?.value ?? {}) as Record<string, unknown>;
    const off = channels.filter((c) => switches.enabled === false || switches[c] === false);
    if (!dryRun) channels = channels.filter((c) => !off.includes(c));
    if (!channels.length) return json({ today, skipped: "The promotion automation is off in Settings for these marketplaces." });

    // Nothing on the channels and no deal for them: most runs end here.
    const [onChannels, anyDeal] = await Promise.all([
      admin.from(TABLE).select("sku", { count: "exact", head: true }).in("channel", channels),
      admin.from("promotions").select("id").in("kind", DEAL_KINDS).neq("status", "ended").overlaps("marketplaces", channels).limit(1),
    ]);
    if (onChannels.error) throw new Error(`Read the deal prices on the marketplaces: ${onChannels.error.message}`);
    if (!onChannels.count && !(must(anyDeal, "Read the deals") as unknown[]).length) return json({ today, nothing_to_do: true, owed: 0 });

    const memo = new Map<string, Promise<unknown>>();
    const sharedLoad = (key: string, loader: () => Promise<unknown>) => {
      if (!memo.has(key)) memo.set(key, loader());
      return memo.get(key);
    };
    const prices = createPriceAlignment({ db: admin, sharedLoad });
    const rowsOf = new Map<Channel, Map<string, Row>>(CHANNELS.map((c) => [c, new Map()]));
    for (let from = 0; ; from += 1000) {
      const page = must(await admin.from(TABLE).select("*").in("channel", channels).order("channel").order("sku").range(from, from + 999), "Read the deal prices on the marketplaces") as Row[];
      for (const r of page) rowsOf.get(r.channel)!.set(r.sku, r);
      if (page.length < 1000) break;
    }

    // One run at a time (a dry run only reads, so it never waits).
    if (!dryRun) {
      const { data: lock } = await admin.from("app_settings").select("value").eq("key", LOCK_KEY).maybeSingle();
      const until = (lock?.value as { until?: string | null } | null)?.until;
      if (until && Date.parse(until) > Date.now()) return json({ today, busy: true });
      await admin.from("app_settings").upsert({ key: LOCK_KEY, value: { until: new Date(Date.now() + RUN_BUDGET_MS + 40_000).toISOString() }, updated_at: new Date().toISOString() }, { onConflict: "key" });
      locked = true;
    }
    const deadline = Date.now() + RUN_BUDGET_MS;
    const totals: Totals = { set: 0, back: 0, failed: 0, new_failures: 0, owed: 0, errors: [] };
    const report: Record<string, unknown> = {};
    const lines: Record<string, unknown>[] = [];

    await Promise.all(channels.map(async (channel) => {
      try {
        if (channel === "bestbuy") {
          const plan = await planBestBuy(today, force, prices, rowsOf.get(channel)!);
          const take = limit ? plan.jobs.slice(0, limit) : plan.jobs;
          report[channel] = { deals: plan.running, products: plan.wanted, on: plan.on, to_set: plan.jobs.filter((j) => j.kind === "set").length, to_back: plan.jobs.filter((j) => j.kind === "back").length, waiting: plan.waiting, skipped: plan.skipped.slice(0, 200), ...(dryRun ? { monthly_members: plan.monthly_members, monthly_on: plan.monthly_on, sample: plan.sample } : {}) };
          for (const j of take) lines.push(j.kind === "set"
            ? { channel, action: "discount", sku: j.sku, price: j.deal.price, regular: j.deal.base, from: j.deal.start, to: j.deal.end, deal: j.deal.name, why: j.why }
            : { channel, action: j.to != null ? "monthly discount back" : "discount off", sku: j.sku, price: j.to, line: j.line });
          if (dryRun) return;
          for (const a of plan.adopt) await saveRow(channel, a.sku, a.fields);
          for (const sku of plan.drop) await dropRow(channel, sku);
          totals.owed += plan.jobs.length - take.length;
          if (take.length) (report[channel] as Record<string, unknown>).import = await runBestBuy(plan, take, totals);
        } else {
          const market = channel === "walmart_ca" ? "ca" : "us";
          const plan = await planWalmart(market, today, force, prices, rowsOf.get(channel)!, now);
          const take = plan.candidates.slice(0, limit ?? WM_SKUS_PER_RUN);
          report[channel] = { deals: plan.running, products: plan.wanted, on: plan.on, to_look_at: plan.candidates.length, waiting: plan.waiting, skipped: plan.skipped.slice(0, 200) };
          if (!take.length) return;
          const token = await wmToken(market);
          const { ops, settled } = await walmartOps(market, token, plan, take, now, dryRun, totals);
          Object.assign(report[channel] as Record<string, unknown>, { already_right: settled.on, nothing_to_take_back: settled.back, to_change: ops.length });
          for (const op of ops) lines.push({
            channel, action: op.kind === "set" ? "deal" : "back", sku: op.sku, walmart_sku: op.wsku, deal: op.deal?.name ?? null, why: op.why,
            delete: op.deletes.map((p) => ({ price: p.price, from: iso(p.start), to: iso(p.end) })),
            create: op.creates.map((s) => ({ what: s.what, price: s.price, from: iso(s.start), to: iso(s.end) })),
          });
          totals.owed += plan.candidates.length - take.length;
          if (dryRun || !ops.length) return;
          await runWalmart(market, token, ops, deadline, totals);
        }
      } catch (err) {
        // One marketplace failing does not stop the others.
        const message = err instanceof Error ? err.message : String(err);
        report[channel] = { ...(report[channel] as Record<string, unknown> ?? {}), error: message };
        if (totals.errors.length < MAX_LIST) totals.errors.push(`${LABEL[channel]}: ${message}`.slice(0, 260));
      }
    }));

    if (dryRun) return json({ dryRun: true, today, off, channels: report, lines: lines.slice(0, 400), errors: totals.errors });

    await admin.from("app_settings").upsert({ key: LOCK_KEY, value: { until: null }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    locked = false;
    const result = { at: new Date().toISOString(), today, ...totals, channels: report, by: actor?.actor_name ?? (viaCron ? "cron" : "service role") };
    await admin.from("app_settings").upsert({ key: RUN_KEY, value: result, updated_at: result.at }, { onConflict: "key" });
    // The Activity Log hears what changed, and a refusal the first time only.
    if (totals.set || totals.back || totals.new_failures) {
      const s = (n: number) => (n === 1 ? "" : "s");
      const { error: logErr } = await admin.from("audit_log").insert({
        action: "push", entity_type: "promotion", entity_id: "channel-deals", target: "marketplaces", ...(actor ?? {}),
        summary: `Deals on Best Buy and Walmart: ${totals.set} price${s(totals.set)} sent, ${totals.back} taken back` +
          `${totals.owed ? `, ${totals.owed} left for the next run` : ""}${totals.failed ? `, ${totals.failed} refused` : ""}`,
        metadata: { ...result, lines: lines.slice(0, 150) },
      });
      if (logErr) console.error("[channel-deals] activity log failed:", logErr.message);
    }
    return json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[channel-deals] FAILED:", message);
    if (locked) await admin.from("app_settings").upsert({ key: LOCK_KEY, value: { until: null }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    return json({ error: message }, 500);
  }
});
