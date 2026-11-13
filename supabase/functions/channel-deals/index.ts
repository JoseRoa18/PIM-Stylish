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
// The cron calls every 10 minutes, and most calls end after a few small reads
// of the database (user, 2026-11-13: a deal made for the 15th has nothing to
// do on the 13th, and the app must not get slow):
//   - no deal runs today on these channels, nothing is on record and no
//     snapshot is owed: four small reads (the switch, the prices on record,
//     the deals, the state);
//   - else what the PIM wants today is worked out (database only) and a channel
//     is LOOKED AT — Best Buy's offers read, Walmart's promotions — only when
//     that changed since its last look, when something on record is due (sent
//     and not seen yet, refused and to be tried again, a Walmart price to read
//     again), or when the look is LOOK_EVERY_MS old (app_settings
//     channel_deals_state: per channel, what was wanted and when to look next).
//
//   Best Buy     an offer holds ONE discount. The deal's goes on for its days
//                and takes the place of whatever the offer held — the monthly
//                promotion's, or one scheduled for later (next month's, sent
//                when its list was loaded: seen on the first real send,
//                2026-11-13). When the deal is over the monthly promotion's
//                discount is sent again for the products in the one running;
//                else the discount the offer held before (`before`) goes
//                back, if it is still to end. The live offers are read at
//                every look (half an hour apart at most), so a discount
//                something else sent over is put back.
//   Walmart      a SKU cannot hold two promotions on the same days. The deal
//                is carved out of what is there (_shared/walmartPromoPlan.js):
//                what touches its days is deleted, the deal's promotion is
//                created, and the rest of a deleted promotion is created again
//                after it — so Walmart goes back to the monthly price by
//                itself. A product already at the deal's price is left alone.
//                Canada goes by the PRICE_AND_PROMOTION feed (Delete, then
//                Create), the USA by one call per product.
//
// A change SEEN on a channel is followed by its snapshot (user, 2026-11-13:
// "hazlo ya"). Price Alignment and Listing Health do not read a marketplace
// live: they read its last snapshot (channel_health), taken twice a day by
// health-refresh or with "Run fresh analysis" — so a deal's price that went on
// at 10 am was compared with the 6 am snapshot until 1 pm (Best Buy read 62 %
// aligned with every deal price in place). See takeSnapshot.
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
//   { snapshot: ["bestbuy"] }               take that channel's snapshot in this run
// The last run's report is app_settings.channel_deals_run.
// Shared files to upload with it: promoCalendar.ts, serviceRole.ts,
// exclusions.ts, bestbuyDiscount.ts, walmartPromoPlan.js,
// priceAlignmentReport.js (and what it imports: pageStores.js,
// homeDepotCaNlp.js, priceTolerance.js).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { etToday, promoWindow, windowContains, PROMO_DATE_COLUMNS } from "../_shared/promoCalendar.ts";
import type { PromoLike } from "../_shared/promoCalendar.ts";
import { isServiceRole } from "../_shared/serviceRole.ts";
import { excludedSet } from "../_shared/exclusions.ts";
import { bbDiscount, discountRunning } from "../_shared/bestbuyDiscount.ts";
import { createPriceAlignment, alignTargets } from "../_shared/priceAlignmentReport.js";
import { planDeal, planBack, readWalmartPromos, LEAD_MS } from "../_shared/walmartPromoPlan.js";
import { priceOff } from "../_shared/priceTolerance.js";

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
const STATE_KEY = "channel_deals_state";
const MARKET: Record<Channel, "ca" | "us"> = { bestbuy: "ca", walmart_ca: "ca", walmart_us: "us" };
// With nothing new in the PIM and nothing due, a channel is looked at again this
// often. Best Buy: its offers are read, so a discount something else sent over
// the deal's is put back. Walmart: only whether a product got listed since — a
// price on record there is read again once a day (RECHECK_MS).
const LOOK_EVERY_MS: Record<Channel, number> = { bestbuy: 30 * 60_000, walmart_ca: 2 * 3600_000, walmart_us: 2 * 3600_000 };

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
// Best Buy keeps a discount's days as whole days seven hours behind UTC, all
// year: Oct 22 is stored 2026-10-22T07:00:00Z and Dec 3 is 2026-12-03T07:00:00Z
// (read on the offers, 2026-11-13) — the Pacific day in summer, an hour off it
// in winter. Read with the Pacific time zone, a December start came out a day
// early.
const BB_DAY_MS = 7 * 3600_000;
/** The day a Best Buy discount ends on. */
const pacificDay = (v: unknown): string | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t - 1000 - BB_DAY_MS).toISOString().slice(0, 10) : null;
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
  before: Held | null; // Best Buy: the discount the offer held when the deal's took its place
};
type Held = { price: number; start: string; end: string };
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
type Expected = Awaited<ReturnType<typeof expected>>;
// `photo`: the channel's snapshot is owed (a change was seen there and it could
// not be taken in that run); `photos`: how many were tried in a row for it.
type Look = { sig: string; next_at: number; photo?: boolean; photos?: number; photo_at?: string; photo_note?: string };

