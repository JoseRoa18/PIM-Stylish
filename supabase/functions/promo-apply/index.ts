// promo-apply — automatic promotion rollover, market by market.
//
// Calendar (rule 2026-08-28, all boundaries at 00:00 America/Toronto):
//   USA    — promo prices flip on the 1st of the month.
//   Canada — promo prices flip on the FIRST THURSDAY of the month and run
//            until the day before the next month's first Thursday
//            (Thursday-to-Thursday, no gaps).
//   Everything schedulable is loaded ONE DAY AHEAD: the evening before
//   Canada's start, the month's Best Buy discounts are (re)submitted to
//   Mirakl as scheduled discounts; Mirakl flips them on its own.
//
// Called by pg_cron DAILY at 04:05 and 05:05 UTC (the pair covers EDT/EST so
// one of the two runs lands just after midnight Eastern; see
// 20260828_promo_calendar_cron.sql). Each run is idempotent — boundary
// passes stamp promotions.us_applied_at / ca_applied_at so the second firing
// skips. A market is stamped only once every Wix change went through: Wix
// is pushed at a pace, and what it refuses or what does not fit in a run is
// finished by continuation runs the function chains to itself (see "Wix
// pacing" below).
//
// What a run does (only on the matching dates, everything idempotent):
//   - Day 1 (US pass): pushes SinksDirect US to promo USD ?? MAP USD for the
//     month's promo members; members of the previous promo that dropped out
//     go back to regular MAP USD.
//   - First Thursday (CA pass): applies the CAD list to store pricing
//     (on_sale + sale_price_cad), pushes SinksDirect CA (priceData +
//     discount), clears the previous promo's members, ends the previous
//     promotion. Stylish brand sites sell at MSRP and are never touched.
//   - Day before the first Thursday (prep pass): submits the Best Buy
//     scheduled discounts for the Canada window (start date is in the
//     future, which Mirakl requires) and Walmart Canada's promotional
//     prices; the day before the 1st, Walmart USA's (walmart-push-promo,
//     Settings switches walmart_ca / walmart_us). Both boundary passes carry
//     a safety net for a promotion not scheduled the day before.
//   Manual "Run now" (body {sync:true}) RECONCILES: re-applies whatever
//   should be live today on both markets, dates aside.
//
// Auth: `x-cron-secret` header, the service-role key as Bearer, or an
// authenticated ADMIN user (the Settings page's "Run now").
// Body: { sync?: boolean, dryRun?: boolean } — dryRun computes the full plan
// and writes/pushes nothing (implies sync + reconcile). { chain: n,
// reconcile } is the continuation call a run makes to itself (background).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  activePeriodFor,
  etToday,
  marketWindow,
  periodOfDay,
  promoWindow,
  windowContains,
} from "../_shared/promoCalendar.ts";
import { isServiceRole } from "../_shared/serviceRole.ts";
import { bbDiscount, discountRunning, etDayOf } from "../_shared/bestbuyDiscount.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const MIRAKL_BASE = "https://marketplace.bestbuy.ca";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------- Supabase REST helpers (service role) ----------------------------

const restHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function restGet<T = unknown>(pathQuery: string): Promise<T> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${pathQuery}`, { headers: restHeaders });
  if (!resp.ok) throw new Error(`GET ${pathQuery.split("?")[0]} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return await resp.json();
}

async function restPatch(pathQuery: string, body: unknown): Promise<void> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${pathQuery}`, {
    method: "PATCH",
    headers: { ...restHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`PATCH ${pathQuery.split("?")[0]} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
}

