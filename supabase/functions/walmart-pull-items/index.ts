// Stylish PIM ← Walmart US Marketplace: pull the seller's items.
//
// STRICTLY READ-ONLY: token (client credentials) + GET /v3/items only —
// nothing is ever created, updated or deleted at Walmart. Exists so the
// browser never sees the credentials (Supabase secrets) and to avoid CORS.
//
// Request body: {} (none needed)
// Response: { ok, total, items: [{ sku, price, published, lifecycle }] }
//
// Required secrets: WALMART_US_PROD_CLIENT_ID, WALMART_US_PROD_CLIENT_SECRET

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
