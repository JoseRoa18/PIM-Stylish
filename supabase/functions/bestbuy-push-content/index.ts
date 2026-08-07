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

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BASE = "https://marketplace.bestbuy.ca/api";
const MAX_ROWS = 50;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// CSV in the shape the transformation accepts: ;-separated, all fields quoted.
function toCsv(rows: Record<string, string>[]): string {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.map(q).join(";")];
  for (const r of rows) lines.push(cols.map((c) => q(r[c] ?? "")).join(";"));
  return lines.join("\n") + "\n";
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
    const rows: Record<string, string>[] = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return json({ error: "rows is required." }, 400);
    if (rows.length > MAX_ROWS) return json({ error: `Max ${MAX_ROWS} rows per call.` }, 400);
    for (const r of rows) {
      if (!r.shop_sku) return json({ error: "Every row needs shop_sku." }, 400);
      if (!r.BBYCat) return json({ error: `Row ${r.shop_sku}: BBYCat (category code) is required.` }, 400);
      // The offers API is the price channel; keep this one content-only.
      const banned = Object.keys(r).filter((k) => /price|quantity/i.test(k));
      if (banned.length) return json({ error: `Row ${r.shop_sku}: ${banned.join(", ")} not allowed — prices are never pushed.` }, 400);
    }

    // --- Submit the P41 import ----------------------------------------------
    const csv = toCsv(rows);
    const form = new FormData();
    form.append("file", new Blob([csv], { type: "text/csv" }), "stylish-pim-content-push.csv");

    const submit = await fetch(`${BASE}/products/imports`, {
      method: "POST",
      headers: { Authorization: apiKey },
      body: form,
    });
    if (!submit.ok) {
      return json({ error: `Mirakl rejected the import: ${submit.status} ${(await submit.text()).slice(0, 300)}` }, 502);
    }
    const { import_id } = await submit.json();

    // --- Poll until the TRANSFORMATION settles (Best Buy's QC stays async) --
    let status: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const res = await fetch(`${BASE}/products/imports/${import_id}`, {
        headers: { Authorization: apiKey, Accept: "application/json" },
      });
      status = await res.json();
      const s = String(status.import_status ?? "");
      const transformed = (status.transform_lines_read as number ?? 0) > 0 || s === "FAILED";
      if (transformed || ["COMPLETE", "FAILED", "CANCELLED"].includes(s)) break;
    }

    const linesError = (status.transform_lines_in_error as number) ?? 0;
    let transformationErrors: string | undefined;
    if (linesError > 0) {
      const rep = await fetch(`${BASE}/products/imports/${import_id}/transformation_error_report`, {
        headers: { Authorization: apiKey },
      });
      if (rep.ok) transformationErrors = (await rep.text()).slice(0, 4000);
    }

    return json({
      ok: linesError === 0,
      import_id,
      status: status.import_status ?? "SENT",
      lines_read: status.transform_lines_read ?? rows.length,
      lines_ok: status.transform_lines_in_success ?? 0,
      lines_error: linesError,
      transformation_errors: transformationErrors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[bestbuy-push-content] FAILED:", message);
    return json({ error: message }, 500);
  }
});