/** What the PIM wants on a channel today, as one short text: the same text = nothing new to do. */
async function signature(today: string, e: Expected): Promise<string> {
  const text = [
    today,
    ...[...e.deals].map(([sku, d]) => `${sku}|${d.price}|${d.base}|${d.id}|${d.start}|${d.end}`).sort(),
    "#",
    ...[...e.monthly].map(([sku, m]) => `${sku}|${m.price}|${m.start}|${m.end}`).sort(),
    "#",
    ...e.skipped.map((s) => `${s.sku}|${s.reason}`).sort(),
  ].join("\n");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// ============================== Best Buy ==============================

type Offer = { price: number | null; quantity: number; discount: Record<string, unknown> | null };
// What a look read, kept for the channel's snapshot: a second read of the offers
// right after the first is turned away by Best Buy (429, seen 2026-11-13).
type OffersRead = { total: number; offers: Record<string, unknown>[] };
/** An offer as the snapshot keeps it: bestbuy-pull-offers' own row — keep the two alike. */
// deno-lint-ignore no-explicit-any
function offerRow(o: any): Record<string, unknown> {
  const refs = Array.isArray(o.product_references) ? o.product_references : o.product_references ? [o.product_references] : [];
  const barcode = refs.find((r: { reference_type?: string }) => /UPC|EAN|GTIN/i.test(String(r?.reference_type ?? ""))) ?? refs[0];
  return {
    sku: o.shop_sku,
    bb_product_id: o.product_sku ? String(o.product_sku) : null,
    price: o.price ?? null,
    discount_price: o.discount?.discount_price ?? null,
    discount_start: o.discount?.start_date ?? null,
    discount_end: o.discount?.end_date ?? null,
    origin_price: o.discount?.origin_price ?? null,
    quantity: o.quantity ?? 0,
    active: Boolean(o.active),
    state: String(o.state_code ?? ""),
    category_code: o.category_code ?? null,
    category_label: o.category_label ?? null,
    product_title: o.product_title ?? null,
    product_brand: o.product_brand ?? null,
    upc: barcode?.reference ? String(barcode.reference) : null,
  };
}
async function readOffers(key: string): Promise<{ live: Map<string, Offer>; read: OffersRead }> {
  const live = new Map<string, Offer>();
  const read: OffersRead = { total: 0, offers: [] };
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
    read.total = data.total_count ?? 0;
    for (const o of data.offers ?? []) {
      live.set(o.shop_sku, { price: o.price ?? null, quantity: o.quantity ?? 0, discount: o.discount ?? null });
      read.offers.push(offerRow(o));
    }
    offset += 100;
    if (!data.offers?.length || offset >= (data.total_count ?? 0)) break;
  }
  return { live, read };
}
const discountPrice = (d: Record<string, unknown> | null) =>
  !d ? null : typeof d.discount_price === "number" ? d.discount_price : num((d.ranges as { price?: unknown }[] | undefined)?.[0]?.price);
