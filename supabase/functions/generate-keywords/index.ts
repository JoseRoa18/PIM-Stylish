// Generate search keywords (EN + FR) for products, on demand from the PIM UI.
//
// Request body: { skus: string[], force?: boolean }
//   → { results: [{ sku, status: "generated" | "skipped" | "error",
//                   keywords_en?, keywords_fr?, error? }] }
//
// The caller must be an authenticated admin or editor. Products that already
// have keywords are skipped unless force — so the bulk action is safe to run
// over any selection, and single-product regeneration passes force after the
// UI has asked for confirmation.
//
// Why an Edge Function: the Gemini API key must never reach the browser, and
// writes go through the service role so the merge into `attributes` can't be
// blocked by RLS. Prompt + schema live in _shared/keywords.js, shared verbatim
// with scripts/generate-keywords.mjs (the backfill script).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { generateKeywordsForProduct } from "../_shared/keywords.js";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Per-invocation cap: keeps one call well inside the function's time budget.
// The client chunks larger selections.
const MAX_SKUS = 20;
const CONCURRENCY = 3;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  // One retry on transient Gemini errors (429/5xx) — the backfill run showed
  // the occasional 503 that succeeds moments later.
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Gemini (429|5\d\d)/.test(msg)) throw err;
    await new Promise((r) => setTimeout(r, 1500));
    return await fn();
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_KEY) return json({ error: "GEMINI_API_KEY is not configured." }, 500);

    // --- Authenticate the caller from their bearer token ---------------------
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Missing Authorization header." }, 401);

    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) return json({ error: "Invalid or expired session." }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // --- Authorize: content is written by admins and editors -----------------
    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("role")
      .eq("id", caller.id)
      .maybeSingle();
    if (profileErr) throw new Error(`Profile lookup failed: ${profileErr.message}`);
    if (!["admin", "editor"].includes(profile?.role ?? "")) {
      return json({ error: "Only admins and editors can generate keywords." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const skus: string[] = Array.isArray(body.skus)
      ? body.skus.filter((s: unknown) => typeof s === "string" && s.trim()).slice(0, MAX_SKUS)
      : [];
    const force = body.force === true;
    if (!skus.length) return json({ error: "skus is required (max 20 per call)." }, 400);

    const { data: products, error: prodErr } = await admin
      .from("products")
      .select("sku, category, product_type, material, finish, description, attributes")
      .in("sku", skus);
    if (prodErr) throw new Error(`Products fetch failed: ${prodErr.message}`);

    const bySku = new Map((products ?? []).map((p) => [p.sku, p]));
    const results: Record<string, unknown>[] = [];

    const queue = [...skus];
    async function worker() {
      while (queue.length) {
        const sku = queue.shift()!;
        const p = bySku.get(sku);
        if (!p) {
          results.push({ sku, status: "error", error: "Not found." });
          continue;
        }
        if (!force && p.attributes?.keywords_en?.length) {
          results.push({ sku, status: "skipped" });
          continue;
        }
        try {
          const { keywords_en, keywords_fr } = await withRetry(() =>
            generateKeywordsForProduct(fetch, GEMINI_KEY!, p)
          );
          const next = { ...(p.attributes ?? {}), keywords_en, keywords_fr };
          const { error: upErr } = await admin
            .from("products")
            .update({ attributes: next })
            .eq("sku", sku);
          if (upErr) throw new Error(`Write failed: ${upErr.message}`);
          results.push({ sku, status: "generated", keywords_en, keywords_fr });
        } catch (err) {
          results.push({
            sku,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, skus.length) }, worker));

    // Return in request order — the client reports counts and per-SKU failures.
    const order = new Map(skus.map((s, i) => [s, i]));
    results.sort((a, b) => (order.get(a.sku as string) ?? 0) - (order.get(b.sku as string) ?? 0));
    return json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate-keywords] FAILED:", message);
    return json({ error: message }, 500);
  }
});