async function restPost(path: string, body: unknown): Promise<void> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`POST ${path} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const inList = (skus: string[]) => `in.(${skus.map((s) => `"${s}"`).join(",")})`;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- data types ------------------------------------------------------

interface PromoRow {
  id: number;
  name: string;
  period: string;
  status: string;
  starts_on: string | null;
  ends_on: string | null;
  ca_starts_on?: string | null;
  ca_ends_on?: string | null;
  us_starts_on?: string | null;
  us_ends_on?: string | null;
  us_applied_at: string | null;
  ca_applied_at: string | null;
  bb_scheduled_at: string | null;
  wm_ca_scheduled_at: string | null;
  wm_us_scheduled_at: string | null;
}
interface PriceRow { sku: string; promo_price_cad: number | null; promo_price_usd: number | null }

async function promoPrices(promoId: number): Promise<PriceRow[]> {
  return await restGet<PriceRow[]>(
    `promotion_prices?promotion_id=eq.${promoId}&select=sku,promo_price_cad,promo_price_usd`,
  );
}

// Rows minus the products switched off for a marketplace (products.channel_exclusions).
async function withoutExcluded<T extends { sku: string }>(rows: T[], channelKey: string): Promise<T[]> {
  if (!rows.length) return rows;
  const ex = new Set<string>();
  for (const part of chunk(rows.map((r) => r.sku), 100)) {
    const hit = await restGet<{ sku: string }[]>(`products?select=sku&channel_exclusions=cs.{${channelKey}}&sku=${inList(part)}`);
    hit.forEach((p) => ex.add(p.sku));
  }
  return ex.size ? rows.filter((r) => !ex.has(r.sku)) : rows;
}

// ---------- Wix push helper -------------------------------------------------

interface WixJob { sku: string; site: string; only: string[]; fields?: Record<string, unknown> }

// Wix pacing (fix 2026-09-29). On the September launches Wix answered "Rate
// limit exceeded" to most price changes (USA 1st: 30 of 175 went through,
// Canada 3rd: 30 of 182) and the market was stamped anyway, so nothing was
// retried. Now: two changes at a time with a pause between them; a "rate
// limit" answer waits what Wix asks (or a default) and tries again; what does
// not fit in this run's time budget is left for a continuation run (see
// run(): it chains itself), with the changes that already went through today
// remembered in app_settings.promo_apply_wix_progress; a market is stamped
// only once every change went through.
const WIX_CONCURRENCY = 2;
const WIX_GAP_MS = 700; // pause after each change, per worker
const WIX_MAX_TRIES = 5; // per change and run, rate-limit answers only
const WIX_BUDGET_MS = 105_000; // from the run's start, cooldown included (the runtime caps a run at ~150 s)
const WIX_COOLDOWN_MS = 20_000; // a continuation run waits this before pushing again
const WIX_MAX_CHAIN = 20;
const WIX_PROGRESS_KEY = "promo_apply_wix_progress";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jobKey = (j: WixJob) => `${j.site}:${j.sku}`;

interface WixProgress { day: string; done: Set<string>; lock_until: string | null }
interface PushCtx { deadline: number; progress: WixProgress; skip: boolean }

async function loadWixProgress(today: string, fresh: boolean): Promise<WixProgress> {
  if (fresh) return { day: today, done: new Set(), lock_until: null };
  const rows = await restGet<{ value: { day?: string; done?: string[]; lock_until?: string | null } }[]>(
    `app_settings?key=eq.${WIX_PROGRESS_KEY}&select=value`,
  );
  const v = rows[0]?.value ?? {};
  if (v.day !== today) return { day: today, done: new Set(), lock_until: null };
  return { day: today, done: new Set(v.done ?? []), lock_until: v.lock_until ?? null };
}

async function saveWixProgress(p: WixProgress): Promise<void> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      key: WIX_PROGRESS_KEY,
      value: { day: p.day, done: [...p.done], lock_until: p.lock_until },
      updated_at: new Date().toISOString(),
    }),
  });
  if (!resp.ok) throw new Error(`save wix progress ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
}

