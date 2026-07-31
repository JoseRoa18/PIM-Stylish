// Stylish PIM — scheduled channel + listing-health refresh.
//
// Runs twice a day via pg_cron (11:00 & 18:00 UTC = 7 am & 2 pm Venezuela):
//   1. Pulls the read-only channel states (Best Buy offers, Walmart US items,
//      Walmart CA feed) by invoking the existing pull functions, and persists
//      the same channel_health snapshots the browser flows write.
//   2. Re-scores the whole catalog with the shared listing-health pipeline
//      (supabase/functions/_shared/listingHealth.js — the exact same rules
//      the app uses) and persists the per-marketplace summaries the
//      Dashboard reads (channel = 'listing_health').
//
// The Wayfair spec audit is NOT run here — it stays a manual ~1 min run from
// the Wayfair workspace; the re-score simply uses its latest snapshot.
//
// Auth: `x-cron-secret` header matching the CRON_SECRET function secret
// (deployed with --no-verify-jwt so pg_net can call it), or the service_role
// key as Bearer for manual runs. Body {"sync": true} waits for completion
// and returns the full report (for testing); otherwise the work continues
// in the background and a 202 is returned immediately so short pg_net
// timeouts can't kill the run.

// @ts-ignore — plain JS module shared with the browser app
import { buildListingHealthData, buildSummaryRows } from "../_shared/listingHealth.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res;
}

async function restSelect(path: string) {
  return (await rest(path)).json();
}

async function restInsert(table: string, rows: unknown) {
  await rest(table, {
    method: "POST",
    body: JSON.stringify(rows),
    headers: { Prefer: "return=minimal" },
  });
}

// Invoke a sibling edge function with the service key.
async function invokeFn(name: string, body: unknown = {}) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data?.error) throw new Error(data?.error ?? `${name} ${res.status}`);
  return data;
}

async function latestSnapshotMap(channel: string) {
  try {
    const rows = await restSelect(
      `channel_health?channel=eq.${channel}&select=results&order=run_at.desc&limit=1`,
    );
    const results = rows?.[0]?.results;
    if (Array.isArray(results)) {
      return new Map(results.map((r: { sku: string }) => [r.sku, r]));
    }
  } catch {
    // score without sync data rather than failing the run
  }
  return null;
}

// ---- Channel pulls (mirror the browser flows in bestbuySync/walmartSync) ----

async function refreshBestBuy() {
  const { total, offers } = await invokeFn("bestbuy-pull-offers");
  const prods = await restSelect("products?select=sku,msrp_cad");
  const msrpBySku = new Map(prods.map((p: { sku: string; msrp_cad: number }) => [p.sku, p.msrp_cad]));

  const results = offers.map((o: { sku: string; price: number | null }) => ({
    ...o,
    msrp: msrpBySku.get(o.sku) ?? null,
  }));
  const priceMismatches = results.filter(
    (o: { msrp: number | null; price: number | null }) =>
      o.msrp != null && o.price != null && Math.abs(o.price - o.msrp) > 0.01,
  ).length;

  await restInsert("channel_health", [{
    channel: "bestbuy",
    target: "marketplace.bestbuy.ca",
    total,
    in_sync: results.filter((o: { active: boolean }) => o.active).length,
    with_diffs: priceMismatches,
    errors: results.filter((o: { quantity: number | null }) => (o.quantity ?? 0) === 0).length,
    partial: false,
    results,
  }]);
  return { total, priceMismatches };
}

async function refreshWalmart(market: "us" | "ca") {
  const { total, items } = await invokeFn("walmart-pull-items", market === "ca" ? { market: "ca" } : {});

  const okCount = market === "ca"
    ? items.filter((i: { feedStatus: string }) => i.feedStatus === "SUCCESS").length
    : items.filter((i: { published: string }) => i.published === "PUBLISHED").length;

  await restInsert("channel_health", [{
    channel: market === "ca" ? "walmart_ca" : "walmart_us",
    target: "marketplace.walmartapis.com",
    total,
    in_sync: okCount,
    with_diffs: total - okCount,
    errors: 0,
    partial: false,
    results: items,
  }]);
  return { total, okCount };
}

// ---- The full refresh ----

async function runRefresh() {
  const report: {
    ok: boolean;
    steps: Record<string, unknown>;
    errors: string[];
  } = { ok: true, steps: {}, errors: [] };

  // Channel pulls in parallel; one channel being down must not stop the rest.
  const [bb, wmUs, wmCa] = await Promise.allSettled([
    refreshBestBuy(),
    refreshWalmart("us"),
    refreshWalmart("ca"),
  ]);
  if (bb.status === "fulfilled") report.steps.bestbuy = bb.value;
  else report.errors.push(`bestbuy: ${bb.reason?.message ?? bb.reason}`);
  if (wmUs.status === "fulfilled") report.steps.walmart_us = wmUs.value;
  else report.errors.push(`walmart_us: ${wmUs.reason?.message ?? wmUs.reason}`);
  if (wmCa.status === "fulfilled") report.steps.walmart_ca = wmCa.value;
  else report.errors.push(`walmart_ca: ${wmCa.reason?.message ?? wmCa.reason}`);

  // Re-score the catalog against the (now fresh) snapshots.
  try {
    const list = await restSelect(
      "products?select=*,product_media(id,storage_path,media_type,is_primary,display_order)&limit=2000",
    );
    const { perMarketplaceData } = buildListingHealthData(list, {
      wayfairMap: await latestSnapshotMap("wayfair"),
      bestbuyMap: await latestSnapshotMap("bestbuy"),
      walmartMaps: {
        walmart_us: await latestSnapshotMap("walmart_us"),
        walmart_ca: await latestSnapshotMap("walmart_ca"),
      },
    });
    await restInsert("channel_health", buildSummaryRows(perMarketplaceData));
    report.steps.listing_health = Object.fromEntries(
      Object.entries(perMarketplaceData).map(
        ([mkt, data]) => [mkt, (data as { stats: { avgScore: number } }).stats.avgScore],
      ),
    );
  } catch (err) {
    report.errors.push(`listing_health: ${(err as Error).message}`);
  }

  report.ok = report.errors.length === 0;
  console.log("health-refresh report:", JSON.stringify(report));
  return report;
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const providedSecret = req.headers.get("x-cron-secret");
  const auth = req.headers.get("authorization") ?? "";
  const authorized =
    (cronSecret && providedSecret === cronSecret) || auth === `Bearer ${SERVICE_KEY}`;
  if (!authorized) return json({ error: "unauthorized" }, 401);

  let sync = false;
  try {
    const body = await req.json();
    sync = body?.sync === true;
  } catch {
    // empty body → background mode
  }

  if (sync) return json(await runRefresh());

  // Background mode: acknowledge immediately so the pg_net caller can
  // disconnect; the refresh keeps running to completion.
  // @ts-ignore — EdgeRuntime is provided by the Supabase runtime
  EdgeRuntime.waitUntil(runRefresh());
  return json({ ok: true, started: true }, 202);
});
