// Special events on the Stylish stores (user, 2026-11-09). Every run works out
// which discount each product should have on each store TODAY and changes only
// what differs from what the PIM already put there (table
// stylish_event_discounts), so an event starting, ending, being ended early, a
// product leaving its list or a new percentage all take the same path.
// See _shared/stylishDiscount.js for how a discount is worked out.
//
// Wix lets about 30 changes through and then asks to wait about a minute: a run
// stops when its time is up and the next one (cron every 5 minutes) goes on.
//
// Auth: x-cron-secret or a service-role bearer. Body: { cron?: boolean } —
// the cron honours the promotion automation switches in Settings —, and
// { dryRun: true, asOf?: "YYYY-MM-DD" } = the plan, nothing written.

import { etToday, promoWindow, windowContains } from "../_shared/promoCalendar.ts";
import { isServiceRole } from "../_shared/serviceRole.ts";
import { siteSells, WIX_SITES, type WixSite } from "../_shared/wixSites.ts";
import { discountFor, STYLISH_CHANNELS, STYLISH_SITE_OF } from "../_shared/stylishDiscount.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const RUN_BUDGET_MS = 100_000;
const WIX_CALL_TIMEOUT_MS = 20_000;
const WORKERS = 2;
const GAP_MS = 250;
const MAX_ERRORS = 25;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inList = (values: string[]) => `in.(${values.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(",")})`;
function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const restHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
async function restGet<T>(path: string): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: restHeaders });
  if (!r.ok) throw new Error(`Read ${path.split("?")[0]} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return await r.json() as T;
}
async function restWrite(method: string, path: string, body?: unknown, prefer = "return=minimal"): Promise<void> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { ...restHeaders, Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`Write ${path.split("?")[0]} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

type Applied = { site: string; sku: string; promotion_id: number | null; discount_type: string; discount_value: number; confirmed: boolean };
type Promo = {
  id: number; name: string; period: string; status: string; marketplaces: string[]; stylish_discount: Record<string, unknown> | null;
  starts_on: string | null; ends_on: string | null; ca_starts_on: string | null; ca_ends_on: string | null; us_starts_on: string | null; us_ends_on: string | null;
};
type Wanted = { site: WixSite; sku: string; wixId: string; promotion_id: number; type: string; value: number; storePrice: number };
type Job = { kind: "set"; want: Wanted } | { kind: "clear"; row: Applied; wixId: string | null };

const SITES = STYLISH_CHANNELS.map((channel: string) => ({ channel, site: WIX_SITES[STYLISH_SITE_OF[channel as keyof typeof STYLISH_SITE_OF]] }));

/** What every Stylish product should carry on `today`, and why some cannot. */
async function desiredDiscounts(today: string) {
  const promos = await restGet<Promo[]>(
    `promotions?kind=eq.special&status=neq.ended&stylish_discount=not.is.null&marketplaces=ov.{${STYLISH_CHANNELS.join(",")}}` +
      "&select=id,name,period,status,marketplaces,stylish_discount,starts_on,ends_on,ca_starts_on,ca_ends_on,us_starts_on,us_ends_on",
  );
  const wanted = new Map<string, Wanted>(); // site : sku
  const skipped: { site: string; sku: string; promotion: string; reason: string }[] = [];
  for (const { channel, site } of SITES) {
    // Overlapping events: the later start wins, the way expected prices do.
    const running = promos
      .filter((p) => p.marketplaces.includes(channel))
      .map((p) => ({ p, w: promoWindow(p, site.market) }))
      .filter(({ w }) => windowContains(w, today))
      .sort((a, b) => a.w.start.localeCompare(b.w.start) || a.p.id - b.p.id);
    if (!running.length) continue;

    const members = new Map<number, string[]>();
    for (const { p } of running) {
      const rows = await restGet<{ sku: string; in_ca: boolean | null; in_us: boolean | null }[]>(`promotion_prices?promotion_id=eq.${p.id}&select=sku,in_ca,in_us&limit=1000`);
      members.set(p.id, rows.filter((r) => (site.market === "us" ? r.in_us : r.in_ca) !== false).map((r) => r.sku));
    }
    const skus = [...new Set([...members.values()].flat())];
    const products = new Map<string, Record<string, unknown>>();
    const links = new Map<string, string>();
    for (const part of chunk(skus, 200)) {
      const [ps, ls] = await Promise.all([
        restGet<Record<string, unknown>[]>(`products?sku=${inList(part)}&select=sku,brand,msrp_cad,msrp_usd`),
        restGet<{ sku: string; wix_product_id: string }[]>(`wix_links?site=eq.${site.key}&sku=${inList(part)}&select=sku,wix_product_id`),
      ]);
      for (const x of ps) products.set(String(x.sku), x);
      for (const x of ls) links.set(x.sku, x.wix_product_id);
    }
    const msrpKey = site.market === "us" ? "msrp_usd" : "msrp_cad";
    for (const { p } of running) {
      for (const sku of members.get(p.id) ?? []) {
        const product = products.get(sku);
        // In price mode only the products given a price take part.
        if (p.stylish_discount?.mode === "price" && !(p.stylish_discount?.prices as Record<string, Record<string, number>>)?.[site.market]?.[sku]) continue;
        const skip = (reason: string) => skipped.push({ site: site.key, sku, promotion: p.name, reason });
        if (!product) { skip("not in the PIM"); continue; }
        if (!siteSells(site, product.brand as string)) continue; // Azuni: never on the Stylish stores
        const wixId = links.get(sku);
        if (!wixId) { skip("not on this store"); continue; }
        const d = discountFor(p.stylish_discount, product[msrpKey], site.market, sku);
        if (d.skip) { skip(d.skip); continue; }
        wanted.set(`${site.key}:${sku}`, { site, sku, wixId, promotion_id: p.id, type: d.type, value: d.value, storePrice: d.storePrice });
      }
    }
  }
  return { wanted, skipped, promos: promos.length };
}

async function patchWix(site: WixSite, wixId: string, discount: { type: string; value: number }) {
  const r = await fetch(`https://www.wixapis.com/stores/v1/products/${wixId}`, {
    method: "PATCH",
    headers: { Authorization: Deno.env.get("WIX_API_KEY")!, "wix-site-id": site.siteId, "Content-Type": "application/json" },
    body: JSON.stringify({ product: { discount } }),
    signal: AbortSignal.timeout(WIX_CALL_TIMEOUT_MS),
  });
  const text = await r.text();
  if (r.ok) {
    let live: number | null = null;
    try { live = JSON.parse(text)?.product?.priceData?.discountedPrice ?? null; } catch { /* the change went through all the same */ }
    return { ok: true as const, live };
  }
  const limited = r.status === 429 || /rate limit|too many requests/i.test(text);
  // Wix says "Retry after 56003ms."
  const m = text.match(/retry after\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|seconds)?/i);
  const n = m ? Number(m[1]) : NaN;
  const asked = !Number.isFinite(n) || n <= 0 ? 30_000 : /^s/i.test(m?.[2] ?? "") || (!m?.[2] && n < 300) ? n * 1000 : n;
  return { ok: false as const, limited, waitMs: Math.min(65_000, Math.max(2_000, asked + 500)), message: `${r.status} ${text.slice(0, 160)}` };
}

