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

// Selectable market contexts. CA is the default (the supplier account is the
// Canadian entity); CA_FR pushes the PIM's French content to the same market.
const MARKETS: Record<string, { locale: string; country: string; brand: string }> = {
  CA: { locale: "en-CA", country: "CANADA", brand: "WAYFAIR" },
  CA_FR: { locale: "fr-CA", country: "CANADA", brand: "WAYFAIR" },
  US: { locale: "en-US", country: "UNITED_STATES", brand: "WAYFAIR" },
};

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
    const { sku, validateOnly = true, pushContent = true, pushMedia = true, statusRequestId, supplier = "CAN" } = body;
    if (!sku && !statusRequestId) return json({ error: "sku or statusRequestId is required" }, 400);
    // Two separate Wayfair supplier accounts, each with its own catalog and
    // credentials. Default market follows the supplier's home storefront.
    const market = body.market ?? (supplier === "USA" ? "US" : "CA");
    const MARKET = MARKETS[market];
    if (!MARKET) return json({ error: `unknown market "${market}" (use CA, CA_FR or US)` }, 400);

    const CLIENT_ID = supplier === "USA" ? Deno.env.get("WAYFAIR_USA_CLIENT_ID") : Deno.env.get("WAYFAIR_CLIENT_ID");
    const CLIENT_SECRET = supplier === "USA" ? Deno.env.get("WAYFAIR_USA_CLIENT_SECRET") : Deno.env.get("WAYFAIR_CLIENT_SECRET");
    const SUPPLIER_ID = supplier === "USA" ? Deno.env.get("WAYFAIR_USA_SUPPLIER_ID") : Deno.env.get("WAYFAIR_SUPPLIER_ID");
    const ENV = Deno.env.get("WAYFAIR_ENV") ?? "sandbox";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!CLIENT_ID || !CLIENT_SECRET || !SUPPLIER_ID) {
      return json({ error: `Missing WAYFAIR_* secrets for supplier ${supplier}` }, 500);
    }

    // ---- Status lookup mode: report what Wayfair did with a prior request ----
    if (statusRequestId) {
      const endpoint = ENV === "production"
        ? "https://api.wayfair.io/v1/product-catalog-api/graphql"
        : "https://api.wayfair.io/sandbox/v1/product-catalog-api/graphql";
      const token = await getToken(CLIENT_ID, CLIENT_SECRET);
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-SELECTED-SUPPLIER-ID": String(SUPPLIER_ID),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `query($input: StatusOfUpdateRequestInput!) {
            statusOfUpdateRequest(input: $input) {
              requestId validationOnly status
              problems { code title detail catalogEntityIdentifier catalogEntityProperty inputValue }
              successfulUpdates { entityIdentifier catalogEntityProperty }
            }
          }`,
          variables: { input: { requestId: statusRequestId, supplierId: String(SUPPLIER_ID) } },
        }),
      });
      const gql = await r.json();
      if (gql.errors) return json({ error: gql.errors[0]?.message, details: gql.errors }, 502);
      return json({ ok: true, env: ENV, ...gql.data.statusOfUpdateRequest });
    }

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
    const { data: product, error: pErr } = await supabase
      .from("products")
      .select("sku, model_name, description, attributes, wayfair_item_group_id")
      .eq("sku", sku)
      .maybeSingle();
    if (pErr) return json({ error: `PIM read failed: ${pErr.message}` }, 500);
    if (!product) return json({ error: `Product ${sku} not found in PIM` }, 404);

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
          "X-SELECTED-SUPPLIER-ID": String(SUPPLIER_ID),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
      return r.json();
    };

    // The stored wayfair_item_group_id belongs to the CANADIAN supplier's
    // catalog. For any other supplier (or when nothing is stored) resolve the
    // listing id live from that supplier's own catalog.
    let itemGroupId = body.itemGroupId || (supplier === "CAN" ? product.wayfair_item_group_id : null) || null;
    if (!itemGroupId && pushContent) {
      const lookup = await call(
        `query($input: SupplierCatalogItemsInput!) {
          supplierCatalogItems(input: $input) {
            ... on SupplierCatalogItems { catalogItems { supplierPartNumber listings { listingId } } }
          }
        }`,
        { input: { filter: { supplierPartNumbers: [sku] }, paginationOptions: { page: 1, pageSize: 30 } } },
      );
      itemGroupId = lookup.data?.supplierCatalogItems?.catalogItems?.[0]?.listings?.[0]?.listingId ?? null;
    }

    const result: Record<string, unknown> = { ok: true, validateOnly, sku, supplier, market, marketContext: MARKET, itemGroupId };

    // ---- Content (marketing copy + bullets) ----
    if (pushContent) {
      const attrs = product.attributes ?? {};
      // CA_FR pushes the PIM's French content; EN markets push the EN content.
      const marketingCopy = market === "CA_FR"
        ? htmlToText(String(attrs.description_fr ?? ""))
        : htmlToText(product.description ?? "");
      const featureBullets = (market === "CA_FR" ? attrs.bullet_points_fr : attrs.bullet_points) ?? [];
      if (!itemGroupId) {
        result.content = { skipped: `no itemGroupId — ${sku} not found in the ${supplier} supplier's Wayfair catalog` };
      } else if (!marketingCopy && featureBullets.length < 3) {
        result.content = { skipped: "no marketing copy and < 3 bullets" };
      } else {
        const input = {
          supplierId: SUPPLIER_ID,
          validateOnly,
          marketContext: MARKET,
          // itemGroupName is intentionally NOT sent: Wayfair blocks renames that
          // strip the collection name from the listing title ("Collection names
          // cannot be removed or changed directly in the product name").
          catalogItemGroupsToUpdate: [
            { itemGroupId, marketingCopy, featureBullets },
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
