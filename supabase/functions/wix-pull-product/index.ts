// Wix Stores → Stylish PIM puller (bootstrap one product).
//
// For an already-linked PIM product (has wix_product_id), fetch the current
// Wix values for every syncable field and overwrite the PIM row. Useful when
// the product was first linked by SKU and the PIM never had Wix data.
//
// Overwrites the following columns:
//   model_name, description, brand, ribbon, shipping_weight_lb,
//   msrp_cad, dealer_cost_cad, sale_price_cad, on_sale,
//   visible_online, wix_collection_ids, additional_info_sections,
//   wix_synced_at, wix_raw
//
// Does NOT touch: sku, category, attributes, anything PIM-only.
//
// Request body: { sku: string }
//
// Required secrets:
//   WIX_API_KEY
//   WIX_SITE_ID

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Standard GUID regex. Wix's "All Products" pseudo-collection has a
// malformed id we don't want to persist or push later.
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
}

Deno.serve(async (req) => {
  console.log(`[wix-pull] ${req.method} ${req.url}`);

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
    console.log(`[wix-pull] sku=${sku}`);

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    const { data: pim, error: loadErr } = await supabase
      .from("products")
      .select("sku, wix_product_id")
      .eq("sku", sku)
      .maybeSingle();
    if (loadErr) {
      throw new Error(`Supabase select failed: ${loadErr.message ?? JSON.stringify(loadErr)}`);
    }
    if (!pim) {
      return new Response(
        JSON.stringify({ error: `Product not found in PIM: ${sku}` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!pim.wix_product_id) {
      return new Response(
        JSON.stringify({
          error: `Product ${sku} is not linked to Wix. Run "Preview Link with Wix" first.`,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Fetch current state from Wix
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
      throw new Error(`Wix get product ${wixResp.status}: ${text}`);
    }
    const wixData = await wixResp.json();
    const w: WixProduct = wixData.product ?? wixData;

    // ---------- Map fields ----------
    // Strategy: only overwrite a PIM field when Wix actually provides a value.
    // If Wix has no value (null / undefined / empty string), leave PIM as-is.
    // This prevents NOT-NULL violations on legacy columns when Wix returns
    // empty data for them — and matches the user's intuition that "pull"
    // brings in what Wix has, not "wipes whatever Wix doesn't have".
    const patch: Record<string, unknown> = {
      wix_synced_at: new Date().toISOString(),
      wix_raw: w,
    };

    const setText = (key: string, val: unknown) => {
      if (typeof val === "string" && val.trim().length > 0) patch[key] = val;
    };
    const setNumber = (key: string, val: unknown) => {
      if (typeof val === "number" && Number.isFinite(val)) patch[key] = val;
    };
    const setBool = (key: string, val: unknown) => {
      if (typeof val === "boolean") patch[key] = val;
    };

    setText("model_name", w.name);
    setText("description", w.description);
    setText("brand", w.brand);
    setText("ribbon", w.ribbon);
    setNumber("shipping_weight_lb", w.weight);
    setNumber("msrp_cad", w.price?.price);
    setNumber("dealer_cost_cad", w.costAndProfitData?.itemCost);
    setBool("visible_online", w.visible);

    // Arrays: an empty array is a meaningful state ("no categories", "no
    // sections"), so always set them.
    patch.additional_info_sections = Array.isArray(w.additionalInfoSections)
      ? w.additionalInfoSections.map((s) => ({
          title: s.title ?? "",
          description: s.description ?? "",
        }))
      : [];
    patch.wix_collection_ids = Array.isArray(w.collectionIds)
      ? w.collectionIds.filter((id) => GUID_RE.test(id))
      : [];

    // Discount → on_sale + sale_price_cad. Only mutate the sale state if Wix
    // gave us pricing context to act on; otherwise leave the existing PIM
    // values alone (we don't want to silently flip on_sale=false).
    const discountVal = typeof w.discount?.value === "number" ? w.discount.value : null;
    const price = typeof w.price?.price === "number" ? w.price.price : null;
    if (discountVal !== null && price !== null) {
      if (discountVal > 0 && price > 0) {
        patch.on_sale = true;
        if (w.discount?.type === "PERCENT") {
          const sale = price * (1 - discountVal / 100);
          patch.sale_price_cad = Math.round(sale * 100) / 100;
        } else {
          patch.sale_price_cad = Math.max(0, Math.round((price - discountVal) * 100) / 100);
        }
      } else {
        patch.on_sale = false;
        patch.sale_price_cad = null;
      }
    }

    console.log(
      `[wix-pull] sku=${sku} patching keys:`,
      Object.keys(patch).join(", "),
    );

    // ---------- Write back ----------
    const { data: updated, error: updateErr } = await supabase
      .from("products")
      .update(patch)
      .eq("sku", sku)
      .select("*")
      .maybeSingle();
    if (updateErr) {
      throw new Error(`Supabase update failed: ${updateErr.message ?? JSON.stringify(updateErr)}`);
    }

    console.log(`[wix-pull] OK sku=${sku}`);
    return new Response(
      JSON.stringify({
        ok: true,
        sku,
        wix_product_id: pim.wix_product_id,
        product: updated,
        updated_fields: Object.keys(patch),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    let message: string;
    if (err instanceof Error) message = err.message;
    else if (err && typeof err === "object") {
      message = (err as Record<string, unknown>).message as string ?? JSON.stringify(err);
    } else message = String(err);
    console.error(`[wix-pull] FAILED:`, message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
