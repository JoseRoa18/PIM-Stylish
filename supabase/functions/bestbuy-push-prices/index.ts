// Stylish PIM → Best Buy Canada (Mirakl): push PIM MSRPs to live offers.
//
// FIRST WRITE PATH to Best Buy (2026-07-31, user-approved — the connection
// was strictly read-only before). Scope is deliberately narrow: it only
// UPDATES THE PRICE of offers that already exist, for explicitly listed
// SKUs, and only when the live price differs from the PIM MSRP. It never
// creates/deletes offers and never touches stock or state.
//
// Request body: { action, ...params } — caller must be an authenticated
// admin or editor (service_role bearer also accepted, for automation):
//   action "preview" -> { skus?: string[] }  -> { updates: [...] }
//       Re-reads the LIVE offers and returns what a push would send —
//       no write happens. Empty skus = preview every mismatch.
//   action "push"    -> { skus: string[] }   -> { importId, updates }
//       Sends the price updates via Mirakl OF24 (async import). SKUs are
//       re-validated against the live offers first; a SKU whose price
//       already matches is skipped, not resent.
//   action "status"  -> { importId }         -> { status, ... , errorReport? }
//       Tracks the async import until Mirakl finishes applying it.
//
// Required secrets: BESTBUY_API_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

const MIRAKL = "https://marketplace.bestbuy.ca/api";

type Offer = { sku: string; price: number | null; quantity: number; active: boolean };

async function fetchLiveOffers(apiKey: string): Promise<Offer[]> {
  const offers: Offer[] = [];
  let offset = 0;
  let total = 0;
  do {
    const res = await fetch(`${MIRAKL}/offers?max=100&offset=${offset}`, {
      headers: { Authorization: apiKey, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Best Buy API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    total = data.total_count ?? 0;
    for (const o of data.offers ?? []) {
      offers.push({
        sku: o.shop_sku,
        price: o.price ?? null,
        quantity: o.quantity ?? 0,
        active: Boolean(o.active),
      });
    }
    offset += 100;
    if (!data.offers?.length) break;
  } while (offers.length < total);
  return offers;
}

// Live offers × PIM MSRPs → the price updates a push would send.
function buildUpdates(
  offers: Offer[],
  msrpBySku: Map<string, number | null>,
  skus?: string[],
) {
  const wanted = skus?.length ? new Set(skus) : null;
  const updates: Array<{ sku: string; from: number; to: number }> = [];
  for (const o of offers) {
    if (wanted && !wanted.has(o.sku)) continue;
    const msrp = msrpBySku.get(o.sku);
    if (msrp == null || o.price == null) continue;
    if (Math.abs(o.price - msrp) <= 0.01) continue;
    updates.push({ sku: o.sku, from: o.price, to: msrp });
  }
  return updates;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const apiKey = Deno.env.get("BESTBUY_API_KEY");
    if (!apiKey) return json({ error: "BESTBUY_API_KEY secret is not set" }, 500);

    // --- Authorize: admin/editor session, or the service key (automation) ---
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Missing Authorization header." }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // The platform gateway has already VERIFIED the JWT signature (this
    // function is deployed with verify_jwt on), so trusting the decoded
    // role claim is safe. Accepts both the injected key and the project's
    // legacy service_role JWT (used by scripts/automation).
    let isService = token === SERVICE_ROLE;
    if (!isService) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        isService = payload?.role === "service_role";
      } catch {
        // not a JWT — fall through to session auth
      }
    }

    if (!isService) {
      const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
      if (callerErr || !caller) return json({ error: "Invalid or expired session." }, 401);

      const { data: profile, error: profileErr } = await admin
        .from("profiles")
        .select("role")
        .eq("id", caller.id)
        .maybeSingle();
      if (profileErr) throw new Error(`Profile lookup failed: ${profileErr.message}`);
      if (profile?.role !== "admin" && profile?.role !== "editor") {
        return json({ error: "Only admins and editors can push prices." }, 403);
      }
    }

    const body = await req.json().catch(() => ({}));
    const action = typeof body.action === "string" ? body.action : "";

    if (action === "status") {
      const importId = body.importId;
      if (!importId) return json({ error: "importId is required" }, 400);
      const res = await fetch(`${MIRAKL}/offers/imports/${encodeURIComponent(importId)}`, {
        headers: { Authorization: apiKey, Accept: "application/json" },
      });
      if (!res.ok) return json({ error: `Best Buy import status ${res.status}: ${await res.text()}` }, 502);
      const info = await res.json();

      let errorReport: string | null = null;
      if ((info.lines_in_error ?? 0) > 0 && info.has_error_report) {
        const rep = await fetch(
          `${MIRAKL}/offers/imports/${encodeURIComponent(importId)}/error_report`,
          { headers: { Authorization: apiKey } },
        );
        if (rep.ok) errorReport = (await rep.text()).slice(0, 10_000);
      }
      return json({
        ok: true,
        status: info.status ?? "UNKNOWN",
        linesRead: info.lines_read ?? 0,
        linesInSuccess: info.lines_in_success ?? 0,
        linesInError: info.lines_in_error ?? 0,
        errorReport,
      });
    }

    if (action !== "preview" && action !== "push") {
      return json({ error: `Unknown action "${action}"` }, 400);
    }

    const skus: string[] | undefined = Array.isArray(body.skus)
      ? body.skus.filter((s: unknown) => typeof s === "string")
      : undefined;
    if (action === "push" && !skus?.length) {
      return json({ error: "push requires an explicit, non-empty skus list" }, 400);
    }

    // PIM MSRPs (the source of truth) + the channel's live offers.
    const { data: prods, error: prodErr } = await admin
      .from("products")
      .select("sku, msrp_cad");
    if (prodErr) throw new Error(prodErr.message);
    const msrpBySku = new Map<string, number | null>(
      (prods ?? []).map((p: { sku: string; msrp_cad: number | null }) => [p.sku, p.msrp_cad]),
    );
    const offers = await fetchLiveOffers(apiKey);
    const updates = buildUpdates(offers, msrpBySku, skus);

    if (action === "preview") {
      return json({ ok: true, liveOffers: offers.length, updates });
    }

    // ---- push ----
    if (updates.length === 0) {
      return json({ ok: true, importId: null, updates, message: "Nothing to push — live prices already match." });
    }

    const res = await fetch(`${MIRAKL}/offers`, {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        offers: updates.map((u) => ({
          shop_sku: u.sku,
          update_delete: "update",
          price: u.to,
        })),
      }),
    });
    if (!res.ok) return json({ error: `Best Buy push ${res.status}: ${await res.text()}` }, 502);
    const data = await res.json();

    return json({ ok: true, importId: data.import_id ?? null, updates });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
