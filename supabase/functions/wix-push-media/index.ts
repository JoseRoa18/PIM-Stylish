// Push a product's PIM images to its linked Wix product.
//
// HOW THE IMAGES TRAVEL (changed 2026-09-04): Wix's "add product media by
// URL" silently drops imports from our Storage — Wix answers 200, then its
// fetcher never lands the file (Cloudflare bot management on the storage
// host; observed on P-205-2: 0 of 10 new files arrived, twice, while files
// Wix already held simply re-attached, which is why it "used to work").
// So the PIM now carries the bytes itself: download from Storage → upload to
// the site's Media Manager (generate-upload-url + PUT) → attach by media id
// in ONE ordered call → read the product back until the gallery matches.
// Uploads are cached per site in wix_media_files (keyed by Storage path +
// ETag) so a re-push only re-uploads files that changed.
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
// Empirical Wix platform cap: ~16 media items stick per product; the excess
// is dropped SILENTLY. We upload only what can stick and flag the rest.
const WIX_MEDIA_CAP = 16;
const UPLOAD_PARALLELISM = 3;
// How long to wait for Wix to settle (delete → empty, upload → READY,
// attach → gallery count) before we report what we see.
const SETTLE_TRIES = 12;
const SETTLE_MS = 2000;

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
  if (rest.length) return { chosen: rest, set: "en_es_universal" };
  // A product whose entire artwork is bilingual EN/FR (common) must not end
  // up photo-less on the US sites — bilingual beats blank.
  const enFr = all.filter((m) => m.language === "en_fr");
  return enFr.length ? { chosen: enFr, set: "en_fr_fallback" } : { chosen: all, set: "all_fallback" };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};
