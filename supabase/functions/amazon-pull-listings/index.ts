// Stylish PIM ← Amazon (Selling Partner API): READ-ONLY catalog pull.
//
// Amazon has no "give me my catalog" query — the reliable full-catalog read is
// the Reports API flat file GET_MERCHANT_LISTINGS_ALL_DATA, which lists every
// listing with seller-sku, ASIN, price, quantity and status. Reports are
// asynchronous and can take minutes, so this function is split into steps the
// client polls:
//
//   { mode: "ping" }                → access token + marketplace participations
//   sandbox: true on any mode        → static sandbox host (example data only)
//   { mode: "report" }              → creates the report, returns reportId
//   { mode: "fetch", reportId }     → polls; when DONE parses the rows and
//                                     (with apply) caches them in amazon_links
//   { mode: "prices", skus: [...] } → Product Pricing API for those seller SKUs
//
// Nothing here writes to Amazon. The PIM stays the source of truth; the
// amazon_links table only CACHES what Amazon reports.
//
// Secrets: AMZ_LWA_CLIENT_ID, AMZ_LWA_CLIENT_SECRET, AMZ_REFRESH_TOKEN.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Amazon.com first; Amazon.ca is the same endpoint and one authorization away.
const MARKETPLACES: Record<string, { id: string; host: string; currency: string }> = {
  us: { id: "ATVPDKIKX0DER", host: "sellingpartnerapi-na.amazon.com", currency: "USD" },
  ca: { id: "A2EUQ1WTGCTBG2", host: "sellingpartnerapi-na.amazon.com", currency: "CAD" },
};
const REPORT_TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";

