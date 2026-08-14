// Push a product's PIM images to its linked Wix product. Wix ingests media
// BY URL (it downloads into its own Media Manager), and every PIM image is a
// public Storage URL — so "editing images from the PIM" is: send the URLs,
// in PIM order, primary first.
//
// Actions:
//   { sku, action: "add" }     → add the PIM's images to whatever Wix has
//   { sku, action: "replace" } → remove Wix's current media first, then add
//   { sku, action: "clear" }   → remove Wix's current media only
// Optional: { site } — which Wix site (defaults to SinksDirect Canada).
//
// Caller must be an authenticated admin or editor.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { resolveWixSite } from "../_shared/wixSites.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WIX_BASE = "https://www.wixapis.com";
const CHUNK = 50; // media items per add call — big enough that any real set goes in ONE ordered call
// Empirical Wix platform cap: ~16 media items stick per product; the excess
// is dropped SILENTLY (the add call still returns 200). We send the full
// selected set anyway (per the publish rules: what the PIM has, goes) and
// flag in the report when the set exceeds what Wix is known to keep.
const WIX_MEDIA_CAP = 16;

// Language rule by market. Canadian sites are bilingual: push the EN/FR set
// when the product has one; otherwise the EN set; otherwise everything left
// (EN/ES artwork and universal/untagged shots). US sites skip the French
// tier: EN set first, else the non-French remainder. Sets never mix — a
// product with 15 EN/FR + 15 EN/ES duplicates must not burn Wix's media cap
// on the duplicate copies.
interface PimImage {
  storage_path: string;
  language: string | null;
  image_role: string | null;
  is_primary: boolean | null;
}

function pickLanguageSet(all: PimImage[], market: "ca" | "us"): { chosen: PimImage[]; set: string } {
  if (market === "ca") {
    const enFr = all.filter((m) => m.language === "en_fr" || m.language === "fr");
    if (enFr.length) return { chosen: enFr, set: "en_fr" };
  }
  const en = all.filter((m) => m.language === "en");
  if (en.length) return { chosen: en, set: "en" };
  const rest = market === "us"
    ? all.filter((m) => m.language !== "en_fr" && m.language !== "fr")
    : all;
  return { chosen: rest, set: "en_es_universal" };
}

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
    const site = resolveWixSite(body.site);

    const { data: pim, error: pimErr } = await admin
      .from("products")
      .select("sku, wix_product_id")
      .eq("sku", sku)
      .maybeSingle();
    if (pimErr) throw new Error(`PIM read failed: ${pimErr.message}`);
    const { data: linkRow, error: linkErr } = await admin
      .from("wix_links")
      .select("wix_product_id")
      .eq("site", site.key)
      .eq("sku", sku)
      .maybeSingle();
    if (linkErr) throw new Error(`Link read failed: ${linkErr.message}`);
    const id = linkRow?.wix_product_id ??
      (site.legacyColumns ? pim?.wix_product_id ?? null : null);
    if (!id) {
      return json({ error: `${sku} is not linked to ${site.label} — create it first.` }, 409);
    }

    const wix = (path: string, init: RequestInit = {}) =>
      fetch(`${WIX_BASE}${path}`, {
        ...init,
        headers: {
          "Authorization": WIX_API_KEY,
          "wix-site-id": site.siteId,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });

    const report: Record<string, unknown> = { sku, action, site: site.key, wix_product_id: id };

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
        // The delete is ASYNC on Wix's side. Re-adding the same source URLs
        // before it settles re-attaches the old media items in their old
        // order — a replace that changes nothing (empirical: reordering the
        // gallery only works after the product reads back as empty).
        for (let i = 0; i < 15; i++) {
          const chk = await wix(`/stores/v1/products/${id}`);
          const chkBody = await chk.json();
          if ((chkBody.product?.media?.items ?? []).length === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    // --- add the PIM's images, primary first, PIM order ---------------------
    if (action === "add" || action === "replace") {
      const { data: media, error: mediaErr } = await admin
        .from("product_media")
        .select("storage_path, is_primary, display_order, language, image_role")
        .eq("sku", sku)
        .eq("media_type", "image")
        .order("is_primary", { ascending: false })
        .order("display_order", { ascending: true });
      if (mediaErr) throw new Error(`PIM media read failed: ${mediaErr.message}`);
      const valid = ((media ?? []) as PimImage[]).filter((m) => /^https?:\/\//i.test(m.storage_path ?? ""));
      if (!valid.length) return json({ error: `${sku} has no images in the PIM.` }, 400);

      // Dual main pictures: the gray-background hero (image_role =
      // sinksdirect_main) belongs to the SinksDirect sites ONLY. There it
      // always leads the gallery and the white marketplace main (is_primary)
      // stays OUT of the push — same shot, duplicate here. On the Stylish
      // brand sites the hero is excluded entirely and the white is_primary
      // leads (it's already first in the PIM ordering).
      const isSinksDirect = site.key.startsWith("sinksdirect");
      const sdMain = isSinksDirect
        ? valid.find((m) => m.image_role === "sinksdirect_main")
        : undefined;
      const all = valid.filter((m) =>
        m.image_role !== "sinksdirect_main" && !(sdMain && m.is_primary));

      const { chosen, set } = pickLanguageSet(all, site.market);
      const urls = [...(sdMain ? [sdMain] : []), ...chosen].map((m) => m.storage_path);
      report.sinksdirect_main = Boolean(sdMain);
      if (sdMain) report.marketplace_main_skipped = valid.some((m) => m.is_primary);
      report.pim_images = all.length;
      report.language_set = set;
      report.skipped_other_language = all.length - chosen.length;
      if (urls.length > WIX_MEDIA_CAP) {
        report.over_wix_cap = urls.length - WIX_MEDIA_CAP;
      }

      // One call with the whole ordered array: Wix preserves the array order
      // (verified live), while separate chunked calls risk interleaving as
      // each chunk's ingestion races the next.
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
