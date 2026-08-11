// Push a product's PIM images to its linked Wix product. Wix ingests media
// BY URL (it downloads into its own Media Manager), and every PIM image is a
// public Storage URL — so "editing images from the PIM" is: send the URLs,
// in PIM order, primary first.
//
// Actions:
//   { sku, action: "add" }     → add the PIM's images to whatever Wix has
//   { sku, action: "replace" } → remove Wix's current media first, then add
//   { sku, action: "clear" }   → remove Wix's current media only
//
// Caller must be an authenticated admin or editor.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WIX_BASE = "https://www.wixapis.com";
const CHUNK = 10; // media items per add call
// Empirical hard cap: Wix ingests at most 16 media items per product — three
// independent runs against a 28-image product all converged on exactly 16
// (the excess is dropped silently, the add call still returns 200). Send
// only what fits, primary first, and report what was left out.
const WIX_MEDIA_CAP = 16;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const WIX_API_KEY = Deno.env.get("WIX_API_KEY")!;
    const WIX_SITE_ID = Deno.env.get("WIX_SITE_ID")!;
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // --- caller must be an authenticated admin or editor --------------------
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Missing Authorization header." }, 401);
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) return json({ error: "Invalid or expired session." }, 401);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: profile } = await admin.from("profiles").select("role").eq("id", caller.id).maybeSingle();
    if (!["admin", "editor"].includes(profile?.role ?? "")) {
      return json({ error: "Only admins and editors can push media." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const sku = typeof body.sku === "string" ? body.sku.trim() : "";
    const action = ["add", "replace", "clear"].includes(body.action) ? body.action : "add";
    if (!sku) return json({ error: "sku is required." }, 400);

    const { data: pim, error: pimErr } = await admin
      .from("products")
      .select("sku, wix_product_id")
      .eq("sku", sku)
      .maybeSingle();
    if (pimErr) throw new Error(`PIM read failed: ${pimErr.message}`);
    if (!pim?.wix_product_id) {
      return json({ error: `${sku} is not linked to Wix — create it first.` }, 409);
    }
    const id = pim.wix_product_id;

    const wix = (path: string, init: RequestInit = {}) =>
      fetch(`${WIX_BASE}${path}`, {
        ...init,
        headers: {
          "Authorization": WIX_API_KEY,
          "wix-site-id": WIX_SITE_ID,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });

    const report: Record<string, unknown> = { sku, action, wix_product_id: id };

    // --- clear / replace: drop what Wix currently has -----------------------
    if (action === "replace" || action === "clear") {
      const cur = await wix(`/stores/v1/products/${id}`);
      const curBody = await cur.json();
      if (!cur.ok) throw new Error(`Wix read ${cur.status}: ${JSON.stringify(curBody).slice(0, 200)}`);
      const ids = (curBody.product?.media?.items ?? [])
        .map((m: { id?: string; image?: { id?: string } }) => m.id ?? m.image?.id)
        .filter(Boolean);
      report.existing_media = ids.length;
      if (ids.length) {
        // v1 removal: POST /products/{id}/media/delete with mediaIds.
        const del = await wix(`/stores/v1/products/${id}/media/delete`, {
          method: "POST",
          body: JSON.stringify({ mediaIds: ids }),
        });
        if (!del.ok) {
          const delBody = await del.text();
          throw new Error(`Wix media delete ${del.status}: ${delBody.slice(0, 200)}`);
        }
        report.removed = ids.length;
      }
    }

    // --- add the PIM's images, primary first, PIM order ---------------------
    if (action === "add" || action === "replace") {
      const { data: media, error: mediaErr } = await admin
        .from("product_media")
        .select("storage_path, is_primary, display_order")
        .eq("sku", sku)
        .eq("media_type", "image")
        .order("is_primary", { ascending: false })
        .order("display_order", { ascending: true });
      if (mediaErr) throw new Error(`PIM media read failed: ${mediaErr.message}`);
      const all = (media ?? [])
        .map((m) => m.storage_path)
        .filter((u) => /^https?:\/\//i.test(u ?? ""));
      if (!all.length) return json({ error: `${sku} has no images in the PIM.` }, 400);
      const urls = all.slice(0, WIX_MEDIA_CAP);
      report.pim_images = all.length;
      report.capped = all.length > WIX_MEDIA_CAP;
      if (all.length > WIX_MEDIA_CAP) report.skipped_over_cap = all.length - WIX_MEDIA_CAP;

      let added = 0;
      for (let i = 0; i < urls.length; i += CHUNK) {
        const chunk = urls.slice(i, i + CHUNK).map((url) => ({ url }));
        const add = await wix(`/stores/v1/products/${id}/media`, {
          method: "POST",
          body: JSON.stringify({ media: chunk }),
        });
        if (!add.ok) {
          const addBody = await add.text();
          throw new Error(`Wix media add ${add.status} (after ${added}): ${addBody.slice(0, 300)}`);
        }
        added += chunk.length;
      }
      report.added = added;
    }

    // --- read back what Wix now holds ---------------------------------------
    const after = await wix(`/stores/v1/products/${id}`);
    const afterBody = await after.json();
    report.wix_media_now = (afterBody.product?.media?.items ?? []).length;
    report.main_media_set = Boolean(afterBody.product?.media?.mainMedia);

    return json({ ok: true, ...report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[wix-push-media] FAILED:", message);
    return json({ error: message }, 500);
  }
});
