// Stylish PIM → Wix Stores pusher (full field set).
//
// Reads a single PIM product (by sku), pushes everything PIM owns to its
// linked Wix product:
//   PATCH /stores/v1/products/{id}
//     → name, description, brand, ribbon, price, sale (discount),
//       cost of goods, weight, visible (online store visibility),
//       additionalInfoSections
//   POST /stores/v1/collections/{id}/products/{productId}/add | remove
//     → reconcile the product's category membership with wix_collection_ids
//
// Fields stored in PIM but NOT yet pushed to Wix:
//   - visible_pos (POS visibility is managed by separate Wix settings)
//   - pre_order   (no v1 product PATCH support)
//
// Request body: { sku: string, fields?: Partial<PimRow> }
// If `fields` is provided, those values are pushed directly to Wix instead
// of reading from the PIM row. This lets the UI push edits without writing
// them to the PIM first (PIM = source of truth, not overwritten by channels).
//
// Required secrets:
//   WIX_API_KEY   — Wix API key with Stores write scope
//   WIX_SITE_ID   — site UUID

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface AdditionalInfoSection {
  title?: string;
  description?: string;
}

interface PimRow {
  sku: string;
  model_name: string | null;
  brand: string | null;
  description: string | null;
  ribbon: string | null;
  msrp_cad: number | null;
  sale_price_cad: number | null;
  on_sale: boolean | null;
  dealer_cost_cad: number | null;
  shipping_weight_lb: number | null;
  visible_online: boolean | null;
  additional_info_sections: AdditionalInfoSection[] | null;
  wix_collection_ids: string[] | null;
  wix_product_id: string | null;
}

const WIX_BASE = "https://www.wixapis.com";

async function wixFetch(
  apiKey: string,
  siteId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = {
    "Authorization": apiKey,
    "wix-site-id": siteId,
    "Content-Type": "application/json",
    ...(init.headers ?? {}),
  } as Record<string, string>;
  return fetch(`${WIX_BASE}${path}`, { ...init, headers });
}

async function getCurrentWixCollectionIds(
  apiKey: string,
  siteId: string,
  wixProductId: string,
): Promise<string[]> {
  // The product object itself carries its collectionIds — one GET vs. iterating
  // every collection in the store.
  const resp = await wixFetch(apiKey, siteId, `/stores/v1/products/${wixProductId}`, {
    method: "GET",
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Wix get product ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const ids: string[] = data.product?.collectionIds ?? data.collectionIds ?? [];
  return ids;
}

// Standard GUID. Wix's "All Products" virtual collection uses a malformed
// id (8-6-6-6-12 hex) and rejects all modify calls — never sync it.
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function syncCollections(
  apiKey: string,
  siteId: string,
  wixProductId: string,
  desiredIds: string[],
): Promise<{ added: string[]; removed: string[] }> {
  const current = (await getCurrentWixCollectionIds(apiKey, siteId, wixProductId))
    .filter((id) => GUID_RE.test(id));
  const desired = desiredIds.filter((id) => GUID_RE.test(id));
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);

  const toAdd = desired.filter((id) => !currentSet.has(id));
  const toRemove = current.filter((id) => !desiredSet.has(id));

  // Wix collection product membership uses /productIds (POST = add,
  // POST /productIds/delete = remove). Body shape: { productIds: [...] }.
  for (const cid of toAdd) {
    const r = await wixFetch(apiKey, siteId, `/stores/v1/collections/${cid}/productIds`, {
      method: "POST",
      body: JSON.stringify({ productIds: [wixProductId] }),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Add to collection ${cid} failed: ${r.status} ${text}`);
    }
  }
  for (const cid of toRemove) {
    const r = await wixFetch(apiKey, siteId, `/stores/v1/collections/${cid}/productIds/delete`, {
      method: "POST",
      body: JSON.stringify({ productIds: [wixProductId] }),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Remove from collection ${cid} failed: ${r.status} ${text}`);
    }
  }
  return { added: toAdd, removed: toRemove };
}

function buildProductPatch(pim: PimRow): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (pim.model_name != null) patch.name = pim.model_name;
  if (pim.description != null) patch.description = pim.description;
  if (pim.brand != null) patch.brand = pim.brand;
  if (pim.ribbon != null) patch.ribbon = pim.ribbon;
  if (pim.shipping_weight_lb != null) patch.weight = Number(pim.shipping_weight_lb);

  if (pim.msrp_cad != null) {
    patch.price = { price: Number(pim.msrp_cad), currency: "CAD" };
  }
  if (pim.dealer_cost_cad != null) {
    patch.costAndProfitData = { itemCost: Number(pim.dealer_cost_cad) };
  }

  // Discount: if on_sale, compute discount as AMOUNT off MSRP.
  // If off-sale, zero it out so Wix removes the sale.
  if (pim.on_sale && pim.sale_price_cad != null && pim.msrp_cad != null) {
    const amount = Math.max(0, Number(pim.msrp_cad) - Number(pim.sale_price_cad));
    patch.discount = { type: "AMOUNT", value: amount };
  } else {
    patch.discount = { type: "AMOUNT", value: 0 };
  }

  if (pim.visible_online != null) patch.visible = pim.visible_online;

  if (Array.isArray(pim.additional_info_sections)) {
    patch.additionalInfoSections = pim.additional_info_sections
      .filter((s) => s && (s.title || s.description))
      .map((s) => ({ title: s.title ?? "", description: s.description ?? "" }));
  }

  return patch;
}

