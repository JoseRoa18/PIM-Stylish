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
  try {
    const body = await req.json();
    if (body?.market === "ca") market = "ca";
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
      // for every SKU — with a promotion it carries the REGULAR price
      // (comparisonPrice) and the promo (currentPrice + window); without one
      // it only says NOT_FOUND, so the regular price stays unknown then.
      const etDay = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Toronto" }) : null);
      const enriched: Array<Record<string, unknown>> = items.map((it) => ({ ...it, price: null, discount_price: null, discount_start: null, discount_end: null, promo_id: null, promo_checked: false }));
      const startedAt = Date.now();
      let cursor = 0;
      async function worker() {
        while (cursor < enriched.length && Date.now() - startedAt < 60_000) {
          const row = enriched[cursor++];
          try {
            const res = await fetch(`${BASE}/v3/promo/sku/${encodeURIComponent(String(row.sku))}`, { headers: caHeaders });
            if (!res.ok) continue;
            const d = await res.json();
            row.promo_checked = true;
            if (d?.status !== "OK") continue;
            const pr = d.payload?.pricingList?.pricing?.[0];
            if (!pr) continue;
            const current = pr.currentPrice?.value?.amount ?? null;
            const comparison = pr.comparisonPrice?.value?.amount ?? null;
            if (pr.currentPriceType === "REDUCED") {
              row.price = comparison;
              row.discount_price = current;
            } else {
              row.price = current;
            }
            row.discount_start = etDay(pr.effectiveDate);
            row.discount_end = etDay(pr.expirationDate);
            row.promo_id = pr.promoId ?? null;
          } catch { /* keep the row without price */ }
        }
      }
      await Promise.all(Array.from({ length: 6 }, worker));
      const checked = enriched.filter((r) => r.promo_checked).length;
      const promos = enriched.filter((r) => r.discount_price != null).length;
      return json({ ok: true, market: "ca", total: enriched.length, feedDate: feed.feedDate ?? null, items: enriched, promos_checked: checked, promos_active: promos, partial: checked < enriched.length });
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
