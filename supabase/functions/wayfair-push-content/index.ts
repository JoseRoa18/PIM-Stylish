// Stylish PIM → Wayfair: media push for products ALREADY listed (Product
// Update API), plus a request-status lookup.
//
// RULES (2026-09-04, Canada first):
//   - Title, marketing copy, feature bullets and prices are NEVER sent.
//     Wayfair already carries the copy; prices have no API at all.
//   - Everything that travels is media, by public URL, in this order:
//       images  → white main leads, gray SinksDirect hero stays out,
//                 the market's language set (CA: EN-FR, else EN, else all)
//       videos  → the product family's .mp4 files
//       documents → PDFs: spec sheet, installation, cut-out template, warranty
//     Spec attributes are pushed by wayfair-push-attributes (separate call).
//   - mode "plan" returns the ordered steps and every item WITHOUT calling
//     Wayfair — the review screen. mode "push" executes the chosen steps and
//     returns one requestId per step; { statusRequestId } reports what
//     Wayfair did with a request (problems + successful updates).
//
// Body: { sku, supplier?: "CAN"|"USA", market?: "CA"|"CA_FR"|"US",
//         mode?: "plan"|"push", steps?: { images?, videos?, documents? },
//         validateOnly?: boolean (push mode; default false), statusRequestId? }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MARKETS: Record<string, { locale: string; country: string; brand: string; lang: "ca" | "us" }> = {
  CA: { locale: "en-CA", country: "CANADA", brand: "WAYFAIR", lang: "ca" },
  CA_FR: { locale: "fr-CA", country: "CANADA", brand: "WAYFAIR", lang: "ca" },
  US: { locale: "en-US", country: "UNITED_STATES", brand: "WAYFAIR", lang: "us" },
};
const IMAGE_CAP = 30;
const VIDEO_CAP = 5;
const DOC_CAP = 12;
const DOC_ORDER: [RegExp, string][] = [
  [/^spec_sheet$/, "Spec sheet"],
  [/^installation_/, "Installation guide"],
  [/^cut_out_template$/, "Cut-out template"],
  [/^warranty_file$/, "Warranty"],
];

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
async function getToken(clientId: string, clientSecret: string): Promise<string> {
  const hit = tokenCache.get(clientId);
  if (hit && Date.now() < hit.expiresAt) return hit.token;
  const res = await fetch("https://sso.auth.wayfair.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, audience: "https://api.wayfair.io" }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Wayfair auth failed: ${JSON.stringify(data).slice(0, 200)}`);
  tokenCache.set(clientId, { token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000 });
  return data.access_token;
}

type MediaRow = {
  id: string;
  storage_path: string;
  media_type: string;
  is_primary: boolean | null;
  display_order: number | null;
  image_role: string | null;
  language: string | null;
  document_type: string | null;
  file_name: string | null;
};
type Item = { url: string; label: string; kind: "image" | "video" | "document"; language: string | null; lead?: boolean; docType?: string | null };

const isHttp = (u: string | null) => /^https?:\/\//i.test(u ?? "");
const fileName = (u: string) => decodeURIComponent(u.split("?")[0].split("/").pop() ?? "");

// Same language rule as the Wix Canada push, so the two channels show the
// same artwork: EN-FR set when it exists, else EN, else everything (US: EN,
// else everything that is not French).
function pickImages(all: MediaRow[], lang: "ca" | "us") {
  const enFr = all.filter((m) => m.language === "en_fr" || m.language === "fr");
  const en = all.filter((m) => m.language === "en");
  if (lang === "ca" && enFr.length) return { chosen: enFr, set: "en_fr" };
  if (en.length) return { chosen: en, set: "en" };
  const rest = lang === "us" ? all.filter((m) => m.language !== "en_fr" && m.language !== "fr") : all;
  return { chosen: rest, set: "all" };
}

function buildPlan(media: MediaRow[], lang: "ca" | "us") {
  const images = media.filter((m) => m.media_type === "image" && isHttp(m.storage_path));
  const primary = images.find((m) => m.is_primary && m.image_role !== "sinksdirect_main") ?? null;
  const rest = images.filter((m) => m !== primary && m.image_role !== "sinksdirect_main");
  const { chosen, set } = pickImages(rest, lang);
  const orderedImages = [...(primary ? [primary] : []), ...chosen.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))];
  const imageItems: Item[] = orderedImages.slice(0, IMAGE_CAP).map((m, i) => ({
    url: m.storage_path, label: m.file_name || fileName(m.storage_path), kind: "image", language: m.language, lead: i === 0 && !!primary,
  }));

  const videoItems: Item[] = media
    .filter((m) => m.media_type === "video" && isHttp(m.storage_path) && /\.(mp4|mov)(\?|$)/i.test(m.storage_path))
    .filter((m) => lang === "ca" || (m.language !== "fr"))
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
    .slice(0, VIDEO_CAP)
    .map((m) => ({ url: m.storage_path, label: m.file_name || fileName(m.storage_path), kind: "video", language: m.language }));

  const docs = media.filter((m) => m.media_type === "document" && isHttp(m.storage_path) && /\.pdf(\?|$)/i.test(m.storage_path));
  const docItems: Item[] = [];
  for (const [re, label] of DOC_ORDER) {
    for (const m of docs.filter((d) => re.test(d.document_type ?? ""))) {
      if (m.language === "en_es") continue;
      if (lang === "us" && m.language === "fr") continue;
      docItems.push({ url: m.storage_path, label: `${label}${m.language ? ` (${m.language.toUpperCase().replace("_", "-")})` : ""}`, kind: "document", language: m.language, docType: m.document_type });
    }
  }
  const skippedDocs = media.filter((m) => m.media_type === "document").length - docItems.length;
  return {
    steps: [
      { key: "images", label: "Images", items: imageItems, note: `${set === "en_fr" ? "EN-FR set" : set === "en" ? "EN set" : "all images"} · white main leads · gray hero not sent${orderedImages.length > IMAGE_CAP ? ` · ${orderedImages.length - IMAGE_CAP} beyond the cap not sent` : ""}` },
      { key: "videos", label: "Videos", items: videoItems, note: videoItems.length ? "MP4 files of the product family" : "no video file in the PIM" },
      { key: "documents", label: "Documents", items: docItems.slice(0, DOC_CAP), note: `PDF only${skippedDocs > 0 ? ` · ${skippedDocs} not sent (DXF, EN-ES or beyond the cap)` : ""}` },
    ],
    neverSent: ["Title", "Description (marketing copy)", "Feature bullets", "Prices"],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const { sku, supplier = "CAN", statusRequestId } = body;
    const mode: string = body.mode ?? (statusRequestId ? "status" : "plan");
    if (body.pushContent) return json({ error: "Title, description and bullets are never pushed to Wayfair." }, 400);
    if (!sku && !statusRequestId) return json({ error: "sku or statusRequestId is required" }, 400);
    const market = body.market ?? (supplier === "USA" ? "US" : "CA");
    const MARKET = MARKETS[market];
    if (!MARKET) return json({ error: `unknown market "${market}" (use CA, CA_FR or US)` }, 400);

    const CLIENT_ID = supplier === "USA" ? Deno.env.get("WAYFAIR_USA_CLIENT_ID") : Deno.env.get("WAYFAIR_CLIENT_ID");
    const CLIENT_SECRET = supplier === "USA" ? Deno.env.get("WAYFAIR_USA_CLIENT_SECRET") : Deno.env.get("WAYFAIR_CLIENT_SECRET");
    const SUPPLIER_ID = supplier === "USA" ? Deno.env.get("WAYFAIR_USA_SUPPLIER_ID") : Deno.env.get("WAYFAIR_SUPPLIER_ID");
    const ENV = Deno.env.get("WAYFAIR_ENV") ?? "sandbox";
    if (!CLIENT_ID || !CLIENT_SECRET || !SUPPLIER_ID) return json({ error: `Missing WAYFAIR_* secrets for supplier ${supplier}` }, 500);
    const endpoint = ENV === "production"
      ? "https://api.wayfair.io/v1/product-catalog-api/graphql"
      : "https://api.wayfair.io/sandbox/v1/product-catalog-api/graphql";
    const call = async (query: string, variables: unknown, operationName: string) => {
      const token = await getToken(CLIENT_ID, CLIENT_SECRET);
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "X-SELECTED-SUPPLIER-ID": String(SUPPLIER_ID), "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables, operationName }),
      });
      const raw = await r.text();
      try { return JSON.parse(raw); } catch { return { errors: [{ message: `${operationName}: HTTP ${r.status} ${raw.slice(0, 200)}` }] }; }
    };

    // ---- status: what Wayfair did with a request ----
    if (mode === "status") {
      const gql = await call(
        `query statusOfUpdateRequest($input: StatusOfUpdateRequestInput!) {
          statusOfUpdateRequest(input: $input) {
            requestId validationOnly status
            problems { code title detail catalogEntityIdentifier catalogEntityProperty inputValue }
            successfulUpdates { entityIdentifier catalogEntityProperty }
          }
        }`,
        { input: { requestId: statusRequestId, supplierId: String(SUPPLIER_ID) } },
        "statusOfUpdateRequest",
      );
      if (gql.errors) return json({ error: gql.errors[0]?.message, details: gql.errors }, 502);
      return json({ ok: true, env: ENV, ...gql.data.statusOfUpdateRequest });
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: product, error: pErr } = await supabase.from("products").select("sku, model_name, wayfair_item_group_id").eq("sku", sku).maybeSingle();
    if (pErr) return json({ error: `PIM read failed: ${pErr.message}` }, 500);
    if (!product) return json({ error: `Product ${sku} not found in PIM` }, 404);
    const { data: media, error: mErr } = await supabase
      .from("product_media")
      .select("id, storage_path, media_type, is_primary, display_order, image_role, language, document_type, file_name")
      .eq("sku", sku)
      .order("display_order", { ascending: true });
    if (mErr) return json({ error: `PIM media read failed: ${mErr.message}` }, 500);

    const plan = buildPlan((media ?? []) as MediaRow[], MARKET.lang);

    // Is the product in this supplier's Wayfair catalog? (plan info + push guard)
    const cat = await call(
      `query supplierCatalogItems($input: SupplierCatalogItemsInput!) {
        supplierCatalogItems(input: $input) { ... on SupplierCatalogItems { catalogItems { supplierPartNumber catalogItemStatus class { className } listings { listingId } } } }
      }`,
      { input: { filter: { supplierPartNumbers: [sku] }, paginationOptions: { page: 1, pageSize: 30 } } },
      "supplierCatalogItems",
    );
    const item = cat.data?.supplierCatalogItems?.catalogItems?.[0] ?? null;
    const listed = !!item;

    if (mode === "plan") {
      return json({
        ok: true, env: ENV, sku, supplier, market, listed,
        wayfair: item ? { status: item.catalogItemStatus, className: item.class?.className, listingId: item.listings?.[0]?.listingId ?? null } : null,
        ...plan,
      });
    }

    if (!listed) return json({ error: `${sku} is not in the Wayfair ${supplier} catalog — media can only be pushed to listed products.` }, 409);

    // ---- lead: Wayfair ignores leadImageOverride on an image it does not
    //      have yet, so the lead is forced in a SECOND pass, once the upload
    //      request has completed. Same URL → Wayfair matches the existing
    //      image and only applies the override.
    if (mode === "lead") {
      const lead = plan.steps[0].items.find((it) => it.lead);
      if (!lead) return json({ error: `${sku} has no white main picture to lead with.` }, 400);
      const gql = await call(
        "mutation setLead($input: UpdateCatalogItemsMediaInput!) { updateCatalogEntitiesMutations { updateCatalogItemsMedia(input: $input) { requestId } } }",
        { input: { supplierId: String(SUPPLIER_ID), validateOnly: false, catalogItemsToUpdate: [{ supplierPartNumber: sku, mediaUrl: lead.url, mediaType: "IMAGE", action: "UPLOAD", leadImageOverride: true }] } },
        "setLead",
      );
      if (gql.errors) return json({ error: gql.errors[0]?.message, details: gql.errors }, 502);
      return json({ ok: true, env: ENV, sku, supplier, lead: lead.label, requestId: gql.data?.updateCatalogEntitiesMutations?.updateCatalogItemsMedia?.requestId ?? null });
    }

    // ---- push: execute the chosen steps, in order ----
    const wanted = body.steps ?? { images: true, videos: true, documents: true };
    const validateOnly = body.validateOnly === true;
    const results: Record<string, unknown>[] = [];
    for (const step of plan.steps) {
      if (!wanted[step.key] || step.items.length === 0) continue;
      const mediaType = step.key === "images" ? "IMAGE" : step.key === "videos" ? "VIDEO" : "DOCUMENT";
      const input = {
        supplierId: String(SUPPLIER_ID),
        validateOnly,
        catalogItemsToUpdate: step.items.map((it) => ({
          supplierPartNumber: sku,
          mediaUrl: it.url,
          mediaType,
          action: "UPLOAD",
          ...(it.lead ? { leadImageOverride: true } : {}),
        })),
      };
      const gql = await call(
        "mutation pushMedia($input: UpdateCatalogItemsMediaInput!) { updateCatalogEntitiesMutations { updateCatalogItemsMedia(input: $input) { requestId } } }",
        { input },
        "pushMedia",
      );
      results.push({
        step: step.key,
        count: step.items.length,
        requestId: gql.data?.updateCatalogEntitiesMutations?.updateCatalogItemsMedia?.requestId ?? null,
        error: gql.errors ? gql.errors[0]?.message : null,
      });
      if (gql.errors) break; // keep the order honest: stop at the first refusal
    }
    return json({ ok: results.every((r) => !r.error), env: ENV, sku, supplier, market, validateOnly, results });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
