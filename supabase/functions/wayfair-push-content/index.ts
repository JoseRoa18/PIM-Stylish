// Stylish PIM → Wayfair content pusher.
//
// Pushes a product's marketing copy + feature bullets to Wayfair's catalog via
// the Product Catalog API (updateMarketSpecificCatalogItemGroups). Descriptions
// live at the item-GROUP (SKU) level on Wayfair, so this updates the group that
// the product's Wayfair itemGroupId points to.
//
// Request body: { sku: string, itemGroupId: string, validateOnly?: boolean=true, market?: "US" }
//   - validateOnly defaults to TRUE — validates the payload against Wayfair
//     without changing anything. Set false to actually apply.
//
// Content mapping (PIM → Wayfair):
//   marketingCopy  ← products.description (EN) / attributes.description_fr (FR)
//   featureBullets ← attributes.bullet_points (EN) / bullet_points_fr (FR)
//
// Required secrets:
//   WAYFAIR_CLIENT_ID, WAYFAIR_CLIENT_SECRET  — sandbox app OAuth creds
//   WAYFAIR_SUPPLIER_ID                        — e.g. 31948
//   WAYFAIR_ENV                                — "sandbox" (default) | "production"
//
// NOTE: productDescription.update / descriptionsByPart require a scope this app
// lacks (Access Denied); updateMarketSpecificCatalogItemGroups is the permitted
// path and carries marketingCopy + featureBullets.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MARKETS: Record<string, { locale: string; country: string; brand: string; lang: "en" | "fr" }> = {
  // Canada catalog updates are not allowed via the API, so we target the US
  // market with the English copy by default.
  US: { locale: "en-US", country: "UNITED_STATES", brand: "WAYFAIR", lang: "en" },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
    const { sku, itemGroupId, validateOnly = true, market = "US" } = await req.json();
    if (!sku) return json({ error: "sku is required" }, 400);
    if (!itemGroupId) return json({ error: "itemGroupId is required (Wayfair group id for this SKU)" }, 400);

    const mkt = MARKETS[market];
    if (!mkt) return json({ error: `Unsupported market "${market}"` }, 400);

    const CLIENT_ID = Deno.env.get("WAYFAIR_CLIENT_ID");
    const CLIENT_SECRET = Deno.env.get("WAYFAIR_CLIENT_SECRET");
    const SUPPLIER_ID = Deno.env.get("WAYFAIR_SUPPLIER_ID");
    const ENV = Deno.env.get("WAYFAIR_ENV") ?? "sandbox";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!CLIENT_ID || !CLIENT_SECRET || !SUPPLIER_ID) {
      return json({ error: "Missing WAYFAIR_CLIENT_ID / WAYFAIR_CLIENT_SECRET / WAYFAIR_SUPPLIER_ID secrets" }, 500);
    }

    // 1. Read the product content from the PIM.
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
    const { data: product, error: pErr } = await supabase
      .from("products")
      .select("sku, model_name, description, attributes")
      .eq("sku", sku)
      .maybeSingle();
    if (pErr) return json({ error: `PIM read failed: ${pErr.message}` }, 500);
    if (!product) return json({ error: `Product ${sku} not found in PIM` }, 404);

    const attrs = product.attributes ?? {};
    const marketingCopy = mkt.lang === "fr"
      ? (attrs.description_fr ?? product.description ?? "")
      : (product.description ?? "");
    const featureBullets = (mkt.lang === "fr" ? attrs.bullet_points_fr : attrs.bullet_points) ?? [];

    if (!marketingCopy && featureBullets.length < 3) {
      return json({ error: "Wayfair needs marketing copy or at least 3 feature bullets; product has neither." }, 400);
    }

    // 2. Push to Wayfair (validateOnly by default).
    const endpoint = ENV === "production"
      ? "https://api.wayfair.io/v1/product-catalog-api/graphql"
      : "https://api.wayfair.io/sandbox/v1/product-catalog-api/graphql";

    const token = await getToken(CLIENT_ID, CLIENT_SECRET);
    const input = {
      supplierId: SUPPLIER_ID,
      validateOnly,
      marketContext: { locale: mkt.locale, country: mkt.country, brand: mkt.brand },
      catalogItemGroupsToUpdate: [
        {
          itemGroupId,
          itemGroupName: product.model_name ?? sku,
          marketingCopy,
          featureBullets,
        },
      ],
    };

    const gqlRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-SELECTED-SUPPLIER": String(SUPPLIER_ID),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query:
          "mutation($input: UpdateMarketSpecificCatalogItemGroupsInput!) { updateCatalogEntitiesMutations { updateMarketSpecificCatalogItemGroups(input: $input) { requestId } } }",
        variables: { input },
      }),
    });
    const gql = await gqlRes.json();

    if (gql.errors) {
      return json({ error: gql.errors[0]?.message ?? "Wayfair error", details: gql.errors, validateOnly }, 400);
    }

    return json({
      ok: true,
      validateOnly,
      requestId: gql.data?.updateCatalogEntitiesMutations?.updateMarketSpecificCatalogItemGroups?.requestId ?? null,
      pushed: { marketingCopy: marketingCopy.slice(0, 80), bullets: featureBullets.length },
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