// One change to Wix: ok, a rate-limit answer (with how long to wait), or an error.
async function pushOneWix(job: WixJob): Promise<{ ok: true } | { ok: false; rateLimited: boolean; waitMs: number; message: string }> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/wix-push-product`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(job),
  });
  if (resp.ok) return { ok: true };
  const message = String(((await resp.json().catch(() => ({}))) as { error?: string }).error ?? resp.status);
  const rateLimited = resp.status === 429 || /rate limit|too many requests/i.test(message);
  // Wix says "Retry after 56003ms." (milliseconds); plain seconds are read too.
  const m = message.match(/retry after\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|seconds)?/i);
  const n = m ? Number(m[1]) : NaN;
  const asked = !Number.isFinite(n) || n <= 0 ? 30_000 : /^s/i.test(m?.[2] ?? "") || (!m?.[2] && n < 300) ? n * 1000 : n;
  const waitMs = Math.min(65_000, Math.max(2_000, asked + 500));
  return { ok: false, rateLimited, waitMs, message };
}

type WixOut = Record<string, { pushed: number; failed: number; excluded?: number; already: number; deferred: number; rate_limited: number }>;

async function pushWixJobs(allJobs: WixJob[], dryRun: boolean, errors: string[], ctx: PushCtx): Promise<WixOut> {
  // Marketplace exclusion (rule 2026-09-22): a product switched off for a
  // store gets no job there, not even a price change.
  const jobs: WixJob[] = [];
  const bySite = new Map<string, WixJob[]>();
  for (const j of allJobs) bySite.set(j.site, [...(bySite.get(j.site) ?? []), j]);
  for (const [site, list] of bySite) {
    const kept = await withoutExcluded(list, `wix_${site}`);
    jobs.push(...kept);
  }
  const out: WixOut = {};
  for (const j of allJobs) out[j.site] = out[j.site] ?? { pushed: 0, failed: 0, already: 0, deferred: 0, rate_limited: 0 };
  if (allJobs.length !== jobs.length) for (const [site, list] of bySite) out[site].excluded = list.length - jobs.filter((j) => j.site === site).length;
  if (dryRun || !jobs.length) return out;

  // Changes that already went through today (an earlier run of the chain).
  const pending = jobs.filter((j) => {
    if (!ctx.progress.done.has(jobKey(j))) return true;
    out[j.site].already += 1;
    return false;
  });
  if (ctx.skip) {
    // Another run is pushing right now: leave these to it.
    for (const j of pending) out[j.site].deferred += 1;
    return out;
  }

  // Wix lets about 30 changes through and then blocks for about a minute
  // (September: "Retry after 56003ms"). A block pauses BOTH workers until the
  // time Wix gave; a pause that does not fit in this run's budget stops the
  // run (the rest goes to the continuation run) instead of hammering Wix.
  let next = 0;
  let pausedUntil = 0;
  let stopped = false;
  const worker = async () => {
    while (next < pending.length && !stopped) {
      if (pausedUntil > Date.now()) await sleep(pausedUntil - Date.now());
      if (stopped || Date.now() > ctx.deadline) return; // the rest goes to the continuation run
      const job = pending[next++];
      for (let tries = 1; ; tries++) {
        const r = await pushOneWix(job);
        if (r.ok) {
          out[job.site].pushed += 1;
          ctx.progress.done.add(jobKey(job));
          break;
        }
        if (r.rateLimited) {
          pausedUntil = Math.max(pausedUntil, Date.now() + r.waitMs);
          if (tries < WIX_MAX_TRIES && pausedUntil < ctx.deadline) {
            await sleep(pausedUntil - Date.now());
            continue;
          }
          out[job.site].rate_limited += 1; // tried again by the continuation run
          stopped = true;
          break;
        }
        out[job.site].failed += 1;
        if (errors.length < 25) errors.push(`wix ${job.sku} (${job.site}): ${r.message}`);
        break;
      }
      await sleep(WIX_GAP_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WIX_CONCURRENCY, pending.length) }, worker));
  for (const j of pending.slice(next)) out[j.site].deferred += 1; // never started: over the time budget
  // Remembered right away, so a run cut short does not repeat these.
  await saveWixProgress(ctx.progress).catch((err) => console.error("[promo-apply] progress save failed:", (err as Error).message));
  return out;
}

// Changes of these stores still owed to Wix (over the time budget, or still
// answered "rate limit"): the market is not stamped while any remain.
const wixPending = (out: WixOut, sites: string[]) =>
  sites.reduce((n, s) => n + (out[s]?.deferred ?? 0) + (out[s]?.rate_limited ?? 0), 0);

// ---------- Best Buy scheduled discounts ------------------------------------

// Mirakl runs OF24 in NORMAL mode: any field missing from a line is BLANKED
// on the offer (2026-08-28: a price-only import zeroed the stock of 127 live
// offers). Read the live offers first and carry quantity (and price when the
// PIM has no MAP) on every line.
type LiveOffer = { price: number | null; quantity: number; discount: Record<string, unknown> | null };
async function readLiveOffers(bbKey: string): Promise<Map<string, LiveOffer>> {
  const live = new Map<string, LiveOffer>();
  let offset = 0;
  for (;;) {
    const res = await fetch(`${MIRAKL_BASE}/api/offers?max=100&offset=${offset}`, {
      headers: { Authorization: bbKey, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Best Buy live offers read failed (${res.status}) — promo NOT sent to Best Buy`);
    const data = await res.json();
    for (const o of data.offers ?? []) live.set(o.shop_sku, { price: o.price ?? null, quantity: o.quantity ?? 0, discount: o.discount ?? null });
    offset += 100;
    if (!data.offers?.length || offset >= (data.total_count ?? 0)) break;
  }
  return live;
}

async function scheduleBestBuy(
  cadRows: PriceRow[],
  start: string,
  end: string,
  dryRun: boolean,
  // The day before a window: an offer still running the ending promotion's
  // discount keeps it (one discount per offer) — the boundary-day pass sends it.
  deferRunning = false,
): Promise<Record<string, unknown>> {
  const BB_KEY = Deno.env.get("BESTBUY_API_KEY");
  if (!BB_KEY) return { skipped: "no BESTBUY_API_KEY" };

  const mapCad = new Map<string, number | null>();
  for (const part of chunk(cadRows.map((r) => r.sku), 100)) {
    const prods = await restGet<{ sku: string; map_cad: number | null }[]>(
      `products?select=sku,map_cad&sku=${inList(part)}`,
    );
    prods.forEach((p) => mapCad.set(p.sku, p.map_cad));
  }
  const liveOffers = await readLiveOffers(BB_KEY);

  const offers: Record<string, unknown>[] = [];
  let skipped = 0;
  let notListed = 0;
  let deferred = 0;
  for (const r of cadRows) {
    const cur = liveOffers.get(r.sku);
    if (!cur) { notListed += 1; continue; }
    if (deferRunning && discountRunning(cur.discount) && etDayOf(String(cur.discount?.start_date ?? "")) < start) { deferred += 1; continue; }
    const map = mapCad.get(r.sku);
    if (map != null && (r.promo_price_cad as number) >= map) { skipped += 1; continue; }
    const price = map ?? cur.price;
    if (price == null) continue;
    offers.push({
      shop_sku: r.sku,
      update_delete: "update",
      price,
      quantity: cur.quantity,
      // Mirakl's nested discount object (the flat CSV names were ignored in
      // JSON and cleared the discount — see _shared/bestbuyDiscount.ts).
      discount: bbDiscount(r.promo_price_cad as number, start, end),
    });
  }
  const report: Record<string, unknown> = {
    window: { start, end },
    listed: offers.length,
    not_listed: notListed,
    skipped_at_or_above_map: skipped,
    ...(deferRunning ? { deferred_running: deferred } : {}),
    skus: offers.map((o) => o.shop_sku),
  };
  if (!dryRun && offers.length) {
    const submit = await fetch(`${MIRAKL_BASE}/api/offers`, {
      method: "POST",
      headers: { Authorization: BB_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ offers }),
    });
    const body = await submit.json().catch(() => ({}));
    if (!submit.ok) throw new Error(`Mirakl OF24 ${submit.status}: ${JSON.stringify(body).slice(0, 200)}`);
    report.import_id = body.import_id ?? null;
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const chk = await fetch(`${MIRAKL_BASE}/api/offers/imports/${body.import_id}`, {
        headers: { Authorization: BB_KEY, Accept: "application/json" },
      });
      if (!chk.ok) continue;
      const st = await chk.json();
      report.import_status = st.status;
      report.lines_in_error = st.lines_in_error ?? 0;
      if (st.status === "COMPLETE" || st.status === "FAILED") break;
    }
  }
  return report;
}

