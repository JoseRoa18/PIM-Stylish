// promo-apply — automatic monthly promotion rollover.
//
// Called by pg_cron on the 1st of every month at 04:00 UTC (= 00:00
// America/Caracas; see 20260818_promo_apply_cron.sql). Honors the
// 'promo_automation' app_setting — the switches live in /settings.
//
// What one run does (all idempotent, safe to re-run):
//   1. Ends every ACTIVE promotion of a previous month: clears
//      on_sale/sale_price_cad on its member SKUs, status → ended.
//   2. Applies the promotion whose period is the CURRENT month (draft or
//      active): sets on_sale + sale_price_cad from the CAD promo list,
//      status → active. If no promotion is loaded for the month, nothing is
//      invented — prices simply return to regular and the audit log says so.
//   3. Pushes the resulting prices to the promo-aware Wix sites:
//        - SinksDirect CA: priceData + discount from the PIM row (MAP base,
//          promo as the sale) — via wix-push-product, price fields only.
//        - SinksDirect US: priceData = promo USD ?? MAP USD (field override —
//          the PIM sale columns are CAD-only).
//      Stylish brand sites sell at MSRP and are never touched.
//   4. Best Buy safety net: re-submits the month's scheduled discounts to
//      Mirakl (they are normally scheduled when the promo is loaded, and
//      Mirakl flips them at the start date on its own — this catches promos
//      loaded while the toggle was off).
//
// Auth: `x-cron-secret` header, the service-role key as Bearer, or an
// authenticated ADMIN user (the Settings page's "Run now").
// Body: { sync?: boolean, dryRun?: boolean } — dryRun computes the full plan
// and writes/pushes nothing (implies sync).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

// ---------- date helpers (Venezuela = UTC-4, no DST) ------------------------