Deno.serve(async (req) => {
  console.log(`[wix-push] ${req.method} ${req.url}`);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const WIX_API_KEY = Deno.env.get("WIX_API_KEY");
    const WIX_SITE_ID = Deno.env.get("WIX_SITE_ID");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!WIX_API_KEY || !WIX_SITE_ID) {
      return new Response(
        JSON.stringify({ error: "Missing WIX_API_KEY or WIX_SITE_ID secret." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const sku = typeof body.sku === "string" ? body.sku.trim() : "";
    if (!sku) {
      return new Response(
        JSON.stringify({ error: "Missing sku in request body." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    console.log(`[wix-push] sku=${sku}`);

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    // We always need the wix_product_id from the PIM row.
    const { data: pimRow, error: loadErr } = await supabase
      .from("products")
      .select(
        "sku, model_name, brand, description, ribbon, msrp_cad, sale_price_cad, on_sale, dealer_cost_cad, shipping_weight_lb, visible_online, additional_info_sections, wix_collection_ids, wix_product_id",
      )
      .eq("sku", sku)
      .maybeSingle<PimRow>();

    if (loadErr) {
      throw new Error(`Supabase select failed: ${loadErr.message ?? JSON.stringify(loadErr)}`);
    }
    if (!pimRow) {
      return new Response(
        JSON.stringify({ error: `Product not found in PIM: ${sku}` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!pimRow.wix_product_id) {
      return new Response(
        JSON.stringify({
          error: `Product ${sku} is not linked to Wix. Run "Preview Link with Wix" first.`,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // If the caller sent `fields`, use those instead of the PIM columns.
    const source: PimRow = body.fields
      ? { ...pimRow, ...body.fields, wix_product_id: pimRow.wix_product_id }
      : pimRow;

    const productPatch = buildProductPatch(source);
    if (Object.keys(productPatch).length === 0) {
      return new Response(
        JSON.stringify({ error: "Nothing to sync — all syncable fields are empty in PIM." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`[wix-push] PATCH Wix product ${pimRow.wix_product_id}, fields:`, Object.keys(productPatch).join(","));
    const wixResp = await wixFetch(WIX_API_KEY, WIX_SITE_ID, `/stores/v1/products/${pimRow.wix_product_id}`, {
      method: "PATCH",
      body: JSON.stringify({ product: productPatch }),
    });

    if (!wixResp.ok) {
      const errText = await wixResp.text();
      throw new Error(`Wix product PATCH ${wixResp.status}: ${errText}`);
    }
    const wixData = await wixResp.json();

    // Sync collections (categories) as a separate step. Failures here are
    // surfaced but the product PATCH already succeeded.
    let collectionsResult: { added: string[]; removed: string[] } | null = null;
    let collectionsError: string | null = null;
    try {
      collectionsResult = await syncCollections(
        WIX_API_KEY,
        WIX_SITE_ID,
        pimRow.wix_product_id,
        source.wix_collection_ids ?? [],
      );
    } catch (e) {
      collectionsError = e instanceof Error ? e.message : String(e);
      console.error(`[wix-push] collections sync failed:`, collectionsError);
    }

    // Stamp wix_synced_at so the PIM badge updates.
    const nowIso = new Date().toISOString();
    const { error: touchErr } = await supabase
      .from("products")
      .update({ wix_synced_at: nowIso })
      .eq("sku", sku);
    if (touchErr) {
      console.error(`[wix-push] failed to bump wix_synced_at:`, JSON.stringify(touchErr));
    }

    console.log(`[wix-push] OK sku=${sku}`);
    return new Response(
      JSON.stringify({
        ok: true,
        sku,
        wix_product_id: pimRow.wix_product_id,
        synced_fields: Object.keys(productPatch),
        collections: collectionsResult,
        collections_error: collectionsError,
        wix_synced_at: nowIso,
        wix_response: wixData,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    let message: string;
    if (err instanceof Error) {
      message = err.message;
    } else if (err && typeof err === "object") {
      const anyErr = err as Record<string, unknown>;
      message = (anyErr.message as string) ?? (anyErr.error as string) ?? JSON.stringify(err);
    } else {
      message = String(err);
    }
    console.error(`[wix-push] FAILED:`, message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