// The card's record of a Best Buy send (promotions.bb_schedule), in the shape
// the app writes when it schedules by hand — so a re-send by this automation
// (e.g. after the promotion's dates changed) shows the window it really sent.
function bbScheduleRecord(promo: PromoRow, report: Record<string, unknown>, nowIso: string): Record<string, unknown> {
  const w = (report.window ?? {}) as { start?: string; end?: string };
  const listed = Number(report.listed ?? 0);
  const failed = Number(report.lines_in_error ?? 0);
  return {
    at: nowIso,
    period: promo.period,
    start: w.start ?? null,
    end: w.end ?? null,
    scheduled: Math.max(0, listed - failed),
    attempted: listed,
    not_listed: Number(report.not_listed ?? 0),
    skipped_at_or_above_map: Number(report.skipped_at_or_above_map ?? 0),
    import_id: report.import_id ?? null,
    lines_in_error: failed,
    // what went out, so a re-send from the app can clear SKUs that left the list
    skus: Array.isArray(report.skus) ? report.skus : [],
    by: "automation",
  };
}

// ---------- Walmart (both markets) ------------------------------------------
// walmart-push-promo builds and posts the promotional-price feed; Walmart
// flips the promo on the window's first minute by itself. Scheduled the day
// before a market's window opens (prep) and, as a safety net, on the
// boundary day when the prep did not happen. "Nothing to send" (no member
// listed there yet — Walmart USA has no items so far) is an outcome, not an
// error, and leaves the promotion unstamped so a later pass tries again.
async function scheduleWalmart(market: "ca" | "us", promoId: number, dryRun: boolean): Promise<Record<string, unknown>> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/walmart-push-promo`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "push", market, promotionId: promoId, dryRun }),
  });
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (resp.status === 400 && typeof body.error === "string") {
    return { skipped: body.error, attempted: body.attempted ?? 0, not_listed: body.not_listed ?? 0 };
  }
  if (!resp.ok || body.error) throw new Error(String(body.error ?? `walmart-push-promo ${resp.status}`));
  return {
    attempted: body.attempted, not_listed: body.not_listed, excluded: body.excluded,
    feed_id: body.feedId ?? null, feedStatus: body.feedStatus ?? null, itemsFailed: body.itemsFailed ?? 0,
    ...(body.dryRun === true ? { dryRun: true } : {}),
  };
}

// ---------- the run ---------------------------------------------------------

async function run(dryRun: boolean, reconcile: boolean, opts: { chain?: number } = {}) {
  const chain = opts.chain ?? 0;
  const startedAt = Date.now();
  // A continuation run (chained by the previous one) lets Wix breathe first.
  if (chain > 0 && !dryRun) await sleep(WIX_COOLDOWN_MS);
  const today = etToday();
  const tomorrow = etToday(1);
  const nowIso = new Date().toISOString();
  const report: Record<string, unknown> = { today, dryRun, mode: reconcile ? "reconcile" : "cron", ...(chain ? { chain } : {}) };
  const errors: string[] = [];

  // -- 0. settings gate ------------------------------------------------------
  const settingRows = await restGet<{ value: Record<string, unknown> }[]>(
    "app_settings?key=eq.promo_automation&select=value",
  );
  const settings = settingRows[0]?.value ?? {};
  if (settings.enabled === false) {
    return { ...report, skipped: "promo automation is disabled in Settings" };
  }

  // -- 1. promos on the board ------------------------------------------------
  const promos = await restGet<PromoRow[]>(
    // Only the MONTHLY promotions are automated; flash deals and special events run by hand.
    "promotions?select=id,name,period,status,starts_on,ends_on,ca_starts_on,ca_ends_on,us_starts_on,us_ends_on,us_applied_at,ca_applied_at,bb_scheduled_at,wm_ca_scheduled_at,wm_us_scheduled_at&status=in.(draft,active)&kind=eq.monthly&order=id.desc",
  );
  // Promotions ended in the last two days: the first run of a boundary ends
  // the previous one, and a continuation run (or the second nightly cron)
  // still owes its members their return to regular prices. They never count
  // as a target — only as "members leaving the sale".
  const endedSince = new Date(Date.now() - 48 * 3600_000).toISOString();
  const recentlyEnded = await restGet<PromoRow[]>(
    `promotions?select=id,name,period,status,starts_on,ends_on,ca_starts_on,ca_ends_on,us_starts_on,us_ends_on,us_applied_at,ca_applied_at,bb_scheduled_at,wm_ca_scheduled_at,wm_us_scheduled_at&status=eq.ended&kind=eq.monthly&ended_at=gte.${encodeURIComponent(endedSince)}`,
  );
  // The promotion whose window on a market contains a day — custom dates
  // when the promotion carries them, else its month's market calendar.
  // Active promotions win over drafts of the same day.
  const win = (p: PromoRow, m: "us" | "ca") => promoWindow(p, m);
  const liveOn = (m: "us" | "ca", day: string): PromoRow | null => {
    const c = promos.filter((p) => windowContains(win(p, m), day));
    return c.find((p) => p.status === "active") ?? c[0] ?? null;
  };

  const usTarget = liveOn("us", today);
  const caTarget = liveOn("ca", today);
  const usPeriod = usTarget?.period ?? activePeriodFor("us", today);
  const caPeriod = caTarget?.period ?? activePeriodFor("ca", today);
  report.periods = { us: usPeriod, ca: caPeriod };
  report.target = { us: usTarget?.name ?? null, ca: caTarget?.name ?? null };

  // -- 2. which passes fire today -------------------------------------------
  // A pass fires when a promotion's window opens today (custom or calendar),
  // and on the calendar boundary itself even with no promotion (prices go
  // back to regular).
  const usStartsToday = (usTarget ? win(usTarget, "us").start === today : today === periodOfDay(today));
  const caStartsToday = (caTarget ? win(caTarget, "ca").start === today : caPeriod != null && today === marketWindow(caPeriod, "ca").start);
  // Best Buy and Walmart Canada are scheduled the day before Canada's window
  // opens; Walmart USA the day before the USA window opens (the 1st).
  const prepTarget = promos.find((p) => win(p, "ca").start === tomorrow) ?? null;
  const prepUsTarget = promos.find((p) => win(p, "us").start === tomorrow) ?? null;

  const doUS = reconcile || (usStartsToday && !usTarget?.us_applied_at);
  const doCA = reconcile || (caStartsToday && !caTarget?.ca_applied_at);
  // The prep pass always (re)schedules Best Buy — it overwrites idempotently,
  // and an earlier schedule may carry an outdated window (e.g.
  // pre-calendar-change). Walmart is scheduled once (stamped).
  // A continuation run only finishes the Wix changes — the prep sends
  // (Best Buy re-schedules on every prep pass) already went out.
  const doPrep = chain === 0 && (prepTarget != null || prepUsTarget != null);

  if (!doUS && !doCA && !doPrep) {
    return { ...report, skipped: "no promo boundary today" };
  }

  // Wix pacing context: today's progress (a manual reconcile starts fresh,
  // its continuations and the cron reuse it), a lock so the second nightly
  // cron does not push over a chain still running, and this run's budget.
  // The progress record only saves Wix calls: if it cannot be read or saved
  // the run goes on without it (everything is pushed again, idempotently).
  const freshProgress = (): WixProgress => ({ day: today, done: new Set<string>(), lock_until: null });
  const progress: WixProgress = dryRun
    ? freshProgress()
    : await loadWixProgress(today, reconcile && chain === 0).catch((err) => {
      errors.push(`wix progress: ${(err as Error).message}`);
      return freshProgress();
    });
  const lockedByOther = !dryRun && chain === 0 && !reconcile && progress.lock_until != null && Date.parse(progress.lock_until) > Date.now();
  const wixCtx: PushCtx = { deadline: startedAt + WIX_BUDGET_MS, progress, skip: lockedByOther };
  if (!dryRun && !lockedByOther && (doUS || doCA)) {
    progress.lock_until = new Date(Date.now() + 170_000).toISOString();
    await saveWixProgress(progress).catch((err) => errors.push(`wix progress: ${(err as Error).message}`));
  }
  let wixOwed = 0; // changes still owed to Wix after this run
  if (lockedByOther) report.wix_skipped = "another run is still pushing to Wix";

  // -- 3. US pass: SinksDirect US to this month's promo USD ------------------
  if (doUS && settings.wix !== false) {
    const targetRows = usTarget ? await promoPrices(usTarget.id) : [];
    // Members of the promotions whose US window is over leave the sale
    // (unless carried into the new list).
    const prevRows: { sku: string }[] = [];
    for (const p of [...promos, ...recentlyEnded].filter((p) => p.id !== usTarget?.id && win(p, "us").end < today)) prevRows.push(...await promoPrices(p.id));
    const promoUsd = new Map(targetRows.filter((r) => r.promo_price_usd != null).map((r) => [r.sku, r.promo_price_usd]));
    const affected = [...new Set([...promoUsd.keys(), ...prevRows.map((r) => r.sku)])];

    const linkedUs = new Set<string>();
    const usdBySku = new Map<string, number | null>();
    for (const part of chunk(affected, 100)) {
      const list = inList(part);
      const [us, prods] = await Promise.all([
        restGet<{ sku: string }[]>(`wix_links?site=eq.sinksdirect_us&sku=${list}&select=sku`),
        restGet<{ sku: string; map_usd: number | null }[]>(`products?select=sku,map_usd&sku=${list}`),
      ]);
      us.forEach((r) => linkedUs.add(r.sku));
      prods.forEach((r) => usdBySku.set(r.sku, r.map_usd));
    }
    const jobs: WixJob[] = [];
    for (const sku of linkedUs) {
      const expected = promoUsd.get(sku) ?? usdBySku.get(sku) ?? null;
      if (expected == null) continue;
      jobs.push({ sku, site: "sinksdirect_us", only: ["priceData"], fields: { map_usd: expected } });
    }
    const wixUs = await pushWixJobs(jobs, dryRun, errors, wixCtx);
    report.us = { members: promoUsd.size, linked: linkedUs.size, ...wixUs.sinksdirect_us };
    const usOwed = wixPending(wixUs, ["sinksdirect_us"]);
    wixOwed += usOwed;

    // Stamped only once every change reached Wix — until then the chain
    // (and the next nightly run) keep pushing what is left.
    if (!dryRun && usTarget && usOwed === 0) {
      await restPatch(`promotions?id=eq.${usTarget.id}`, {
        us_applied_at: nowIso,
        ...(usTarget.status === "draft" ? { status: "active", activated_at: nowIso } : {}),
      });
    }
  }
  // Walmart USA safety net: the day-before prep normally schedules it; if it
  // did not (promo loaded late / toggle off), schedule for the rest of the
  // window (the function starts a window already open in a few minutes).
  if (chain === 0 && doUS && settings.walmart_us !== false && usTarget && !usTarget.wm_us_scheduled_at) {
    try {
      const rows = (await promoPrices(usTarget.id)).filter((r) => r.promo_price_usd != null);
      if (rows.length) report.walmart_us = await scheduleWalmart("us", usTarget.id, dryRun);
    } catch (err) {
      errors.push(`walmart us: ${(err as Error).message}`);
    }
  }

  // -- 4. CA pass: store pricing + SinksDirect CA on the first Thursday ------
  let caOwed = 0;
  if (doCA) {
    const targetRows = caTarget ? await promoPrices(caTarget.id) : [];
    const cadRows = targetRows.filter((r) => r.promo_price_cad != null);
    const targetCadSkus = new Set(cadRows.map((r) => r.sku));

    // Previous promos whose Canada window is over: their members leave the
    // sale (unless carried into the new list), and the promo ends.
    const toEnd = promos.filter((p) =>
      p.status === "active" && p.id !== caTarget?.id && win(p, "ca").end < today
    );
    const endSkus = new Set<string>();
    const leaving = [...toEnd, ...recentlyEnded.filter((p) => p.id !== caTarget?.id && win(p, "ca").end < today)];
    for (const p of leaving) {
      for (const r of await promoPrices(p.id)) endSkus.add(r.sku);
    }
    const clearSkus = [...endSkus].filter((s) => !targetCadSkus.has(s));
    report.store = { cleared: clearSkus.length, on_sale: cadRows.length };
    report.ending = toEnd.map((p) => ({ id: p.id, name: p.name }));

    if (!dryRun) {
      for (const part of chunk(clearSkus, 100)) {
        await restPatch(`products?sku=${inList(part)}`, { on_sale: false, sale_price_cad: null });
      }
      const applied = await mapLimit(cadRows, 10, (r) =>
        restPatch(`products?sku=eq.${encodeURIComponent(r.sku)}`, {
          on_sale: true,
          sale_price_cad: r.promo_price_cad,
        }));
      applied.forEach((res, i) => {
        if (res.status === "rejected") errors.push(`store ${cadRows[i].sku}: ${(res.reason as Error).message}`);
      });
      for (const p of toEnd) {
        await restPatch(`promotions?id=eq.${p.id}`, { status: "ended", ended_at: nowIso });
      }
    }

    if (settings.wix !== false) {
      const affected = [...new Set([...targetCadSkus, ...clearSkus])];
      const linkedCa = new Set<string>();
      for (const part of chunk(affected, 100)) {
        const list = inList(part);
        const [ca, legacy] = await Promise.all([
          restGet<{ sku: string }[]>(`wix_links?site=eq.sinksdirect_ca&sku=${list}&select=sku`),
          restGet<{ sku: string }[]>(`products?select=sku&wix_product_id=not.is.null&sku=${list}`),
        ]);
        ca.forEach((r) => linkedCa.add(r.sku));
        legacy.forEach((r) => linkedCa.add(r.sku));
      }
      // PIM row already holds the truth (post-apply): MAP base + sale fields.
      const jobs: WixJob[] = [...linkedCa].map((sku) => ({ sku, site: "sinksdirect_ca", only: ["priceData", "discount"] }));
      const wixCa = await pushWixJobs(jobs, dryRun, errors, wixCtx);
      report.ca = { members: cadRows.length, linked: linkedCa.size, ...wixCa.sinksdirect_ca };
      caOwed += wixPending(wixCa, ["sinksdirect_ca"]);

      // Azuni store (Azuni products only, sells at MAP CAD, no sale fields):
      // the promo travels as the price itself — promo MAP while the Canada
      // window is open, regular MAP once it ends. Same pattern as SinksDirect US.
      const linkedAz = new Set<string>();
      for (const part of chunk(affected, 100)) {
        const az = await restGet<{ sku: string }[]>(`wix_links?site=eq.azuni_ca&sku=${inList(part)}&select=sku`);
        az.forEach((r) => linkedAz.add(r.sku));
      }
      if (linkedAz.size) {
        const promoCad = new Map(cadRows.map((r) => [r.sku, r.promo_price_cad]));
        const mapCad = new Map<string, number | null>();
        for (const part of chunk([...linkedAz], 100)) {
          const rows = await restGet<{ sku: string; map_cad: number | null }[]>(`products?select=sku,map_cad&sku=${inList(part)}`);
          rows.forEach((r) => mapCad.set(r.sku, r.map_cad));
        }
        const azJobs: WixJob[] = [...linkedAz]
          .map((sku) => ({ sku, site: "azuni_ca", only: ["priceData"], fields: { map_cad: promoCad.get(sku) ?? mapCad.get(sku) ?? null } }))
          .filter((j) => (j.fields as { map_cad: number | null }).map_cad != null);
        const wixAz = await pushWixJobs(azJobs, dryRun, errors, wixCtx);
        report.azuni_ca = { linked: linkedAz.size, ...wixAz.azuni_ca };
        caOwed += wixPending(wixAz, ["azuni_ca"]);
      }
    }

    // Safety net: the day-before prep normally schedules Best Buy. If it
    // didn't (promo loaded late / toggle off / offers still running the
    // ending promotion), send it now — a window that already began goes
    // live as soon as Mirakl imports it (whole days, see bbDiscount).
    if (chain === 0 && settings.bestbuy !== false && caTarget && cadRows.length && !caTarget.bb_scheduled_at) {
      try {
        const w = win(caTarget, "ca");
        const start = w.start > today ? w.start : today;
        report.bestbuy = await scheduleBestBuy(await withoutExcluded(cadRows, "bestbuy"), start, w.end, dryRun);
        if (!dryRun) {
          const sent = report.bestbuy as Record<string, unknown>;
          await restPatch(`promotions?id=eq.${caTarget.id}`, {
            bb_scheduled_at: nowIso,
            ...(!sent.skipped && Number(sent.listed ?? 0) > 0 ? { bb_schedule: bbScheduleRecord(caTarget, sent, nowIso) } : {}),
          });
        }
      } catch (err) {
        errors.push(`bestbuy: ${(err as Error).message}`);
      }
    }
    // Same safety net for Walmart Canada.
    if (chain === 0 && settings.walmart_ca !== false && caTarget && cadRows.length && !caTarget.wm_ca_scheduled_at) {
      try {
        report.walmart_ca = await scheduleWalmart("ca", caTarget.id, dryRun);
      } catch (err) {
        errors.push(`walmart ca: ${(err as Error).message}`);
      }
    }

    wixOwed += caOwed;
    if (!dryRun && caTarget && caOwed === 0) {
      await restPatch(`promotions?id=eq.${caTarget.id}`, {
        ca_applied_at: nowIso,
        ...(caTarget.status === "draft" ? { status: "active", activated_at: nowIso } : {}),
      });
    }
  }

  // -- 5. prep pass: tomorrow is Canada's first Thursday ---------------------
  if (doPrep && settings.bestbuy !== false && prepTarget) {
    try {
      const rows = await withoutExcluded((await promoPrices(prepTarget.id)).filter((r) => r.promo_price_cad != null), "bestbuy");
      if (rows.length) {
        const w = win(prepTarget, "ca");
        report.prep = await scheduleBestBuy(rows, w.start, w.end, dryRun, true);
        if (!dryRun) {
          const sent = report.prep as Record<string, unknown>;
          // Offers still running the ending promotion were left for the
          // boundary-day pass: stamping now would skip them.
          const deferred = Number(sent.deferred_running ?? 0) > 0;
          await restPatch(`promotions?id=eq.${prepTarget.id}`, {
            ...(deferred ? {} : { bb_scheduled_at: nowIso }),
            ...(!sent.skipped && Number(sent.listed ?? 0) > 0 ? { bb_schedule: bbScheduleRecord(prepTarget, sent, nowIso) } : {}),
          });
        }
      }
    } catch (err) {
      errors.push(`bestbuy prep: ${(err as Error).message}`);
    }
  }
  // Walmart: the day before each market's window opens, its promotional
  // prices go in (Walmart starts them on the window's first minute). Once
  // per promotion — the stamp says it is done.
  if (prepTarget && settings.walmart_ca !== false && !prepTarget.wm_ca_scheduled_at) {
    try {
      report.walmart_ca_prep = await scheduleWalmart("ca", prepTarget.id, dryRun);
    } catch (err) {
      errors.push(`walmart ca prep: ${(err as Error).message}`);
    }
  }
  if (prepUsTarget && settings.walmart_us !== false && !prepUsTarget.wm_us_scheduled_at) {
    try {
      report.walmart_us_prep = await scheduleWalmart("us", prepUsTarget.id, dryRun);
    } catch (err) {
      errors.push(`walmart us prep: ${(err as Error).message}`);
    }
  }

  // -- 6. Wix changes still owed: the next run of the chain finishes them ----
  if (!dryRun && !lockedByOther && (doUS || doCA)) {
    progress.lock_until = null;
    try {
      await saveWixProgress(progress);
    } catch (err) {
      errors.push(`wix progress: ${(err as Error).message}`);
    }
    if (wixOwed > 0) {
      report.wix_owed = wixOwed;
      if (chain < WIX_MAX_CHAIN) {
        try {
          const resp = await fetch(`${SUPABASE_URL}/functions/v1/promo-apply`, {
            method: "POST",
            headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ chain: chain + 1, reconcile }),
          });
          if (!resp.ok) throw new Error(`${resp.status} ${(await resp.text()).slice(0, 200)}`);
          report.wix_continuing = chain + 1;
        } catch (err) {
          errors.push(`wix continuation: ${(err as Error).message} — the next nightly run (or Run now) finishes the ${wixOwed} left`);
        }
      } else {
        errors.push(`wix: ${wixOwed} changes still refused after ${WIX_MAX_CHAIN} continuation runs — use Run now in Settings`);
      }
    }
  }

  report.errors = errors;
  report.ok = errors.length === 0;

  // -- 7. audit trail --------------------------------------------------------
  if (!dryRun) {
    const parts: string[] = [];
    if (chain > 0) parts.push(`Wix continuation ${chain}`);
    if (doUS) parts.push(usTarget ? `USA on promo "${usTarget.name}"` : "USA back to regular prices");
    if (doCA) parts.push(caTarget ? `Canada on promo "${caTarget.name}"` : "Canada back to regular prices");
    if (lockedByOther) parts.push("Wix left to the run still pushing");
    else if (report.wix_owed) parts.push(`Wix: ${report.wix_owed} changes left${report.wix_continuing ? ", continuing" : ""}`);
    if (doPrep && prepTarget && settings.bestbuy !== false) parts.push(`Best Buy scheduled for "${prepTarget.name}" (starts tomorrow)`);
    const sent = (r: unknown) => r && !(r as Record<string, unknown>).skipped;
    if (sent(report.walmart_ca_prep)) parts.push(`Walmart Canada scheduled for "${prepTarget?.name}" (starts tomorrow)`);
    if (sent(report.walmart_us_prep)) parts.push(`Walmart USA scheduled for "${prepUsTarget?.name}" (starts tomorrow)`);
    if (sent(report.walmart_ca)) parts.push(`Walmart Canada scheduled for "${caTarget?.name}"`);
    if (sent(report.walmart_us)) parts.push(`Walmart USA scheduled for "${usTarget?.name}"`);
    try {
      await restPost("audit_log", {
        action: "push",
        entity_type: "promotion",
        entity_id: String(usTarget?.id ?? caTarget?.id ?? prepTarget?.id ?? ""),
        target: "automation",
        summary: `Promo automation: ${parts.join(" · ") || "nothing to do"}`,
        metadata: report,
      });
    } catch (err) {
      console.error("[promo-apply] audit insert failed:", (err as Error).message);
    }
  }

  console.log("[promo-apply] report:", JSON.stringify(report));
  return report;
}

// ---------- server ----------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const cronSecret = Deno.env.get("CRON_SECRET");
    const provided = req.headers.get("x-cron-secret");
    const auth = req.headers.get("authorization") ?? "";
    const bearer = auth.replace(/^Bearer\s+/i, "").trim();
    let authorized = Boolean(cronSecret && provided === cronSecret) || await isServiceRole(SUPABASE_URL, bearer, SERVICE_KEY);

    if (!authorized && auth.startsWith("Bearer ")) {
      // Settings page "Run now": an authenticated ADMIN may trigger a run.
      const token = auth.slice(7).trim();
      const caller = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: { user } } = await caller.auth.getUser();
      if (user) {
        const admin = createClient(SUPABASE_URL, SERVICE_KEY);
        const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
        authorized = profile?.role === "admin";
      }
    }
    if (!authorized) return json({ error: "unauthorized" }, 401);

    let sync = false;
    let dryRun = false;
    let chain = 0;
    let chainReconcile = false;
    try {
      const body = await req.json();
      sync = body?.sync === true;
      dryRun = body?.dryRun === true;
      chain = Math.max(0, Math.min(WIX_MAX_CHAIN, Math.floor(Number(body?.chain) || 0)));
      chainReconcile = body?.reconcile === true;
    } catch { /* empty body → cron background mode */ }

    // A continuation run (chained by a run that left Wix changes owed):
    // in the background, same mode as the run that started the chain.
    if (chain > 0 && !dryRun) {
      // @ts-ignore — EdgeRuntime is provided by the Supabase runtime
      EdgeRuntime.waitUntil(run(false, chainReconcile, { chain }).catch((err) => console.error("[promo-apply] chain FAILED:", (err as Error).message)));
      return json({ ok: true, started: true, chain }, 202);
    }

    // Manual runs reconcile (re-apply today's truth); cron runs are
    // boundary-triggered and stamped.
    if (sync || dryRun) return json(await run(dryRun, true));

    // @ts-ignore — EdgeRuntime is provided by the Supabase runtime
    EdgeRuntime.waitUntil(run(false, false));
    return json({ ok: true, started: true }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[promo-apply] FAILED:", message);
    return json({ error: message }, 500);
  }
});
