// Stylish PIM → Best Buy Canada (Mirakl): push product CONTENT via P41.
//
// This is the first WRITE path to Best Buy. Scope is deliberately narrow:
// product content only (title, descriptions, attributes, images). It cannot
// touch offers — and therefore cannot touch PRICES, which by standing rule
// are never pushed to Best Buy.
//
// Request body: { rows: Array<Record<string, string>> }  (max 50)
//   Each row is column-code → value, exactly as Mirakl's import expects:
//     BBYCat                     category CODE (e.g. "CAT_314937") — codes
//                                work; "…- Category Branch" path labels don't
//     shop_sku                   the seller SKU
//     _Title_BB_Category_Root_EN, _Short_Description_BB_Category_Root_EN,
//     _Brand_Name_Category_Root_EN, _Primary_UPC_Category_Root_EN, …
//   Category-specific required attributes (e.g. _ProductCondition_…) must be
//   included — the transformation rejects the line otherwise, and the error
//   text comes back in this function's response.
//
// Response: { ok, import_id, status, lines_read, lines_ok, lines_error,
//             transformation_errors? }
// `status` is usually "SENT": transformation passed and the file is queued on
// Best Buy's side (their QC applies it later — content is NOT live yet).
//
// Caller must be an authenticated admin or editor. Pushes are always manual:
// this function acts only when invoked; nothing schedules it.
//
// Required secrets: BESTBUY_API_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { excludedSet } from "../_shared/exclusions.ts";
import { submitContentImport } from "../_shared/bestbuyContentImport.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_ROWS = 50;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("BESTBUY_API_KEY");
    if (!apiKey) return json({ error: "BESTBUY_API_KEY secret is not set" }, 500);

    // --- Authenticate + authorize (same gate as generate-keywords) ----------
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Missing Authorization header." }, 401);
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) return json({ error: "Invalid or expired session." }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: profile } = await admin
      .from("profiles").select("role").eq("id", caller.id).maybeSingle();
    if (!["admin", "editor"].includes(profile?.role ?? "")) {
      return json({ error: "Only admins and editors can push content to Best Buy." }, 403);
    }

    // --- Validate the rows ---------------------------------------------------
    const body = await req.json().catch(() => ({}));
    let rows: Record<string, string>[] = Array.isArray(body.rows) ? body.rows : [];
    // Marketplace exclusion (rule 2026-09-22): products switched off for Best Buy are left out.
    const rowSku = (r: Record<string, string>) => String(r.shop_sku ?? r.sku ?? r.SKU ?? r["Seller SKU"] ?? r.seller_sku ?? "");
    const excludedBb = await excludedSet(admin, rows.map(rowSku).filter(Boolean), "bestbuy");
    const excluded = [...excludedBb].sort();
    if (excludedBb.size) rows = rows.filter((r) => !excludedBb.has(rowSku(r)));
    if (!rows.length) return json({ error: "rows is required." }, 400);
    if (rows.length > MAX_ROWS) return json({ error: `Max ${MAX_ROWS} rows per call.` }, 400);
    for (const r of rows) {
      if (!r.shop_sku) return json({ error: "Every row needs shop_sku." }, 400);
      if (!r.BBYCat) return json({ error: `Row ${r.shop_sku}: BBYCat (category code) is required.` }, 400);
      // The offers API is the price channel; keep this one content-only.
      const banned = Object.keys(r).filter((k) => /price|quantity/i.test(k));
      if (banned.length) return json({ error: `Row ${r.shop_sku}: ${banned.join(", ")} not allowed — prices are never pushed.` }, 400);
    }

    // --- Submit the P41 import and wait for its transformation ------------------
    const sent = await submitContentImport(apiKey, rows);
    return json({ ok: sent.lines_error === 0, ...sent });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[bestbuy-push-content] FAILED:", message);
    return json({ error: message }, 500);
  }
});