function fileNameOf(url: string): string {
  const clean = url.split("?")[0].split("#")[0];
  return decodeURIComponent(clean.substring(clean.lastIndexOf("/") + 1)) || "image.jpg";
}
function mimeOf(name: string, headerType: string | null): string {
  if (headerType && /^image\//i.test(headerType)) return headerType.split(";")[0].trim();
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXT[ext] ?? "image/jpeg";
}

// Run `fn` over `items` with bounded parallelism, preserving order of results.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const WIX_API_KEY = Deno.env.get("WIX_API_KEY")!;
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
    const readGallery = async (): Promise<string[]> => {
      const r = await wix(`/stores/v1/products/${id}`);
      const b = await r.json();
      if (!r.ok) throw new Error(`Wix read ${r.status}: ${JSON.stringify(b).slice(0, 200)}`);
      return (b.product?.media?.items ?? [])
        .map((m: { id?: string; image?: { id?: string } }) => m.id ?? m.image?.id)
        .filter(Boolean);
    };

    const report: Record<string, unknown> = { sku, action, site: site.key, wix_product_id: id };

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

      // Dual main pictures (rule 2026-08-31): EVERY Wix site — SinksDirect
      // AND Stylish — leads with the gray-background hero (image_role =
      // sinksdirect_main); the white marketplace main (is_primary) stays OUT
      // of the Wix push (same shot, duplicate here) and remains the main for
      // non-Wix channels. Products without a tagged hero fall back to the
      // white main leading.
      const sdMain = valid.find((m) => m.image_role === "sinksdirect_main");
      const all = valid.filter((m) =>
        m.image_role !== "sinksdirect_main" && !(sdMain && m.is_primary));

      const { chosen, set } = pickLanguageSet(all, site.market);
      const ordered = [...(sdMain ? [sdMain] : []), ...chosen];
      report.sinksdirect_main = Boolean(sdMain);
      if (sdMain) report.marketplace_main_skipped = valid.some((m) => m.is_primary);
      report.pim_images = all.length;
      report.language_set = set;
      report.skipped_other_language = all.length - chosen.length;
      if (ordered.length > WIX_MEDIA_CAP) report.over_wix_cap = ordered.length - WIX_MEDIA_CAP;
      const toSend = ordered.slice(0, WIX_MEDIA_CAP);

      // 1. Resolve each PIM image to a Wix media id: reuse the cached upload
      //    when the Storage ETag still matches, otherwise upload the bytes.
      const { data: cachedRows } = await admin
        .from("wix_media_files")
        .select("storage_path, wix_media_id, etag")
        .eq("site", site.key)
        .in("storage_path", toSend.map((m) => m.storage_path));
      const cached = new Map((cachedRows ?? []).map((r) => [r.storage_path, r]));

      const failed: { file: string; error: string }[] = [];
      let uploaded = 0;
      let reused = 0;
      const resolved = await mapLimit(toSend, UPLOAD_PARALLELISM, async (m): Promise<string | null> => {
        const name = fileNameOf(m.storage_path);
        try {
          const src = await fetch(m.storage_path);
          if (!src.ok) throw new Error(`Storage ${src.status}`);
          const etag = src.headers.get("etag");
          const hit = cached.get(m.storage_path);
          if (hit && etag && hit.etag === etag) {
            src.body?.cancel();
            reused += 1;
            return hit.wix_media_id;
          }
          const bytes = new Uint8Array(await src.arrayBuffer());
          if (!bytes.length) throw new Error("Storage returned 0 bytes");
          const mime = mimeOf(name, src.headers.get("content-type"));

          const gen = await wix("/site-media/v1/files/generate-upload-url", {
            method: "POST",
            body: JSON.stringify({
              mimeType: mime,
              fileName: name,
              sizeInBytes: String(bytes.length),
              filePath: `/PIM/${sku}`,
            }),
          });
          const genBody = await gen.json().catch(() => ({}));
          if (!gen.ok || !genBody.uploadUrl) {
            throw new Error(`generate-upload-url ${gen.status}: ${JSON.stringify(genBody).slice(0, 200)}`);
          }
          const up = await fetch(`${genBody.uploadUrl}?filename=${encodeURIComponent(name)}`, {
            method: "PUT",
            headers: { "Content-Type": mime },
            body: bytes,
          });
          const upBody = await up.json().catch(() => ({}));
          const fileId: string | undefined = upBody.file?.id;
          if (!up.ok || !fileId) throw new Error(`upload ${up.status}: ${JSON.stringify(upBody).slice(0, 200)}`);

          // The file may still be post-processing; attaching a PENDING file
          // is the same silent no-op we are escaping, so wait for READY.
          let status = upBody.file?.operationStatus ?? "PENDING";
          for (let i = 0; status !== "READY" && status !== "FAILED" && i < SETTLE_TRIES; i++) {
            await sleep(SETTLE_MS);
            const d = await wix(`/site-media/v1/files/get-file-by-id?fileId=${encodeURIComponent(fileId)}`);
            const dBody = await d.json().catch(() => ({}));
            status = dBody.file?.operationStatus ?? status;
          }
          if (status === "FAILED") throw new Error("Wix post-processing FAILED");

          await admin.from("wix_media_files").upsert({
            site: site.key,
            storage_path: m.storage_path,
            wix_media_id: fileId,
            etag,
            size_bytes: bytes.length,
            uploaded_at: new Date().toISOString(),
          }, { onConflict: "site,storage_path" });
          uploaded += 1;
          return fileId;
        } catch (err) {
          failed.push({ file: name, error: err instanceof Error ? err.message : String(err) });
          return null;
        }
      });
      const mediaIds = resolved.filter((x): x is string => Boolean(x));
      report.uploaded = uploaded;
      report.reused = reused;
      if (failed.length) report.failed_uploads = failed;

        // --- replace: only now drop what Wix has. Uploads happened first so a
        //     failed upload never leaves the product photo-less. ---------------
      if (action === "replace") {
        const ids = await readGallery();
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
          // The delete is ASYNC on Wix's side — wait until the product reads
          // back as empty before re-attaching, or the new order won't stick.
          for (let i = 0; i < SETTLE_TRIES; i++) {
            if ((await readGallery()).length === 0) break;
            await sleep(SETTLE_MS);
          }
        }
      }

      // 2. Attach everything in ONE ordered call — Wix keeps the array order.
      if (mediaIds.length) {
        const add = await wix(`/stores/v1/products/${id}/media`, {
          method: "POST",
          body: JSON.stringify({ media: mediaIds.map((mediaId) => ({ mediaId })) }),
        });
        if (!add.ok) {
          const addBody = await add.text();
          throw new Error(`Wix media add ${add.status}: ${addBody.slice(0, 300)}`);
        }
      }
      report.added = mediaIds.length;

      // 3. Read back until the gallery holds what we attached (or give up).
      let now: string[] = [];
      for (let i = 0; i < SETTLE_TRIES; i++) {
        now = await readGallery();
        if (mediaIds.every((mid) => now.includes(mid))) break;
        await sleep(SETTLE_MS);
      }
      const missing = mediaIds.filter((mid) => !now.includes(mid));
      report.wix_media_now = now.length;
      report.missing = missing.length;
      if (missing.length) {
        report.warning = `${missing.length} of ${mediaIds.length} images did not land on ${site.label}`;
      }
    } else {
      // clear: drop everything, wait for Wix to settle, report what's left.
      const ids = await readGallery();
      report.existing_media = ids.length;
      if (ids.length) {
        const del = await wix(`/stores/v1/products/${id}/media/delete`, {
          method: "POST",
          body: JSON.stringify({ mediaIds: ids }),
        });
        if (!del.ok) throw new Error(`Wix media delete ${del.status}: ${(await del.text()).slice(0, 200)}`);
        report.removed = ids.length;
        for (let i = 0; i < SETTLE_TRIES; i++) {
          if ((await readGallery()).length === 0) break;
          await sleep(SETTLE_MS);
        }
      }
      report.wix_media_now = (await readGallery()).length;
    }

    return json({ ok: true, ...report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[wix-push-media] FAILED:", message);
    return json({ error: message }, 500);
  }
});