function vetPeriodToday(): string {
  const vet = new Date(Date.now() - 4 * 3600_000);
  return `${vet.getUTCFullYear()}-${String(vet.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function monthEnd(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)); // day 0 of next month
  return `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, "0")}-${String(last.getUTCDate()).padStart(2, "0")}`;
}

// ---------- the run ---------------------------------------------------------

interface PromoRow { id: number; name: string; period: string; status: string }
interface PriceRow { sku: string; promo_price_cad: number | null; promo_price_usd: number | null }

async function run(dryRun: boolean) {
  const period = vetPeriodToday();
  const nowIso = new Date().toISOString();
  const report: Record<string, unknown> = { period, dryRun };
  const errors: string[] = [];

  // -- 0. settings gate ------------------------------------------------------
  const settingRows = await restGet<{ value: Record<string, unknown> }[]>(
    "app_settings?key=eq.promo_automation&select=value",
  );
  const settings = settingRows[0]?.value ?? {};
  if (settings.enabled === false) {
    return { ...report, skipped: "promo automation is disabled in Settings" };
  }

  // -- 1. find this month's promo + previous active ones ---------------------
  const promos = await restGet<PromoRow[]>(
    "promotions?select=id,name,period,status&status=in.(draft,active)&order=id.desc",
  );
  const candidates = promos.filter((p) => p.period === period);
  const target = candidates.find((p) => p.status === "active") ?? candidates[0] ?? null;
  const toEnd = promos.filter((p) => p.status === "active" && p.period < period);
  report.target = target ? { id: target.id, name: target.name } : null;
  report.ending = toEnd.map((p) => ({ id: p.id, name: p.name }));

  const targetRows = target
    ? await restGet<PriceRow[]>(
      `promotion_prices?promotion_id=eq.${target.id}&select=sku,promo_price_cad,promo_price_usd`,
    )
    : [];
  const endSkus = new Set<string>();
  for (const p of toEnd) {
    const rows = await restGet<{ sku: string }[]>(`promotion_prices?promotion_id=eq.${p.id}&select=sku`);
    for (const r of rows) endSkus.add(r.sku);
  }

  // -- 2. store pricing ------------------------------------------------------
  const cadRows = targetRows.filter((r) => r.promo_price_cad != null);
  const targetCadSkus = new Set(cadRows.map((r) => r.sku));
  const clearSkus = [...endSkus].filter((s) => !targetCadSkus.has(s));
  report.store = { cleared: clearSkus.length, on_sale: cadRows.length };

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
    if (target && target.status === "draft") {
      await restPatch(`promotions?id=eq.${target.id}`, { status: "active", activated_at: nowIso });
    }
  }

  // -- 3. Wix (promo-aware sites only) ---------------------------------------
  const affected = [...new Set([...endSkus, ...targetRows.map((r) => r.sku)])];
  if (settings.wix !== false && affected.length) {
    // Which of the affected SKUs are linked, per site.
    const linkedCa = new Set<string>();
    const linkedUs = new Set<string>();
    const usdBySku = new Map<string, number | null>(); // PIM map_usd fallback
    for (const part of chunk(affected, 100)) {
      const list = inList(part);
      const [ca, us, legacy, prods] = await Promise.all([
        restGet<{ sku: string }[]>(`wix_links?site=eq.sinksdirect_ca&sku=${list}&select=sku`),
        restGet<{ sku: string }[]>(`wix_links?site=eq.sinksdirect_us&sku=${list}&select=sku`),
        restGet<{ sku: string }[]>(`products?select=sku&wix_product_id=not.is.null&sku=${list}`),
        restGet<{ sku: string; map_usd: number | null }[]>(`products?select=sku,map_usd&sku=${list}`),
      ]);
      ca.forEach((r) => linkedCa.add(r.sku));
      legacy.forEach((r) => linkedCa.add(r.sku));
      us.forEach((r) => linkedUs.add(r.sku));
      prods.forEach((r) => usdBySku.set(r.sku, r.map_usd));
    }

    const promoUsd = new Map(targetRows.filter((r) => r.promo_price_usd != null).map((r) => [r.sku, r.promo_price_usd]));
    const jobs: { sku: string; site: string; only: string[]; fields?: Record<string, unknown> }[] = [];
    for (const sku of linkedCa) {
      // PIM row already holds the truth (post-apply): MAP base + sale fields.
      jobs.push({ sku, site: "sinksdirect_ca", only: ["priceData", "discount"] });
    }
    for (const sku of linkedUs) {
      const expected = promoUsd.get(sku) ?? usdBySku.get(sku) ?? null;
      if (expected == null) continue; // nothing to price it at
      jobs.push({ sku, site: "sinksdirect_us", only: ["priceData"], fields: { map_usd: expected } });
    }

    const wixReport = {
      sinksdirect_ca: { linked: linkedCa.size, pushed: 0, failed: 0 },
      sinksdirect_us: { linked: linkedUs.size, pushed: 0, failed: 0 },
    };
    if (!dryRun) {
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
        const site = jobs[i].site as keyof typeof wixReport;
        if (res.status === "fulfilled") wixReport[site].pushed += 1;
        else {
          wixReport[site].failed += 1;
          if (errors.length < 25) errors.push(`wix ${(res.reason as Error).message}`);
        }
      });
    }
    report.wix = wixReport;
  }

  // -- 4. Best Buy safety net (scheduled discounts for the month) ------------
  const BB_KEY = Deno.env.get("BESTBUY_API_KEY");
  if (settings.bestbuy !== false && target && cadRows.length && BB_KEY) {
    try {
      const snap = await restGet<{ results: { sku: string }[] }[]>(
        "channel_health?channel=eq.bestbuy&select=results&order=run_at.desc&limit=1",
      );
      const listed = new Set((snap[0]?.results ?? []).map((o) => o.sku));
      const mapCad = new Map<string, number | null>();
      for (const part of chunk(cadRows.map((r) => r.sku), 100)) {
        const prods = await restGet<{ sku: string; map_cad: number | null }[]>(
          `products?select=sku,map_cad&sku=${inList(part)}`,
        );
        prods.forEach((p) => mapCad.set(p.sku, p.map_cad));
      }
      const end = monthEnd(period);
      // Mirakl runs OF24 in NORMAL mode: any field missing from a line is
      // BLANKED on the offer (2026-08-28: a price-only import zeroed the stock
      // of 127 live offers). Read the live offers first and carry quantity
      // (and price when the PIM has no MAP) on every line.
      const liveOffers = new Map<string, { price: number | null; quantity: number }>();
      let offset = 0;
      for (;;) {
        const res = await fetch(`https://marketplace.bestbuy.ca/api/offers?max=100&offset=${offset}`, {
          headers: { Authorization: BB_KEY, Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`Best Buy live offers read failed (${res.status}) — promo NOT sent to Best Buy`);
        const data = await res.json();
        for (const o of data.offers ?? []) liveOffers.set(o.shop_sku, { price: o.price ?? null, quantity: o.quantity ?? 0 });
        offset += 100;
        if (!data.offers?.length || offset >= (data.total_count ?? 0)) break;
      }

      const offers: Record<string, unknown>[] = [];
      let skipped = 0;
      for (const r of cadRows) {
        if (!listed.has(r.sku)) continue;
        const map = mapCad.get(r.sku);
        if (map != null && (r.promo_price_cad as number) >= map) { skipped += 1; continue; }
        const cur = liveOffers.get(r.sku);
        if (!cur) continue; // not on Best Buy any more
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
          discount_start_date: period,
          discount_end_date: end,
        });
      }
      const bbReport: Record<string, unknown> = {
        listed: offers.length,
        not_listed: cadRows.length - offers.length - skipped,
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
        bbReport.import_id = body.import_id ?? null;
        // Brief status poll — the discounts are date-scheduled, so a slow
        // import is fine; we just want lines_in_error when it's quick.
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const chk = await fetch(`${MIRAKL_BASE}/api/offers/imports/${body.import_id}`, {
            headers: { Authorization: BB_KEY, Accept: "application/json" },
          });
          if (!chk.ok) continue;
          const st = await chk.json();
          bbReport.import_status = st.status;
          bbReport.lines_in_error = st.lines_in_error ?? 0;
          if (st.status === "COMPLETE" || st.status === "FAILED") break;
        }
      }
      report.bestbuy = bbReport;
    } catch (err) {
      errors.push(`bestbuy: ${(err as Error).message}`);
    }
  }

  report.errors = errors;
  report.ok = errors.length === 0;

  // -- 5. audit trail --------------------------------------------------------
  if (!dryRun) {
    const monthName = new Date(`${period}T12:00:00Z`).toLocaleDateString("en-CA", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    const summary = target
      ? `Promo automation: applied "${target.name}" for ${monthName} — ${cadRows.length} SKUs on sale` +
        (toEnd.length ? `, ended ${toEnd.map((p) => `"${p.name}"`).join(", ")}` : "")
      : `Promo automation: no promotion loaded for ${monthName}` +
        (toEnd.length ? ` — ended ${toEnd.map((p) => `"${p.name}"`).join(", ")}, prices back to regular` : " — nothing to do");
    try {
      await restPost("audit_log", {
        action: target ? "push" : "update",
        entity_type: "promotion",
        entity_id: target ? String(target.id) : null,
        target: "automation",
        summary,
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

    if (sync || dryRun) return json(await run(dryRun));

    // @ts-ignore — EdgeRuntime is provided by the Supabase runtime
    EdgeRuntime.waitUntil(run(false));
    return json({ ok: true, started: true }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[promo-apply] FAILED:", message);
    return json({ error: message }, 500);
  }
});
