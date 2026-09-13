// Stylish PIM ← Walmart Marketplace: pull the seller's items.
//
// STRICTLY READ-ONLY: token (client credentials) + GETs only — nothing is
// ever created, updated or deleted at Walmart. Exists so the browser never
// sees the credentials (Supabase secrets) and to avoid CORS.
//
// Request body: { market?: 'us' | 'ca' } (default 'us')
// - us: GET /v3/items → { sku, price, published, lifecycle }
// - ca: Walmart's modern item-query API does NOT serve the CA catalog (every
//   items/inventory read 404s even for SKUs the daily inventory feeds update),
//   and the legacy /v3/ca stack rejects token auth. Presence comes from the
//   FEED DETAIL of the latest MP_INVENTORY feed → { sku, feedStatus }; prices
//   from GET /v3/promo/sku/{sku} per SKU (regular + promo while a promotion
//   exists) → price, discount_price, discount_start/end, promo_id.
//
// Required secrets: WALMART_US_PROD_CLIENT_ID, WALMART_US_PROD_CLIENT_SECRET
// (the credential pair is multi-market; CA is selected via WM_MARKET).

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const BASE = "https://marketplace.walmartapis.com";

function wmHeaders(extra: Record<string, string>) {
  return {
    "WM_SVC.NAME": "Walmart Marketplace",
    "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
    "Accept": "application/json",
    ...extra,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let market = "us";
  let bodyLimit = NaN;
  try {
    const body = await req.json();
    if (body?.market === "ca") market = "ca";
    bodyLimit = Number(body?.promoLimit);
  } catch {
    // empty body → default market
  }
  // Canada has its own credential pair since 2026-09-13 (falls back to the
  // multi-market US pair when it is not set).
  const cid = (market === "ca" && Deno.env.get("WALMART_CA_CLIENT_ID")) || Deno.env.get("WALMART_US_PROD_CLIENT_ID");
  const sec = (market === "ca" && Deno.env.get("WALMART_CA_CLIENT_SECRET")) || Deno.env.get("WALMART_US_PROD_CLIENT_SECRET");
  if (!cid || !sec) return json({ error: "Walmart secrets are not set" }, 500);

  try {
    const tokenRes = await fetch(`${BASE}/v3/token`, {
      method: "POST",
      headers: wmHeaders({
        Authorization: `Basic ${btoa(`${cid}:${sec}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      }),
      body: "grant_type=client_credentials",
    });
    if (!tokenRes.ok) {
      return json({ error: `Walmart token ${tokenRes.status}: ${await tokenRes.text()}` }, 502);
    }
    const { access_token } = await tokenRes.json();

    if (market === "ca") {
      const caHeaders = wmHeaders({ "WM_SEC.ACCESS_TOKEN": access_token, "WM_MARKET": "ca" });
      const feedsRes = await fetch(`${BASE}/v3/feeds?limit=10`, { headers: caHeaders });
      if (!feedsRes.ok) {
        return json({ error: `Walmart CA feeds ${feedsRes.status}: ${await feedsRes.text()}` }, 502);
      }
      const feedsData = await feedsRes.json();
      const feed = (feedsData.results?.feed ?? []).find(
        (f: { feedType?: string }) => f.feedType === "MP_INVENTORY",
      );
      if (!feed) return json({ error: "No MP_INVENTORY feed found for Walmart CA" }, 404);

      const items: Array<{ sku: string; feedStatus: string }> = [];
      let offset = 0;
      let received = 0;
      do {
        const res = await fetch(
          `${BASE}/v3/feeds/${encodeURIComponent(feed.feedId)}?includeDetails=true&limit=50&offset=${offset}`,
          { headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": access_token, "WM_MARKET": "ca" }) },
        );
        if (!res.ok) {
          return json({ error: `Walmart CA feed detail ${res.status}: ${await res.text()}` }, 502);
        }
        const data = await res.json();
        received = data.itemsReceived ?? 0;
        const page = data.itemDetails?.itemIngestionStatus ?? [];
        for (const it of page) {
          items.push({ sku: String(it.sku ?? ""), feedStatus: String(it.ingestionStatus ?? "") });
        }
        offset += 50;
        if (!page.length) break;
      } while (items.length < received);

      // Prices: Walmart CA serves no item read, but the promo endpoint answers
      // per SKU — with a promotion it carries the REGULAR price
      // (comparisonPrice) and the promo (currentPrice + window); without one
      // it only says NOT_FOUND, so the regular price stays unknown then.
      // Walmart rate-limits this read hard from the edge runtime (429s past
      // ~1 call/s), so each pull checks a BUDGET of SKUs in priority order
      // (members of current/upcoming promotions first, then the least
      // recently checked) and carries the rest forward from the previous
      // snapshot. Two cron runs a day keep promo members fresh daily.
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
      const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const restHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
      const restGet = async (path: string) => {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: restHeaders });
        return r.ok ? await r.json() : [];
      };
      // Walmart lists 89 of our products under an alias ("S-300XG-1"); the
      // snapshot is keyed by the PIM SKU so every screen matches, and the
      // Walmart SKU rides along for the writes.
      const aliasRows = await restGet("product_aliases?marketplace=eq.Walmart%20CA&select=alias,sku&limit=2000");
      const pimByAlias = new Map<string, string>((aliasRows as { alias: string; sku: string }[]).map((r) => [r.alias, r.sku]));
      for (const it of items as Array<{ sku: string; walmart_sku?: string }>) {
        it.walmart_sku = it.sku;
        const pimSku = pimByAlias.get(it.sku);
        if (pimSku) it.sku = pimSku;
      }
      const prevSnap = await restGet("channel_health?channel=eq.walmart_ca&select=results&order=run_at.desc&limit=1");
      const prevBySku = new Map<string, Record<string, unknown>>(
        ((prevSnap?.[0]?.results ?? []) as Record<string, unknown>[]).map((r) => [String(r.sku), r]),
      );
      const monthStart = new Date().toISOString().slice(0, 7) + "-01";
      const promos = await restGet(`promotions?select=promotion_prices(sku,promo_price_cad)&status=in.(draft,active)&period=gte.${monthStart}`);
      const members = new Set<string>();
      for (const pr of promos as { promotion_prices: { sku: string; promo_price_cad: number | null }[] }[]) {
        for (const row of pr.promotion_prices ?? []) if (row.promo_price_cad != null) members.add(row.sku);
      }

      const etDay = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Toronto" }) : null);
      const enriched: Array<Record<string, unknown>> = items.map((it) => {
        const prev = prevBySku.get(it.sku) ?? {};
        return {
          ...it,
          price: prev.price ?? null, discount_price: prev.discount_price ?? null,
          discount_start: prev.discount_start ?? null, discount_end: prev.discount_end ?? null,
          promo_id: prev.promo_id ?? null, promo_checked_at: prev.promo_checked_at ?? null,
        };
      });
      const promoLimit = Number.isFinite(bodyLimit) ? Math.max(0, bodyLimit) : 40;
      const twelveHoursAgo = new Date(Date.now() - 12 * 3600_000).toISOString();
      const order = [...enriched].sort((a, b) => {
        const am = members.has(String(a.sku)) ? 0 : 1;
        const bm = members.has(String(b.sku)) ? 0 : 1;
        if (am !== bm) return am - bm;
        return String(a.promo_checked_at ?? "").localeCompare(String(b.promo_checked_at ?? ""));
      }).filter((r) => !(members.has(String(r.sku)) && String(r.promo_checked_at ?? "") > twelveHoursAgo) || !members.has(String(r.sku)));
      const queue = order.slice(0, promoLimit);

      const startedAt = Date.now();
      const failures: Record<string, number> = {};
      let checkedNow = 0;
      for (const row of queue) {
        if (Date.now() - startedAt > 55_000) break;
        try {
          let res: Response | null = null;
          for (let attempt = 0; attempt < 4; attempt++) {
            res = await fetch(`${BASE}/v3/promo/sku/${encodeURIComponent(String(row.walmart_sku ?? row.sku))}`, { headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": access_token, "WM_MARKET": "ca" }) });
            if (res.status !== 429 && res.status < 500) break;
            const retryAfter = Number(res.headers.get("retry-after"));
            await res.text();
            await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * (attempt + 1)));
          }
          if (!res || !res.ok) { const k = String(res?.status ?? "net"); failures[k] = (failures[k] ?? 0) + 1; continue; }
          const d = await res.json();
          row.promo_checked_at = new Date().toISOString();
          checkedNow += 1;
          if (d?.status !== "OK") { row.price = null; row.discount_price = null; row.discount_start = null; row.discount_end = null; row.promo_id = null; continue; }
          const pr = d.payload?.pricingList?.pricing?.[0];
          if (!pr) continue;
          const current = pr.currentPrice?.value?.amount ?? null;
          const comparison = pr.comparisonPrice?.value?.amount ?? null;
          if (pr.currentPriceType === "REDUCED") { row.price = comparison; row.discount_price = current; }
          else { row.price = current; row.discount_price = null; }
          row.discount_start = etDay(pr.effectiveDate);
          row.discount_end = etDay(pr.expirationDate);
          row.promo_id = pr.promoId ?? null;
        } catch { /* keep the carried values */ }
        // Gentle pace: Walmart's limit sits near one read per second here.
        await new Promise((r) => setTimeout(r, 700));
      }
      const checked = enriched.filter((r) => r.promo_checked_at).length;
      const promosActive = enriched.filter((r) => r.discount_price != null).length;
      return json({ ok: true, market: "ca", total: enriched.length, feedDate: feed.feedDate ?? null, items: enriched, promos_checked: checked, promos_checked_now: checkedNow, promo_members: members.size, promos_active: promosActive, partial: checked < enriched.length, failures, ms: Date.now() - startedAt });
    }

    const items: Array<{
      sku: string; price: number | null; published: string; lifecycle: string;
    }> = [];
    let offset = 0;
    let total = 0;
    do {
      const res = await fetch(`${BASE}/v3/items?limit=200&offset=${offset}`, {
        headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": access_token }),
      });
      if (!res.ok) {
        return json({ error: `Walmart items ${res.status}: ${await res.text()}` }, 502);
      }
      const data = await res.json();
      total = data.totalItems ?? 0;
      const page = data.ItemResponse ?? [];
      for (const it of page) {
        items.push({
          sku: String(it.sku ?? ""),
          price: it.price?.amount ?? null,
          published: String(it.publishedStatus ?? ""),
          lifecycle: String(it.lifecycleStatus ?? ""),
        });
      }
      offset += 200;
      if (!page.length) break;
    } while (items.length < total);

    return json({ ok: true, total, items });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