async function runJobs(jobs: Job[]) {
  const out = { set: 0, cleared: 0, failed: 0, owed: 0, errors: [] as string[], mismatches: [] as string[] };
  const deadline = Date.now() + RUN_BUDGET_MS;
  let next = 0;
  let pausedUntil = 0;
  let stopped = false;

  async function one(job: Job): Promise<"done" | "stop" | "failed"> {
    const siteOf = (key: string) => WIX_SITES[key];
    const site = job.kind === "set" ? job.want.site : siteOf(job.row.site);
    const sku = job.kind === "set" ? job.want.sku : job.row.sku;
    const wixId = job.kind === "set" ? job.want.wixId : job.wixId;
    if (!wixId) {
      // The product left the store: nothing on Wix to take off.
      await restWrite("DELETE", `stylish_event_discounts?site=eq.${site.key}&sku=eq.${encodeURIComponent(sku)}`);
      out.cleared += 1;
      return "done";
    }
    if (job.kind === "set") {
      // Written first: whatever happens next, the store's discount is on record.
      await restWrite("POST", "stylish_event_discounts?on_conflict=site,sku", {
        site: site.key, sku, promotion_id: job.want.promotion_id, discount_type: job.want.type, discount_value: job.want.value,
        store_price: job.want.storePrice, confirmed: false, applied_at: new Date().toISOString(),
      }, "resolution=merge-duplicates,return=minimal");
    }
    const discount = job.kind === "set" ? { type: job.want.type, value: job.want.value } : { type: "AMOUNT", value: 0 };
    for (;;) {
      let r;
      try {
        r = await patchWix(site, wixId, discount);
      } catch (err) {
        if (out.errors.length < MAX_ERRORS) out.errors.push(`${site.key} ${sku}: ${(err as Error).message}`);
        return "failed"; // tried again by the next run
      }
      if (r.ok) {
        if (job.kind === "set") {
          await restWrite("PATCH", `stylish_event_discounts?site=eq.${site.key}&sku=eq.${encodeURIComponent(sku)}`, { confirmed: true, live_price: r.live });
          // A store whose base price is not the PIM's MSRP ends at another price.
          if (r.live != null && Math.abs(r.live - job.want.storePrice) > 0.05 && out.mismatches.length < MAX_ERRORS) out.mismatches.push(`${site.key} ${sku}: store ${r.live}, expected ${job.want.storePrice}`);
          out.set += 1;
        } else {
          await restWrite("DELETE", `stylish_event_discounts?site=eq.${site.key}&sku=eq.${encodeURIComponent(sku)}`);
          out.cleared += 1;
        }
        return "done";
      }
      if (r.limited) {
        pausedUntil = Math.max(pausedUntil, Date.now() + r.waitMs);
        if (pausedUntil + WIX_CALL_TIMEOUT_MS >= deadline) return "stop";
        await sleep(pausedUntil - Date.now());
        continue;
      }
      if (out.errors.length < MAX_ERRORS) out.errors.push(`${site.key} ${sku}: ${r.message}`);
      return "failed";
    }
  }

  const worker = async () => {
    while (next < jobs.length && !stopped) {
      if (pausedUntil > Date.now()) await sleep(pausedUntil - Date.now());
      if (stopped || Date.now() + WIX_CALL_TIMEOUT_MS > deadline) return;
      const job = jobs[next++];
      const r = await one(job);
      if (r === "failed") out.failed += 1;
      if (r === "stop") { out.owed += 1; stopped = true; return; }
      await sleep(GAP_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, jobs.length) }, worker));
  out.owed += Math.max(0, jobs.length - next);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const cronSecret = Deno.env.get("CRON_SECRET");
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const authorized = Boolean(cronSecret && req.headers.get("x-cron-secret") === cronSecret) || await isServiceRole(SUPABASE_URL, bearer, SERVICE_KEY);
    if (!authorized) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun === true;
    const today = dryRun && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf ?? "") ? body.asOf : etToday();

    if (body.cron === true) {
      const rows = await restGet<{ value: { enabled?: boolean; wix?: boolean } }[]>("app_settings?key=eq.promo_automation&select=value");
      const switches = rows[0]?.value ?? {};
      if (switches.enabled === false || switches.wix === false) return json({ skipped: "promotion automation is off in Settings" });
    }

    const [{ wanted, skipped, promos }, applied] = await Promise.all([
      desiredDiscounts(today),
      restGet<Applied[]>("stylish_event_discounts?select=site,sku,promotion_id,discount_type,discount_value,confirmed&limit=1000"),
    ]);

    // Taking discounts off goes first: an event that ended must not wait.
    const seen = new Map(applied.map((r) => [`${r.site}:${r.sku}`, r]));
    const clears = applied.filter((r) => !wanted.has(`${r.site}:${r.sku}`));
    const links = new Map<string, string>();
    for (const site of new Set(clears.map((r) => r.site))) {
      for (const part of chunk(clears.filter((r) => r.site === site).map((r) => r.sku), 200)) {
        for (const l of await restGet<{ sku: string; wix_product_id: string }[]>(`wix_links?site=eq.${site}&sku=${inList(part)}&select=sku,wix_product_id`)) links.set(`${site}:${l.sku}`, l.wix_product_id);
      }
    }
    const jobs: Job[] = clears.map((row) => ({ kind: "clear", row, wixId: links.get(`${row.site}:${row.sku}`) ?? null }));
    for (const [key, want] of wanted) {
      const have = seen.get(key);
      if (have?.confirmed && have.discount_type === want.type && Number(have.discount_value) === want.value) {
        // The same discount from another event: only whose it is changes.
        if (have.promotion_id !== want.promotion_id && !dryRun) await restWrite("PATCH", `stylish_event_discounts?site=eq.${want.site.key}&sku=eq.${encodeURIComponent(want.sku)}`, { promotion_id: want.promotion_id });
        continue;
      }
      jobs.push({ kind: "set", want });
    }

    const plan = {
      today, events: promos, wanted: wanted.size, on_stores: applied.length, to_set: jobs.filter((j) => j.kind === "set").length, to_clear: clears.length,
      skipped: skipped.slice(0, 100),
    };
    if (dryRun) {
      return json({
        dryRun: true, ...plan,
        lines: jobs.slice(0, 100).map((j) => j.kind === "set"
          ? { action: "set", site: j.want.site.key, sku: j.want.sku, type: j.want.type, value: j.want.value, store_price: j.want.storePrice, promotion_id: j.want.promotion_id }
          : { action: "clear", site: j.row.site, sku: j.row.sku }),
      });
    }
    if (!jobs.length) return json({ ...plan, nothing_to_do: true });

    const result = await runJobs(jobs);
    const report = { at: new Date().toISOString(), ...plan, ...result };
    await restWrite("POST", "app_settings?on_conflict=key", { key: "stylish_event_discounts_run", value: report, updated_at: report.at }, "resolution=merge-duplicates,return=minimal");
    await restWrite("POST", "audit_log", {
      action: "push", entity_type: "promotion", entity_id: "stylish", target: "wix",
      summary: `Stylish special events: ${result.set} discount${result.set === 1 ? "" : "s"} set, ${result.cleared} taken off${result.owed ? `, ${result.owed} left for the next run` : ""}${result.failed ? `, ${result.failed} failed` : ""}`,
      metadata: report,
    }).catch((err) => console.error("[stylish-event-discounts] activity log failed:", (err as Error).message));
    return json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[stylish-event-discounts] FAILED:", message);
    return json({ error: message }, 500);
  }
});
