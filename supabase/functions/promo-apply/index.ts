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
// skips.
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
//     future, which Mirakl requires).
//   Manual "Run now" (body {sync:true}) RECONCILES: re-applies whatever
//   should be live today on both markets, dates aside.
//
// Auth: `x-cron-secret` header, the service-role key as Bearer, or an
// authenticated ADMIN user (the Settings page's "Run now").
// Body: { sync?: boolean, dryRun?: boolean } — dryRun computes the full plan
// and writes/pushes nothing (implies sync + reconcile).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  activePeriodFor,
  etToday,
  marketWindow,
  periodOfDay,
  prevPeriod,
} from "../_shared/promoCalendar.ts";

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
  us_applied_at: string | null;
  ca_applied_at: string | null;
  bb_scheduled_at: string | null;
}
interface PriceRow { sku: string; promo_price_cad: number | null; promo_price_usd: number | null }

async function promoPrices(promoId: number): Promise<PriceRow[]> {
  return await restGet<PriceRow[]>(
    `promotion_prices?promotion_id=eq.${promoId}&select=sku,promo_price_cad,promo_price_usd`,
  );
}

// ---------- Wix push helper -------------------------------------------------

interface WixJob { sku: string; site: string; only: string[]; fields?: Record<string, unknown> }

async function pushWixJobs(jobs: WixJob[], dryRun: boolean, errors: string[]) {
  const out: Record<string, { pushed: number; failed: number }> = {};
  for (const j of jobs) out[j.site] = out[j.site] ?? { pushed: 0, failed: 0 };
  if (dryRun || !jobs.length) return out;
  const results = await mapLimit(jobs, 5, async (job) => {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/wix-push-product`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(job),
    });
    if (!resp.ok) throw new Error(`${job.sku} (${job.site}): ${((await resp.json().catch(() => ({}))) as { error?: string }).error ?? resp.status}`);
    return job;
  });
  results.forEach((res, i) => {
    if (res.status === "fulfilled") out[jobs[i].site].pushed += 1;
    else {
      out[jobs[i].site].failed += 1;
      if (errors.length < 25) errors.push(`wix ${(res.reason as Error).message}`);
    }
  });
  return out;
}

// ---------- Best Buy scheduled discounts ------------------------------------

// Mirakl runs OF24 in NORMAL mode: any field missing from a line is BLANKED
// on the offer (2026-08-28: a price-only import zeroed the stock of 127 live
// offers). Read the live offers first and carry quantity (and price when the
// PIM has no MAP) on every line.
async function readLiveOffers(bbKey: string): Promise<Map<string, { price: number | null; quantity: number }>> {
  const live = new Map<string, { price: number | null; quantity: number }>();
  let offset = 0;
  for (;;) {
    const res = await fetch(`${MIRAKL_BASE}/api/offers?max=100&offset=${offset}`, {
      headers: { Authorization: bbKey, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Best Buy live offers read failed (${res.status}) — promo NOT sent to Best Buy`);
    const data = await res.json();
    for (const o of data.offers ?? []) live.set(o.shop_sku, { price: o.price ?? null, quantity: o.quantity ?? 0 });
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
  for (const r of cadRows) {
    const cur = liveOffers.get(r.sku);
    if (!cur) { notListed += 1; continue; }
    const map = mapCad.get(r.sku);
    if (map != null && (r.promo_price_cad as number) >= map) { skipped += 1; continue; }
    const price = map ?? cur.price;
    if (price == null) continue;
    offers.push({
      shop_sku: r.sku,
      update_delete: "update",
      price,
      quantity: cur.quantity,
      discount_price: r.promo_price_cad,
      // volume-pricing instance: the discount value lives in ranges
      discount_ranges: [{ price: r.promo_price_cad, quantity_threshold: 1 }],
      discount_start_date: start,
      discount_end_date: end,
    });
  }
  const report: Record<string, unknown> = {
    window: { start, end },
    listed: offers.length,
    not_listed: notListed,
    skipped_at_or_above_map: skipped,
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

// ---------- the run ---------------------------------------------------------

async function run(dryRun: boolean, reconcile: boolean) {
  const today = etToday();
  const tomorrow = etToday(1);
  const nowIso = new Date().toISOString();
  const report: Record<string, unknown> = { today, dryRun, mode: reconcile ? "reconcile" : "cron" };
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
    "promotions?select=id,name,period,status,us_applied_at,ca_applied_at,bb_scheduled_at&status=in.(draft,active)&order=id.desc",
  );
  const pick = (period: string | null): PromoRow | null => {
    if (!period) return null;
    const c = promos.filter((p) => p.period === period);
    return c.find((p) => p.status === "active") ?? c[0] ?? null;
  };

  const usPeriod = activePeriodFor("us", today); // always the current month
  const caPeriod = activePeriodFor("ca", today); // current month, or previous before its 1st Thursday
  const usTarget = pick(usPeriod);
  const caTarget = pick(caPeriod);
  report.periods = { us: usPeriod, ca: caPeriod };
  report.target = { us: usTarget?.name ?? null, ca: caTarget?.name ?? null };

  // -- 2. which passes fire today -------------------------------------------
  const usStartsToday = today === periodOfDay(today); // the 1st
  const caStartsToday = caPeriod != null && today === marketWindow(caPeriod, "ca").start;
  const prepPeriod = marketWindow(periodOfDay(tomorrow), "ca").start === tomorrow
    ? periodOfDay(tomorrow)
    : null;

  const doUS = reconcile || (usStartsToday && !usTarget?.us_applied_at);
  const doCA = reconcile || (caStartsToday && !caTarget?.ca_applied_at);
  // The prep pass always (re)schedules — it overwrites idempotently, and an
  // earlier schedule may carry an outdated window (e.g. pre-calendar-change).
  const prepTarget = pick(prepPeriod);
  const doPrep = prepTarget != null;

  if (!doUS && !doCA && !doPrep) {
    return { ...report, skipped: "no promo boundary today" };
  }

  // -- 3. US pass: SinksDirect US to this month's promo USD ------------------
  if (doUS && settings.wix !== false) {
    const targetRows = usTarget ? await promoPrices(usTarget.id) : [];
    const prevPromo = pick(prevPeriod(usPeriod ?? periodOfDay(today)));
    const prevRows = prevPromo ? await promoPrices(prevPromo.id) : [];
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
    const wixUs = await pushWixJobs(jobs, dryRun, errors);
    report.us = { members: promoUsd.size, linked: linkedUs.size, ...wixUs.sinksdirect_us };

    if (!dryRun && usTarget) {
      await restPatch(`promotions?id=eq.${usTarget.id}`, {
        us_applied_at: nowIso,
        ...(usTarget.status === "draft" ? { status: "active", activated_at: nowIso } : {}),
      });
    }
  }

  // -- 4. CA pass: store pricing + SinksDirect CA on the first Thursday ------
  if (doCA) {
    const targetRows = caTarget ? await promoPrices(caTarget.id) : [];
    const cadRows = targetRows.filter((r) => r.promo_price_cad != null);
    const targetCadSkus = new Set(cadRows.map((r) => r.sku));

    // Previous promos whose Canada window is over: their members leave the
    // sale (unless carried into the new list), and the promo ends.
    const toEnd = promos.filter((p) =>
      p.status === "active" && p.id !== caTarget?.id && marketWindow(p.period, "ca").end < today
    );
    const endSkus = new Set<string>();
    for (const p of toEnd) {
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
      const wixCa = await pushWixJobs(jobs, dryRun, errors);
      report.ca = { members: cadRows.length, linked: linkedCa.size, ...wixCa.sinksdirect_ca };
    }

    // Safety net: the day-before prep normally schedules Best Buy. If it
    // didn't (promo loaded late / toggle off), schedule from tomorrow —
    // Mirakl drops start dates that are not in the future.
    if (settings.bestbuy !== false && caTarget && cadRows.length && !caTarget.bb_scheduled_at) {
      try {
        const w = marketWindow(caTarget.period, "ca");
        const start = w.start > today ? w.start : tomorrow;
        report.bestbuy = await scheduleBestBuy(cadRows, start, w.end, dryRun);
        if (!dryRun) await restPatch(`promotions?id=eq.${caTarget.id}`, { bb_scheduled_at: nowIso });
      } catch (err) {
        errors.push(`bestbuy: ${(err as Error).message}`);
      }
    }

    if (!dryRun && caTarget) {
      await restPatch(`promotions?id=eq.${caTarget.id}`, {
        ca_applied_at: nowIso,
        ...(caTarget.status === "draft" ? { status: "active", activated_at: nowIso } : {}),
      });
    }
  }

  // -- 5. prep pass: tomorrow is Canada's first Thursday ---------------------
  if (doPrep && settings.bestbuy !== false && prepTarget) {
    try {
      const rows = (await promoPrices(prepTarget.id)).filter((r) => r.promo_price_cad != null);
      if (rows.length) {
        const w = marketWindow(prepTarget.period, "ca");
        report.prep = await scheduleBestBuy(rows, w.start, w.end, dryRun);
        if (!dryRun) await restPatch(`promotions?id=eq.${prepTarget.id}`, { bb_scheduled_at: nowIso });
      }
    } catch (err) {
      errors.push(`bestbuy prep: ${(err as Error).message}`);
    }
  }

  report.errors = errors;
  report.ok = errors.length === 0;

  // -- 6. audit trail --------------------------------------------------------
  if (!dryRun) {
    const parts: string[] = [];
    if (doUS) parts.push(usTarget ? `USA on promo "${usTarget.name}"` : "USA back to regular prices");
    if (doCA) parts.push(caTarget ? `Canada on promo "${caTarget.name}"` : "Canada back to regular prices");
    if (doPrep && prepTarget) parts.push(`Best Buy scheduled for "${prepTarget.name}" (starts tomorrow)`);
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
    let authorized = (cronSecret && provided === cronSecret) || auth === `Bearer ${SERVICE_KEY}`;

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
    try {
      const body = await req.json();
      sync = body?.sync === true;
      dryRun = body?.dryRun === true;
    } catch { /* empty body → cron background mode */ }

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
