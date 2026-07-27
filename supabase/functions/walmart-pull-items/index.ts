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
//   and the legacy /v3/ca stack rejects token auth. The one read that works
//   is the FEED DETAIL: the latest MP_INVENTORY feed enumerates every CA SKU
//   with its ingestion status → { sku, feedStatus } (presence/coverage only).
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

  const cid = Deno.env.get("WALMART_US_PROD_CLIENT_ID");
  const sec = Deno.env.get("WALMART_US_PROD_CLIENT_SECRET");
  if (!cid || !sec) return json({ error: "Walmart US secrets are not set" }, 500);

  let market = "us";
  try {
    const body = await req.json();
    if (body?.market === "ca") market = "ca";
  } catch {
    // empty body → default market
  }

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

      return json({ ok: true, market: "ca", total: items.length, feedDate: feed.feedDate ?? null, items });
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
