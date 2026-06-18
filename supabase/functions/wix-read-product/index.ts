// Read-only: fetch the current state of a product from Wix Stores
// WITHOUT writing anything to the PIM.
//
// Request body: { sku: string }
// Returns: the mapped Wix fields so the UI can show what's live in the store.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface WixMediaItem {
  mediaType?: string;
  image?: { url?: string };
  thumbnail?: { url?: string };
}

interface WixProduct {
  id: string;
  name?: string;
  description?: string;
  brand?: string;
  ribbon?: string;
  weight?: number;
  price?: { price?: number; currency?: string };
  costAndProfitData?: { itemCost?: number };
  discount?: { type?: "AMOUNT" | "PERCENT" | "NONE"; value?: number };
  visible?: boolean;
  collectionIds?: string[];
  additionalInfoSections?: Array<{ title?: string; description?: string }>;
  productPageUrl?: { base?: string; path?: string };
  media?: {
    mainMedia?: WixMediaItem;
    items?: WixMediaItem[];
  };
}

Deno.serve(async (req) => {
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

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    const { data: pim, error: loadErr } = await supabase
      .from("products")
      .select("sku, wix_product_id")
      .eq("sku", sku)
      .maybeSingle();

    if (loadErr) throw new Error(`Supabase select failed: ${loadErr.message}`);
    if (!pim) {
      return new Response(
        JSON.stringify({ error: `Product not found: ${sku}` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!pim.wix_product_id) {
      return new Response(
        JSON.stringify({ error: `Product ${sku} is not linked to Wix.` }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const wixResp = await fetch(
      `https://www.wixapis.com/stores/v1/products/${pim.wix_product_id}`,
      {
        method: "GET",
        headers: {
          "Authorization": WIX_API_KEY,
          "wix-site-id": WIX_SITE_ID,
        },
      },
    );
    if (!wixResp.ok) {
      const text = await wixResp.text();
      // 404 = the product no longer exists in Wix (stale link). Report it as a
      // clean "not found" state (HTTP 200) so the UI can flag a broken link,
      // instead of a generic API error that looks transient. Also clear the
      // cached Wix payload so the dashboard stops scoring against stale data.
      if (wixResp.status === 404) {
        const { error: clearErr } = await supabase
          .from("products")
          .update({ wix_raw: null })
          .eq("sku", sku);
        if (clearErr) {
          console.error(`[wix-read] cache clear failed (non-fatal):`, clearErr.message);
        }
        return new Response(
          JSON.stringify({ ok: true, sku, wix_product_id: pim.wix_product_id, exists: false }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Wix API ${wixResp.status}: ${text}`);
    }
    const wixData = await wixResp.json();
    const w: WixProduct = wixData.product ?? wixData;

    // Map to PIM-compatible field names (read-only snapshot)
    const discountVal = typeof w.discount?.value === "number" ? w.discount.value : null;
    const price = typeof w.price?.price === "number" ? w.price.price : null;
    let on_sale = false;
    let sale_price_cad: number | null = null;
    if (discountVal !== null && price !== null && discountVal > 0 && price > 0) {
      on_sale = true;
      if (w.discount?.type === "PERCENT") {
        sale_price_cad = Math.round(price * (1 - discountVal / 100) * 100) / 100;
      } else {
        sale_price_cad = Math.max(0, Math.round((price - discountVal) * 100) / 100);
      }
    }

    const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // Public storefront URL for the product (so the UI can link straight to it).
    const product_url = w.productPageUrl?.base
      ? `${w.productPageUrl.base}${w.productPageUrl.path ?? ""}`
      : null;

    // Extract media items from Wix and shape them like PIM's product_media rows
    // so the listing-health checkers (countImages, hasPrimaryImage) work uniformly.
    const wixMedia: Array<{ media_type: string; storage_path: string; is_primary: boolean }> = [];
    const mainUrl = w.media?.mainMedia?.image?.url ?? w.media?.mainMedia?.thumbnail?.url;
    if (mainUrl && (w.media?.mainMedia?.mediaType ?? "image").toLowerCase().includes("image")) {
      wixMedia.push({ media_type: "image", storage_path: mainUrl, is_primary: true });
    }
    for (const item of w.media?.items ?? []) {
      const url = item.image?.url ?? item.thumbnail?.url;
      if (!url) continue;
      if (url === mainUrl) continue;
      const type = (item.mediaType ?? "image").toLowerCase();
      wixMedia.push({
        media_type: type.includes("video") ? "video" : "image",
        storage_path: url,
        is_primary: false,
      });
    }

    const snapshot = {
      model_name: w.name ?? null,
      description: w.description ?? null,
      brand: w.brand ?? null,
      ribbon: w.ribbon ?? null,
      shipping_weight_lb: typeof w.weight === "number" ? w.weight : null,
      msrp_cad: price,
      dealer_cost_cad: w.costAndProfitData?.itemCost ?? null,
      on_sale,
      sale_price_cad,
      visible_online: w.visible ?? null,
      wix_collection_ids: Array.isArray(w.collectionIds)
        ? w.collectionIds.filter((id) => GUID_RE.test(id))
        : [],
      additional_info_sections: Array.isArray(w.additionalInfoSections)
        ? w.additionalInfoSections.map((s) => ({
            title: s.title ?? "",
            description: s.description ?? "",
          }))
        : [],
      product_url,
      _wix_media: wixMedia,
    };

    // Cache the raw Wix payload so the Listing Health dashboard can score
    // against actual Wix data without making one API call per product.
    // This only updates `wix_raw` (a cache column) — never PIM-owned fields.
    const cachePayload = { ...w, _fetched_at: new Date().toISOString() };
    const { error: cacheErr } = await supabase
      .from("products")
      .update({ wix_raw: cachePayload })
      .eq("sku", sku);
    if (cacheErr) {
      console.error(`[wix-read] cache update failed (non-fatal):`, cacheErr.message);
    }

    return new Response(
      JSON.stringify({ ok: true, sku, wix_product_id: pim.wix_product_id, snapshot }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[wix-read] FAILED:`, message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