// The offer's own price: while a discount runs Mirakl's `price` is the discounted one.
const offerPrice = (o: Offer) => num(o.discount?.origin_price) ?? o.price;
/** The day a Best Buy discount starts on. */
const pacificStart = (v: unknown): string | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t - BB_DAY_MS).toISOString().slice(0, 10) : null;
};
/** The discount an offer holds now, to put back later: null when it has none or it has ended. */
function heldDiscount(o: Offer): Held | null {
  const d = o.discount;
  const price = discountPrice(d);
  const start = pacificStart(d?.start_date);
  const end = pacificDay(d?.end_date);
  const ends = typeof d?.end_date === "string" ? Date.parse(d.end_date) : NaN;
  return price != null && start && end && ends > Date.now() ? { price, start, end } : null;
}
/** Does the offer carry this discount (price and last day), still to end? */
function hasDiscount(o: Offer, price: number, end: string) {
  const d = o.discount;
  if (!d) return false;
  const ends = typeof d.end_date === "string" ? Date.parse(d.end_date) : NaN;
  return same(discountPrice(d), price) && pacificDay(d.end_date) === end && (!Number.isFinite(ends) || ends > Date.now());
}

type BbJob =
  | { kind: "set"; sku: string; row: Row | null; line: Line; deal: Deal; why: string; before: Held | null }
  | { kind: "back"; sku: string; row: Row; line: Line; to: number | null };