// LWA access tokens live an hour; cache one for the life of the warm instance.
let tokenCache: { token: string; expiresAt: number } | null = null;
async function getToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(
      `Amazon auth failed: ${data.error ?? res.status} ${data.error_description ?? JSON.stringify(data).slice(0, 200)}`,
    );
  }
  tokenCache = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000 };
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // --- caller must be signed in (reads are safe for any role) ------------
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return json({ error: "Missing Authorization header." }, 401);
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) return json({ error: "Invalid or expired session." }, 401);
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const body = await req.json().catch(() => ({}));
    const mode = String(body.mode ?? "ping");
    const marketKey = String(body.marketplace ?? "us");
    const market = MARKETPLACES[marketKey];
    if (!market) return json({ error: `unknown marketplace "${marketKey}" (use us or ca)` }, 400);

    const CLIENT_ID = Deno.env.get("AMZ_LWA_CLIENT_ID");
    const CLIENT_SECRET = Deno.env.get("AMZ_LWA_CLIENT_SECRET");
    const REFRESH_TOKEN = Deno.env.get("AMZ_REFRESH_TOKEN");
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return json({ error: "Missing AMZ_LWA_CLIENT_ID / AMZ_LWA_CLIENT_SECRET secrets." }, 500);
    }
    if (!REFRESH_TOKEN) {
      return json({
        error:
          "Missing AMZ_REFRESH_TOKEN. In Seller Central: Apps & Services → Develop Apps → your app → Authorize → Generate refresh token.",
      }, 500);
    }

    // Sandbox apps (created before identity verification) only work against
    // Amazon's static sandbox, which answers with fixed example data — useful
    // to prove auth + plumbing, useless for real listings.
    const sandbox = body.sandbox === true;
    const host = sandbox ? `sandbox.${market.host}` : market.host;
    const token = await getToken(CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN);
    const call = async (path: string, init: RequestInit = {}) => {
      const r = await fetch(`https://${host}${path}`, {
        ...init,
        headers: { "x-amz-access-token": token, "Content-Type": "application/json", ...(init.headers ?? {}) },
      });
      const text = await r.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text.slice(0, 400) };
      }
      return { status: r.status, body: parsed };
    };
    const firstError = (b: Record<string, unknown> | null) => {
      const errs = (b?.errors ?? []) as { code?: string; message?: string; details?: string }[];
      return errs.length ? `${errs[0].code ?? ""} ${errs[0].message ?? ""} ${errs[0].details ?? ""}`.trim() : null;
    };

    // ---- ping: does this authorization actually see the Stylish account? ----
    if (mode === "ping") {
      const r = await call("/sellers/v1/marketplaceParticipations");
      const err = firstError(r.body);
      if (err) return json({ ok: false, step: "marketplaceParticipations", status: r.status, error: err }, 502);
      const list = (r.body?.payload ?? []) as {
        marketplace: { id: string; name: string; countryCode: string; defaultCurrencyCode: string };
        participation: { isParticipating: boolean; hasSuspendedListings: boolean };
      }[];
      return json({
        ok: true,
        tokenOk: true,
        env: sandbox ? "sandbox" : "production",
        marketplaces: list.map((m) => ({
          id: m.marketplace.id,
          name: m.marketplace.name,
          country: m.marketplace.countryCode,
          currency: m.marketplace.defaultCurrencyCode,
          participating: m.participation?.isParticipating,
          suspendedListings: m.participation?.hasSuspendedListings,
        })),
      });
    }

    // ---- report: ask Amazon for the full listings flat file -----------------
    if (mode === "report") {
      const r = await call("/reports/2021-06-30/reports", {
        method: "POST",
        body: JSON.stringify({ reportType: REPORT_TYPE, marketplaceIds: [market.id] }),
      });
      const err = firstError(r.body);
      if (err) return json({ ok: false, step: "createReport", status: r.status, error: err }, 502);
      return json({ ok: true, marketplace: marketKey, reportId: r.body?.reportId, reportType: REPORT_TYPE });
    }

    // ---- fetch: poll the report, parse the flat file, cache the links -------
    if (mode === "fetch") {
      const reportId = String(body.reportId ?? "");
      if (!reportId) return json({ error: "reportId is required for mode fetch" }, 400);
      const rep = await call(`/reports/2021-06-30/reports/${reportId}`);
      const repErr = firstError(rep.body);
      if (repErr) return json({ ok: false, step: "getReport", status: rep.status, error: repErr }, 502);
      const processingStatus = String(rep.body?.processingStatus ?? "");
      const documentId = rep.body?.reportDocumentId as string | undefined;
      if (processingStatus !== "DONE" || !documentId) {
        return json({ ok: true, pending: true, reportId, processingStatus });
      }

      const doc = await call(`/reports/2021-06-30/documents/${documentId}`);
      const docErr = firstError(doc.body);
      if (docErr) return json({ ok: false, step: "getReportDocument", status: doc.status, error: docErr }, 502);
      const url = String(doc.body?.url ?? "");
      const compression = String(doc.body?.compressionAlgorithm ?? "");
      const res = await fetch(url);
      const text = compression === "GZIP"
        ? await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).text()
        : await res.text();

      // The flat file is tab separated with a header row of snake-case labels.
      const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
      if (!lines.length) return json({ ok: true, reportId, rows: 0, note: "report is empty" });
      const header = lines[0].split("\t").map((h) => h.trim().toLowerCase());
      const col = (...names: string[]) => {
        for (const n of names) {
          const i = header.indexOf(n);
          if (i >= 0) return i;
        }
        return -1;
      };
      const iSku = col("seller-sku", "sku");
      const iAsin = col("asin1", "asin", "product-id");
      const iPrice = col("price");
      const iQty = col("quantity");
      const iStatus = col("status");
      const iFulfil = col("fulfillment-channel", "fulfilment-channel");
      const rows = lines.slice(1).map((l) => {
        const c = l.split("\t");
        const raw = (i: number) => (i >= 0 ? (c[i] ?? "").trim() : "");
        const price = Number(raw(iPrice).replace(/[^0-9.\-]/g, ""));
        const qty = parseInt(raw(iQty), 10);
        return {
          seller_sku: raw(iSku),
          asin: raw(iAsin) || null,
          price: raw(iPrice) !== "" && Number.isFinite(price) ? price : null,
          quantity: Number.isFinite(qty) ? qty : null,
          status: raw(iStatus) || null,
          fulfillment: raw(iFulfil) || null,
        };
      }).filter((r) => r.seller_sku);

      // Match Amazon's seller SKUs to PIM SKUs. Amazon SKUs often carry a
      // suffix or different case, so fall back to a normalized key — the DASH
      // is kept, because dashed and undashed SKUs are DIFFERENT brands here.
      const { data: products } = await supabase.from("products").select("sku");
      const bySku = new Map<string, string>();
      const byLoose = new Map<string, string>();
      for (const p of products ?? []) {
        const sku = String(p.sku);
        bySku.set(sku.toUpperCase(), sku);
        const loose = sku.toUpperCase().replace(/[^A-Z0-9-]/g, "");
        if (!byLoose.has(loose)) byLoose.set(loose, sku);
      }
      const matched: Record<string, unknown>[] = [];
      const unmatched: string[] = [];
      for (const r of rows) {
        const up = r.seller_sku.toUpperCase();
        const sku = bySku.get(up) ?? byLoose.get(up.replace(/[^A-Z0-9-]/g, "")) ?? null;
        if (!sku) {
          unmatched.push(r.seller_sku);
          continue;
        }
        matched.push({
          marketplace: marketKey,
          sku,
          seller_sku: r.seller_sku,
          asin: r.asin,
          status: r.status,
          fulfillment: r.fulfillment,
          price: r.price,
          currency: market.currency,
          quantity: r.quantity,
          synced_at: new Date().toISOString(),
        });
      }

      let applied = 0;
      if (body.apply === true && matched.length) {
        // One row per (marketplace, sku): keep the first listing seen.
        const seen = new Set<string>();
        const unique = matched.filter((m) => {
          const k = `${m.marketplace}|${m.sku}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        const { error } = await supabase.from("amazon_links").upsert(unique, { onConflict: "marketplace,sku" });
        if (error) return json({ ok: false, step: "upsert", error: error.message, matched: matched.length }, 500);
        applied = unique.length;
      }

      return json({
        ok: true,
        marketplace: marketKey,
        reportId,
        rows: rows.length,
        matched: matched.length,
        applied,
        unmatchedCount: unmatched.length,
        unmatched: unmatched.slice(0, 40),
        sample: matched.slice(0, 10),
      });
    }

    // ---- prices: your price / Buy Box for specific seller SKUs -------------
    if (mode === "prices") {
      const skus: string[] = Array.isArray(body.skus) ? body.skus.map(String) : [];
      if (!skus.length) return json({ error: "skus[] is required for mode prices" }, 400);
      if (skus.length > 20) return json({ error: "max 20 SKUs per call (Amazon's own limit)" }, 400);
      const qs = new URLSearchParams({ MarketplaceId: market.id, ItemType: "Sku" });
      for (const s of skus) qs.append("Skus", s);
      const r = await call(`/products/pricing/v0/price?${qs.toString()}`);
      const err = firstError(r.body);
      if (err) return json({ ok: false, step: "getPricing", status: r.status, error: err }, 502);
      return json({
        ok: true,
        marketplace: marketKey,
        prices: (r.body?.payload ?? []) as Record<string, unknown>[],
      });
    }

    return json({ error: `unknown mode "${mode}" (use ping, report, fetch or prices)` }, 400);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
