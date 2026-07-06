// Stylish PIM → Wayfair syndication (content + media).
//
// Pushes a product to Wayfair's catalog via the Product Catalog API:
//   - content: marketingCopy + featureBullets → updateMarketSpecificCatalogItemGroups
//              (needs the product's Wayfair itemGroupId; SKU-level/group content)
//   - media:   product images → updateCatalogItemsMedia (by supplierPartNumber,
//              no itemGroupId needed)
//
// Request body: {
//   sku: string,
//   itemGroupId?: string,        // falls back to products.wayfair_item_group_id
//   validateOnly?: boolean=true, // safe dry-run; validates without changing
//   pushContent?: boolean=true,
//   pushMedia?: boolean=true,
// }
//
// Content mapping (PIM → Wayfair):
//   marketingCopy  ← products.description (HTML stripped to plain text)
//   featureBullets ← attributes.bullet_points
//   images         ← product_media (public Supabase URLs), primary → lead image
//
// Required secrets:
//   WAYFAIR_CLIENT_ID, WAYFAIR_CLIENT_SECRET, WAYFAIR_SUPPLIER_ID, WAYFAIR_ENV

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MARKET = { locale: "en-US", country: "UNITED_STATES", brand: "WAYFAIR" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Strip HTML tags + decode a few common entities → plain text for Wayfair copy.
function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function getToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch("https://sso.auth.wayfair.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience: "https://api.wayfair.io",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Wayfair auth failed: ${JSON.stringify(data).slice(0, 200)}`);
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { sku, validateOnly = true, pushContent = true, pushMedia = true } = body;
    if (!sku) return json({ error: "sku is required" }, 400);

    const CLIENT_ID = Deno.env.get("WAYFAIR_CLIENT_ID");
    const CLIENT_SECRET = Deno.env.get("WAYFAIR_CLIENT_SECRET");
    const SUPPLIER_ID = Deno.env.get("WAYFAIR_SUPPLIER_ID");
    const ENV = Deno.env.get("WAYFAIR_ENV") ?? "sandbox";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!CLIENT_ID || !CLIENT_SECRET || !SUPPLIER_ID) {
      return json({ error: "Missing WAYFAIR_* secrets" }, 500);
    }

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
    const { data: product, error: pErr } = await supabase
      .from("products")
      .select("sku, model_name, description, attributes, wayfair_item_group_id")
      .eq("sku", sku)
      .maybeSingle();
    if (pErr) return json({ error: `PIM read failed: ${pErr.message}` }, 500);
    if (!product) return json({ error: `Product ${sku} not found in PIM` }, 404);

    const itemGroupId = body.itemGroupId || product.wayfair_item_group_id || null;
    const endpoint = ENV === "production"
      ? "https://api.wayfair.io/v1/product-catalog-api/graphql"
      : "https://api.wayfair.io/sandbox/v1/product-catalog-api/graphql";

    const token = await getToken(CLIENT_ID, CLIENT_SECRET);
    const call = async (query: string, variables: unknown) => {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-SELECTED-SUPPLIER": String(SUPPLIER_ID),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
      return r.json();
    };

    const result: Record<string, unknown> = { ok: true, validateOnly, sku };

    // ---- Content (marketing copy + bullets) ----
    if (pushContent) {
      const attrs = product.attributes ?? {};
      const marketingCopy = htmlToText(product.description ?? "");
      const featureBullets = attrs.bullet_points ?? [];
      if (!itemGroupId) {
        result.content = { skipped: "no itemGroupId (set products.wayfair_item_group_id)" };
      } else if (!marketingCopy && featureBullets.length < 3) {
        result.content = { skipped: "no marketing copy and < 3 bullets" };
      } else {
        const input = {
          supplierId: SUPPLIER_ID,
          validateOnly,
          marketContext: MARKET,
          catalogItemGroupsToUpdate: [
            { itemGroupId, itemGroupName: product.model_name ?? sku, marketingCopy, featureBullets },
          ],
        };
        const gql = await call(
          "mutation($input: UpdateMarketSpecificCatalogItemGroupsInput!) { updateCatalogEntitiesMutations { updateMarketSpecificCatalogItemGroups(input: $input) { requestId } } }",
          { input },
        );
        result.content = gql.errors
          ? { error: gql.errors[0]?.message, details: gql.errors }
          : { requestId: gql.data?.updateCatalogEntitiesMutations?.updateMarketSpecificCatalogItemGroups?.requestId, bullets: featureBullets.length };
      }
    }

    // ---- Media (images) ----
    if (pushMedia) {
      const { data: media } = await supabase
        .from("product_media")
        .select("storage_path, is_primary, display_order")
        .eq("sku", sku)
        .eq("media_type", "image")
        .order("display_order", { ascending: true });
      const images = (media ?? []).filter((m) => /^https?:\/\//i.test(m.storage_path ?? ""));
      if (images.length === 0) {
        result.media = { skipped: "no public image URLs" };
      } else {
        const input = {
          supplierId: SUPPLIER_ID,
          validateOnly,
          catalogItemsToUpdate: images.map((m) => ({
            supplierPartNumber: sku,
            mediaUrl: m.storage_path,
            mediaType: "IMAGE",
            leadImageOverride: !!m.is_primary,
          })),
        };
        const gql = await call(
          "mutation($input: UpdateCatalogItemsMediaInput!) { updateCatalogEntitiesMutations { updateCatalogItemsMedia(input: $input) { requestId } } }",
          { input },
        );
        result.media = gql.errors
          ? { error: gql.errors[0]?.message, details: gql.errors }
          : { requestId: gql.data?.updateCatalogEntitiesMutations?.updateCatalogItemsMedia?.requestId, count: images.length };
      }
    }

    // Mark synced on a real (non-validate) push that had no hard errors.
    if (!validateOnly) {
      const hadError = (result.content as { error?: string })?.error || (result.media as { error?: string })?.error;
      if (!hadError) {
        await supabase.from("products").update({ wayfair_synced_at: new Date().toISOString() }).eq("sku", sku);
      }
    }

    return json(result);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