async function planBestBuy(today: string, force: boolean, e: Expected, rows: Map<string, Row>) {
  const key = Deno.env.get("BESTBUY_API_KEY");
  if (!key) throw new Error("BESTBUY_API_KEY is not set");
  const { live: offers, read } = await readOffers(key);
  const out = {
    jobs: [] as BbJob[], adopt: [] as { sku: string; fields: Partial<Row> }[], drop: [] as string[], skipped: e.skipped, running: e.names, wanted: 0, on: 0, waiting: 0, key, read,
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
    } else if (row.before && row.before.end >= today && hasDiscount(o, row.before.price, row.before.end)) {
      out.drop.push(sku); // what it held before the deal is back already
    } else if (row.before && row.before.end >= today && (base == null || row.before.price < base)) {
      // Not in the running monthly promotion: the discount the offer held before
      // the deal (one scheduled for later) goes back as it was.
      if (waits(row, force)) { out.waiting += 1; continue; }
      out.jobs.push({ kind: "back", sku, row, to: row.before.price, line: line(sku, o, base, bbDiscount(row.before.price, row.before.start, row.before.end)) });
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
    // What the offer holds now is noted once, to put back when the deal is over
    // (never the deal's own discount, sent by a run before this one).
    const before = row ? row.before ?? null : heldDiscount(o);
    out.jobs.push({ kind: "set", sku, row, deal: d, why, before, line: line(sku, o, d.base, bbDiscount(d.price, d.start, d.end)) });
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
      await saveRow("bestbuy", j.sku, { promotion_id: j.deal.id, price: j.deal.price, ends_on: j.deal.end, mode: "discount", confirmed: false, applied_at: sentAt, attempts, next_try_at: wait, pending: null, before: j.before });
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

async function planWalmart(market: "ca" | "us", force: boolean, e: Expected, rows: Map<string, Row>, now: number) {
  const cfg = WM[market];
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
  // `news`: what a run before this one sent, now read on Walmart (its snapshot is due).
  const settled = { on: 0, back: 0, news: 0 };
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
        if (c.row && !c.row.confirmed) settled.news += 1;
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
        settled.news += 1;
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
  let taken = 0; // changes Walmart took in this run: its snapshot is read at the next one
  for (const op of ops) {
    const st = state.get(op.sku);
    if (st === "failed") continue;
    const r = st === "wait" ? "processing" : op.creates.length ? outcome.get(op.sku) ?? "processing" : "ok";
    if (r.startsWith("failed")) { await fail(op, r.slice(8)); continue; }
    if (op.kind === "set") {
      if (r === "ok") {
        await admin.from(TABLE).update({ confirmed: true, pending: null, checked_at: new Date().toISOString(), attempts: 0, last_error: null, next_try_at: null }).eq("channel", cfg.channel).eq("sku", op.sku);
        totals.set += 1;
        taken += 1;
      } else totals.owed += 1; // Walmart is still working on it: the next run reads the product again
    } else if (r === "ok") {
      await dropRow(cfg.channel, op.sku);
      totals.back += 1;
      taken += 1;
    } else totals.owed += 1;
  }
  return taken;
}

// ============================== the snapshot ==============================
//
// What Price Alignment and Listing Health read of a channel (channel_health).
// A change this function SAW there — a deal's price in place, or back off — is
// followed by a fresh one: the same pull and the same row as health-refresh's
// refreshBestBuy / refreshWalmart and the page's "Run fresh analysis"
// (refreshBestBuyOffers, refreshWalmartItems). Keep the three alike.
//
// Walmart Canada's pull reads 40 promotions a time, the ones the report would
// flag first: a deal of more products takes a second snapshot at the next run.
// One not taken (no time left in the run, the pull failed) stays owed in the
// state (`photo`) and is taken by the next run, SNAPSHOTS_IN_A_ROW at most —
// the two daily snapshots come anyway.
const SNAPSHOT_NEEDS_MS: Record<Channel, number> = { bestbuy: 35_000, walmart_ca: 75_000, walmart_us: 30_000 };
// Walmart Canada: the morning a monthly promotion changes every member is to be
// read again, 40 a pull — health-refresh leaves the rest owed here.
const SNAPSHOTS_IN_A_ROW: Record<Channel, number> = { bestbuy: 3, walmart_ca: 6, walmart_us: 3 };

async function pull(name: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error) throw new Error(String(data?.error ?? `${name} answered ${res.status}`));
  return data;
}

/**
 * Takes the channel's snapshot now. `read`: Best Buy's offers as this run's look
 * read them (no second read); without it they are pulled. `more`: Walmart Canada
 * still has promotions to read.
 */
async function takeSnapshot(channel: Channel, timeoutMs: number, read: OffersRead | null = null): Promise<{ more: boolean; note: string }> {
  if (channel === "bestbuy") {
    // Best Buy turns away reads made too close together (429): one more try a little later.
    const data = read ?? await pull("bestbuy-pull-offers", {}, timeoutMs).catch(async (err) => {
      if (!/429/.test(String((err as Error)?.message))) throw err;
      await sleep(9000);
      return pull("bestbuy-pull-offers", {}, timeoutMs);
    });
    const offers = (data.offers ?? []) as Record<string, unknown>[];
    // Best Buy sells at MAP CAD: the snapshot carries it, so a price difference is read from the row alone.
    const prods = must(await admin.from("products").select("sku, map_cad"), "Read the MAP prices") as { sku: string; map_cad: number | null }[];
    const mapBySku = new Map(prods.map((p) => [p.sku, p.map_cad]));
    const results = offers.map((o) => ({ ...o, map: mapBySku.get(String(o.sku)) ?? null })) as Record<string, unknown>[];
    // `origin_price`: the offer's own price; `price` is the discounted one while a promotion runs.
    const own = (o: Record<string, unknown>) => o.origin_price ?? o.price;
    must(await admin.from("channel_health").insert({
      channel: "bestbuy",
      target: "marketplace.bestbuy.ca",
      total: data.total,
      in_sync: results.filter((o) => o.active).length,
      with_diffs: results.filter((o) => o.map != null && own(o) != null && priceOff(Number(own(o)), Number(o.map))).length,
      errors: results.filter((o) => (Number(o.quantity ?? 0)) === 0).length,
      partial: false,
      results,
    }), "Save Best Buy's snapshot");
    return { more: false, note: `${results.length} offers read` };
  }
  const market = MARKET[channel];
  const data = await pull("walmart-pull-items", market === "ca" ? { market: "ca" } : {}, timeoutMs);
  const items = (data.items ?? []) as Record<string, unknown>[];
  const total = Number(data.total ?? items.length);
  const ok = market === "ca" ? items.filter((i) => i.feedStatus === "SUCCESS").length : items.filter((i) => i.published === "PUBLISHED").length;
  must(await admin.from("channel_health").insert({
    channel: WM[market].snapshot,
    target: "marketplace.walmartapis.com",
    total,
    in_sync: ok,
    with_diffs: total - ok,
    errors: 0,
    partial: false,
    results: items,
  }), `Save ${LABEL[channel]}'s snapshot`);
  if (market !== "ca") return { more: false, note: `${items.length} items read` };
  // `suspects`: the products whose last reading the report would flag; they are read first.
  const flagged = Number(data.suspects ?? 0);
  const readNow = Number(data.promos_checked_now ?? 0);
  return { more: flagged > readNow, note: `${readNow} promotions read, ${flagged} were to be checked` };
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

    // What is in play: the prices on record and the deals that run TODAY on
    // these channels. A deal made for another day has nothing to do yet: with
    // nothing on record either, and no snapshot owed, the run ends here after
    // these three small reads (the state among them: what was wanted and looked
    // at before, and the snapshots still owed).
    const rowsOf = new Map<Channel, Map<string, Row>>(CHANNELS.map((c) => [c, new Map()]));
    const [, dealRows, kept] = await Promise.all([
      (async () => {
        for (let from = 0; ; from += 1000) {
          const page = must(await admin.from(TABLE).select("*").in("channel", channels).order("channel").order("sku").range(from, from + 999), "Read the deal prices on the marketplaces") as Row[];
          for (const r of page) rowsOf.get(r.channel)!.set(r.sku, r);
          if (page.length < 1000) break;
        }
      })(),
      admin.from("promotions").select(`marketplaces, period, ${PROMO_DATE_COLUMNS}`).in("kind", DEAL_KINDS).neq("status", "ended").overlaps("marketplaces", channels),
      admin.from("app_settings").select("value").eq("key", STATE_KEY).maybeSingle(),
    ]);
    const dealsNow = must(dealRows, "Read the deals") as (PromoLike & { marketplaces: string[] | null })[];
    const state = { ...((kept.data?.value ?? {}) as Partial<Record<Channel, Look>>) };
    // `snapshot: [...]` asks for a channel's snapshot in this run (tests, a reading wanted now).
    const askedPhotos: Channel[] = Array.isArray(body.snapshot) ? CHANNELS.filter((c) => body.snapshot.includes(c)) : [];
    for (const c of askedPhotos) state[c] = { sig: "", next_at: 0, ...state[c], photo: true };
    const owedPhotos = dryRun ? [] : channels.filter((c) => state[c]?.photo);
    const inPlay = channels.filter((c) => rowsOf.get(c)!.size > 0 ||
      dealsNow.some((d) => (d.marketplaces ?? []).includes(c) && windowContains(promoWindow(d, MARKET[c]), today)));
    if (!inPlay.length && !owedPhotos.length) return json({ today, nothing_to_do: true, owed: 0 });

    const memo = new Map<string, Promise<unknown>>();
    const sharedLoad = (key: string, loader: () => Promise<unknown>) => {
      if (!memo.has(key)) memo.set(key, loader());
      return memo.get(key);
    };
    const prices = createPriceAlignment({ db: admin, sharedLoad });
    const totals: Totals = { set: 0, back: 0, failed: 0, new_failures: 0, owed: 0, errors: [] };
    const report: Record<string, unknown> = {};
    const lines: Record<string, unknown>[] = [];
    const failed = (channel: Channel, err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      report[channel] = { ...(report[channel] as Record<string, unknown> ?? {}), error: message };
      if (totals.errors.length < MAX_LIST) totals.errors.push(`${LABEL[channel]}: ${message}`.slice(0, 260));
    };

    // What the PIM wants on each channel today — database reads only. A channel
    // is looked at (Best Buy's offers, Walmart's promotions) only when that
    // changed since its last look, when something on record is due, or when the
    // look is old (see `Look`); a dry run, `force` and `limit` always look.
    const wanted = new Map<Channel, { e: Expected; sig: string }>();
    await Promise.all(inPlay.map(async (channel) => {
      try {
        const e = await expected(channel, today, prices, rowsOf.get(channel)!);
        wanted.set(channel, { e, sig: await signature(today, e) });
      } catch (err) {
        failed(channel, err);
      }
    }));
    const due = [...wanted.keys()].filter((c) =>
      dryRun || force || limit != null || state[c]?.sig !== wanted.get(c)!.sig || Date.now() >= (state[c]?.next_at ?? 0));
    for (const c of channels) {
      if (due.includes(c) || report[c]) continue;
      report[c] = wanted.has(c) ? { unchanged: true, next_look: iso(state[c]!.next_at) } : { deals: [], products: 0 };
    }
    if (!due.length && !owedPhotos.length && !totals.errors.length) return json({ today, nothing_to_do: true, owed: 0, channels: report });

    // One run at a time (a dry run only reads, so it never waits).
    if (!dryRun) {
      const { data: lock } = await admin.from("app_settings").select("value").eq("key", LOCK_KEY).maybeSingle();
      const until = (lock?.value as { until?: string | null } | null)?.until;
      if (until && Date.parse(until) > Date.now()) return json({ today, busy: true });
      await admin.from("app_settings").upsert({ key: LOCK_KEY, value: { until: new Date(Date.now() + RUN_BUDGET_MS + 40_000).toISOString() }, updated_at: new Date().toISOString() }, { onConflict: "key" });
      locked = true;
    }
    const deadline = Date.now() + RUN_BUDGET_MS;
    const busy = new Set<Channel>(); // sent, owed or failed: looked at again by the next run
    let offersRead: OffersRead | null = null; // Best Buy's offers, when this run looked at them
    const seen = new Set<Channel>(); // a change was READ on the channel in this run: its snapshot is due now
    const sent = new Set<Channel>(); // Walmart took a change in this run: its snapshot is read at the next one

    await Promise.all(due.map(async (channel) => {
      const { e } = wanted.get(channel)!;
      try {
        if (channel === "bestbuy") {
          const plan = await planBestBuy(today, force, e, rowsOf.get(channel)!);
          offersRead = plan.read;
          const take = limit ? plan.jobs.slice(0, limit) : plan.jobs;
          report[channel] = { deals: plan.running, products: plan.wanted, on: plan.on, to_set: plan.jobs.filter((j) => j.kind === "set").length, to_back: plan.jobs.filter((j) => j.kind === "back").length, waiting: plan.waiting, skipped: plan.skipped.slice(0, 200), ...(dryRun ? { monthly_members: plan.monthly_members, monthly_on: plan.monthly_on, sample: plan.sample } : {}) };
          for (const j of take) lines.push(j.kind === "set"
            ? { channel, action: "discount", sku: j.sku, price: j.deal.price, regular: j.deal.base, from: j.deal.start, to: j.deal.end, deal: j.deal.name, why: j.why, ...(j.before ? { takes_the_place_of: j.before } : {}) }
            : { channel, action: j.to != null ? "discount back" : "discount off", sku: j.sku, price: j.to, line: j.line });
          if (dryRun) return;
          for (const a of plan.adopt) await saveRow(channel, a.sku, a.fields);
          for (const sku of plan.drop) await dropRow(channel, sku);
          // A deal's discount read on the offers, or one that is back off them.
          if (plan.adopt.length || plan.drop.length) seen.add(channel);
          totals.owed += plan.jobs.length - take.length;
          // What is sent is seen on Best Buy by the next run, which confirms it.
          if (plan.jobs.length) busy.add(channel);
          if (take.length) (report[channel] as Record<string, unknown>).import = await runBestBuy(plan, take, totals);
        } else {
          const market = MARKET[channel];
          const plan = await planWalmart(market, force, e, rowsOf.get(channel)!, now);
          const take = plan.candidates.slice(0, limit ?? WM_SKUS_PER_RUN);
          report[channel] = { deals: plan.running, products: plan.wanted, on: plan.on, to_look_at: plan.candidates.length, waiting: plan.waiting, skipped: plan.skipped.slice(0, 200) };
          if (!take.length) return;
          const token = await wmToken(market);
          const { ops, settled } = await walmartOps(market, token, plan, take, now, dryRun, totals);
          Object.assign(report[channel] as Record<string, unknown>, { already_right: settled.on, nothing_to_take_back: settled.back, to_change: ops.length });
          if (!dryRun && settled.news) seen.add(channel);
          for (const op of ops) lines.push({
            channel, action: op.kind === "set" ? "deal" : "back", sku: op.sku, walmart_sku: op.wsku, deal: op.deal?.name ?? null, why: op.why,
            delete: op.deletes.map((p) => ({ price: p.price, from: iso(p.start), to: iso(p.end) })),
            create: op.creates.map((s) => ({ what: s.what, price: s.price, from: iso(s.start), to: iso(s.end) })),
          });
          totals.owed += plan.candidates.length - take.length;
          // Something sent, left for later, or a product Walmart could not be read for.
          if (ops.length || settled.on + settled.back < take.length || plan.candidates.length > take.length) busy.add(channel);
          if (dryRun || !ops.length) return;
          if (await runWalmart(market, token, ops, deadline, totals)) sent.add(channel);
        }
      } catch (err) {
        // One marketplace failing does not stop the others.
        busy.add(channel);
        failed(channel, err);
      }
    }));

    if (dryRun) return json({ dryRun: true, today, off, channels: report, lines: lines.slice(0, 400), errors: totals.errors });

    // A change seen on a channel is followed by its snapshot (see takeSnapshot).
    // One Walmart took in this very run is read at the next (its promotions may
    // not show it yet); one that cannot be taken now stays owed in the state.
    const photos = new Map<Channel, Partial<Look>>();
    await Promise.all(channels.filter((c) => (seen.has(c) || state[c]?.photo) && !sent.has(c)).map(async (c) => {
      const tried = state[c]?.photos ?? 0;
      if (deadline + 25_000 - Date.now() < SNAPSHOT_NEEDS_MS[c]) {
        photos.set(c, { photo: true, photos: tried, photo_note: "no time left in the run: taken at the next one" });
        return;
      }
      let more = true;
      let note: string;
      let at: string | undefined;
      try {
        ({ more, note } = await takeSnapshot(c, SNAPSHOT_NEEDS_MS[c], c === "bestbuy" ? offersRead : null));
        at = new Date().toISOString();
      } catch (err) {
        note = `not taken: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
        console.error(`[channel-deals] snapshot of ${c} ${note}`);
      }
      const again = more && tried + 1 < SNAPSHOTS_IN_A_ROW[c];
      photos.set(c, { photo: again, photos: again ? tried + 1 : 0, photo_note: note, ...(at ? { photo_at: at } : {}) });
    }));
    for (const c of sent) photos.set(c, { photo: true, photos: 0, photo_note: "sent in this run: read at the next one" });
    for (const [c, p] of photos) {
      report[c] = { ...(report[c] as Record<string, unknown> ?? {}), snapshot: `${p.photo_at ? `taken${p.photo ? ", one more to come" : ""} — ` : ""}${p.photo_note}` };
    }

    // When each channel is looked at next while the PIM wants the same: at once
    // if this run sent or owes something, else when something on record is due
    // (a wait that ends, a Walmart price to read again), LOOK_EVERY_MS at most.
    if (due.length) {
      const next = new Map<Channel, number>(due.map((c) => [c, busy.has(c) ? 0 : Date.now() + LOOK_EVERY_MS[c]]));
      try {
        for (let from = 0; ; from += 1000) {
          const page = must(await admin.from(TABLE).select("channel, next_try_at, live_end, checked_at").in("channel", due).order("channel").order("sku").range(from, from + 999), "Read the deal prices on the marketplaces") as Row[];
          for (const r of page) {
            let at = next.get(r.channel)!;
            if (r.next_try_at) at = Math.min(at, Date.parse(r.next_try_at));
            if (r.channel !== "bestbuy") {
              if (r.live_end) at = Math.min(at, Date.parse(r.live_end));
              at = Math.min(at, (r.checked_at ? Date.parse(r.checked_at) : 0) + RECHECK_MS);
            }
            next.set(r.channel, at);
          }
          if (page.length < 1000) break;
        }
      } catch (err) {
        // Not known when something is due: the next run looks.
        console.error("[channel-deals] next look not worked out:", err instanceof Error ? err.message : err);
        for (const c of due) next.set(c, 0);
      }
      for (const c of due) state[c] = { ...state[c], sig: wanted.get(c)!.sig, next_at: next.get(c)! };
    }
    // A channel that only owes a snapshot has nothing wanted: an empty look.
    for (const [c, p] of photos) state[c] = { sig: "", next_at: 0, ...state[c], ...p };
    if (due.length || photos.size) {
      const { error: stateErr } = await admin.from("app_settings").upsert({ key: STATE_KEY, value: state, updated_at: new Date().toISOString() }, { onConflict: "key" });
      // Not saved: without a state every run looks, as before this was kept.
      if (stateErr) await admin.from("app_settings").delete().eq("key", STATE_KEY);
    }

    await admin.from("app_settings").upsert({ key: LOCK_KEY, value: { until: null }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    locked = false;
    const result = { at: new Date().toISOString(), today, ...totals, channels: report, by: actor?.actor_name ?? (viaCron ? "cron" : "service role") };
    // A run that only took an owed snapshot looked at nothing: the last look's report stays.
    if (due.length || totals.errors.length) await admin.from("app_settings").upsert({ key: RUN_KEY, value: result, updated_at: result.at }, { onConflict: "key" });
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
