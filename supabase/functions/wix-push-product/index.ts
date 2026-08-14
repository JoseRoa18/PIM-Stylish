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
// Request body: { sku: string, site?: string, fields?: Partial<PimRow> }
// `site` picks the Wix site (see _shared/wixSites.ts); defaults to
// SinksDirect Canada. The link comes from wix_links (site, sku) — the legacy
// products.wix_product_id column backs only the CA site.
// If `fields` is provided, those values are pushed directly to Wix instead
// of reading from the PIM row. This lets the UI push edits without writing
// them to the PIM first (PIM = source of truth, not overwritten by channels).
//
// Required secrets:
//   WIX_API_KEY   — account-level Wix API key (all sites)
//   WIX_SITE_ID   — SinksDirect Canada site UUID

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { resolveWixSite } from "../_shared/wixSites.ts";

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
  map_cad: number | null;
  map_usd: number | null;
  msrp_cad: number | null;
  msrp_usd: number | null;
  sale_price_cad: number | null;
  on_sale: boolean | null;
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

function buildProductPatch(
  pim: PimRow,
  site: { priceField: keyof PimRow; currency: string; hasSale: boolean },
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (pim.model_name != null) patch.name = pim.model_name;
  if (pim.description != null) patch.description = pim.description;
  if (pim.brand != null) patch.brand = pim.brand;
  if (pim.ribbon != null) patch.ribbon = pim.ribbon;
  if (pim.shipping_weight_lb != null) patch.weight = Number(pim.shipping_weight_lb);

  // Per-site selling price: SinksDirect sites sell at MAP, Stylish sites at
  // MSRP, in the market's currency (see _shared/wixSites.ts). Wix v1 updates
  // take the price under priceData (same shape the create endpoint uses) — a
  // top-level `price` field is silently ignored.
  const price = pim[site.priceField] as number | null;
  if (price != null) {
    patch.priceData = { price: Number(price), currency: site.currency };
  }
  // Discount: the PIM's sale fields are CAD promo prices for SinksDirect CA.
  // On other sites they'd be the wrong currency/base, so never touch their
  // discounts — those stay managed on the site until per-site promos land.
  if (site.hasSale) {
    if (pim.on_sale && pim.sale_price_cad != null && price != null) {
      const amount = Math.max(0, Number(price) - Number(pim.sale_price_cad));
      patch.discount = { type: "AMOUNT", value: amount };
    } else {
      patch.discount = { type: "AMOUNT", value: 0 };
    }
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
    const site = resolveWixSite(body.site);
    console.log(`[wix-push] sku=${sku} site=${site.key}`);

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    const { data: pimRow, error: loadErr } = await supabase
      .from("products")
      .select(
        "sku, model_name, brand, description, ribbon, map_cad, map_usd, msrp_cad, msrp_usd, sale_price_cad, on_sale, shipping_weight_lb, visible_online, additional_info_sections, wix_collection_ids, wix_product_id",
      )
      .eq("sku", sku)
      .maybeSingle<PimRow>();

    if (loadErr) {
      throw new Error(`Database select failed: ${loadErr.message ?? JSON.stringify(loadErr)}`);
    }
    if (!pimRow) {
      return new Response(
        JSON.stringify({ error: `Product not found in PIM: ${sku}` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // The per-site link lives in wix_links; the legacy products column backs
    // only SinksDirect CA rows that predate the table.
    const { data: linkRow, error: linkReadErr } = await supabase
      .from("wix_links")
      .select("wix_product_id")
      .eq("site", site.key)
      .eq("sku", sku)
      .maybeSingle();
    if (linkReadErr) throw new Error(`Link read failed: ${linkReadErr.message}`);
    const wixProductId = linkRow?.wix_product_id ??
      (site.legacyColumns ? pimRow.wix_product_id : null);
    if (!wixProductId) {
      return new Response(
        JSON.stringify({
          error: `Product ${sku} is not linked to ${site.label}. Link or create it there first.`,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    pimRow.wix_product_id = wixProductId;

    // If the caller sent `fields`, use those instead of the PIM columns.
    const source: PimRow = body.fields
      ? { ...pimRow, ...body.fields, wix_product_id: wixProductId }
      : pimRow;

    const productPatch = buildProductPatch(source, site);
    // `only` restricts the patch to the named Wix keys (e.g. ["priceData"])
    // — used by the price-alignment fixes so a correction can never touch
    // visibility, content, or anything else.
    if (Array.isArray(body.only) && body.only.length > 0) {
      for (const key of Object.keys(productPatch)) {
        if (!body.only.includes(key)) delete productPatch[key];
      }
    }
    if (Object.keys(productPatch).length === 0) {
      return new Response(
        JSON.stringify({ error: "Nothing to sync — all syncable fields are empty in PIM." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`[wix-push] PATCH Wix product ${wixProductId} on ${site.key}, fields:`, Object.keys(productPatch).join(","));
    const wixResp = await wixFetch(WIX_API_KEY, site.siteId, `/stores/v1/products/${wixProductId}`, {
      method: "PATCH",
      body: JSON.stringify({ product: productPatch }),
    });

    if (!wixResp.ok) {
      const errText = await wixResp.text();
      throw new Error(`Wix product PATCH ${wixResp.status}: ${errText}`);
    }
    const wixData = await wixResp.json();

    // Sync collections (categories) as a separate step. The PIM stores
    // SinksDirect CA collection GUIDs only — never push them to other sites.
    // Failures here are surfaced but the product PATCH already succeeded.
    let collectionsResult: { added: string[]; removed: string[] } | null = null;
    let collectionsError: string | null = null;
    if (site.hasCollections) {
      try {
        collectionsResult = await syncCollections(
          WIX_API_KEY,
          site.siteId,
          wixProductId,
          source.wix_collection_ids ?? [],
        );
      } catch (e) {
        collectionsError = e instanceof Error ? e.message : String(e);
        console.error(`[wix-push] collections sync failed:`, collectionsError);
      }
    }

    // Stamp the link's synced_at so the per-site badge updates; the legacy
    // products.wix_synced_at column follows only for SinksDirect CA.
    const nowIso = new Date().toISOString();
    const { error: stampErr } = await supabase
      .from("wix_links")
      .upsert(
        { site: site.key, sku, wix_product_id: wixProductId, synced_at: nowIso },
        { onConflict: "site,sku" },
      );
    if (stampErr) console.error(`[wix-push] failed to stamp wix_links:`, JSON.stringify(stampErr));
    if (site.legacyColumns) {
      const { error: touchErr } = await supabase
        .from("products")
        .update({ wix_synced_at: nowIso })
        .eq("sku", sku);
      if (touchErr) {
        console.error(`[wix-push] failed to bump wix_synced_at:`, JSON.stringify(touchErr));
      }
    }

    console.log(`[wix-push] OK sku=${sku}`);
    return new Response(
      JSON.stringify({
        ok: true,
        sku,
        site: site.key,
        wix_product_id: wixProductId,
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
