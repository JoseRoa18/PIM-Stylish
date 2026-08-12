// Create a PIM product on Wix — the missing first step of the per-channel
// publish flow (PIM first, then each marketplace by hand, channel by channel).
//
// Behavior the flow demands:
//   - The product is created HIDDEN (visible:false) regardless of the PIM's
//     visibility flag — publishing is a deliberate later push.
//   - If a Wix product with this SKU already exists but was never linked,
//     LINK it instead of creating a duplicate ({ linked_existing: true }).
//   - If the PIM row is already linked, refuse — that's an update, not a
//     create; the card's push flow handles it.
//   - On success the function itself writes wix_product_id + wix_synced_at
//     (service role), so the link can't be lost between two client calls.
//
// Field mapping mirrors wix-push-product's buildProductPatch so a create
// followed by a push never fights itself. Images are NOT part of phase 1 —
// they're managed on Wix until the media endpoint is wired.
//
// Body: { sku: string }
// Caller must be an authenticated admin or editor.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WIX_BASE = "https://www.wixapis.com";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface PimRow {
  sku: string;
  model_name: string | null;
  brand: string | null;
  description: string | null;
  ribbon: string | null;
  map_cad: number | null;
  sale_price_cad: number | null;
  on_sale: boolean | null;
  shipping_weight_lb: number | null;
  additional_info_sections: { title?: string; description?: string }[] | null;
  wix_product_id: string | null;
}

// Same shapes as wix-push-product's buildProductPatch, minus visibility
// (forced hidden on create) — keep the two in sync.
function buildCreateBody(pim: PimRow): Record<string, unknown> {
  const product: Record<string, unknown> = {
    name: pim.model_name?.trim() || pim.sku,
    productType: "physical",
    sku: pim.sku,
    visible: false,
    // SinksDirect sells at the Canadian MAP, not MSRP (user rule 2026-08-12).
    priceData: { price: pim.map_cad != null ? Number(pim.map_cad) : 0, currency: "CAD" },
  };
  if (pim.description != null) product.description = pim.description;
  if (pim.brand != null) product.brand = pim.brand;
  if (pim.ribbon != null) product.ribbon = pim.ribbon;
  if (pim.shipping_weight_lb != null) product.weight = Number(pim.shipping_weight_lb);
  if (pim.on_sale && pim.sale_price_cad != null && pim.map_cad != null) {
    const amount = Math.max(0, Number(pim.map_cad) - Number(pim.sale_price_cad));
    product.discount = { type: "AMOUNT", value: amount };
  }
  if (Array.isArray(pim.additional_info_sections)) {
    product.additionalInfoSections = pim.additional_info_sections
      .filter((s) => s && (s.title || s.description))
      .map((s) => ({ title: s.title ?? "", description: s.description ?? "" }));
  }
  return { product };
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
      return json({ error: "Only admins and editors can create Wix products." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const sku = typeof body.sku === "string" ? body.sku.trim() : "";
    if (!sku) return json({ error: "sku is required." }, 400);

    const { data: pim, error: pimErr } = await admin
      .from("products")
      .select("sku, model_name, brand, description, ribbon, map_cad, sale_price_cad, on_sale, shipping_weight_lb, additional_info_sections, wix_product_id")
      .eq("sku", sku)
      .maybeSingle();
    if (pimErr) throw new Error(`PIM read failed: ${pimErr.message}`);
    if (!pim) return json({ error: `${sku} not found in the PIM.` }, 404);
    if (pim.wix_product_id) {
      return json({ error: `${sku} is already linked to Wix — use Push to update it.` }, 409);
    }
    // No price, no listing: a hidden $0 product is one careless visibility
    // push away from being sold for nothing. Complete the PIM first.
    if (pim.map_cad == null) {
      return json({ error: `${sku} has no MAP (CAD) in the PIM — the SinksDirect selling price. Set its pricing first, then create it on Wix.` }, 400);
    }

    const wix = (path: string, init: RequestInit = {}) =>
      fetch(`${WIX_BASE}${path}`, {
        ...init,
        headers: {
          "Authorization": WIX_API_KEY,
          "wix-site-id": WIX_SITE_ID,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });

    // --- does Wix already have this SKU? Then LINK, don't duplicate ---------
    // Full paged scan (hidden products included) — the query index can lag a
    // few seconds, but for pre-existing products that's irrelevant.
    let existing: { id: string; name?: string } | null = null;
    let offset = 0;
    while (true) {
      const resp = await wix("/stores/v1/products/query", {
        method: "POST",
        body: JSON.stringify({ query: { paging: { limit: 100, offset } }, includeHiddenProducts: true }),
      });
      if (!resp.ok) throw new Error(`Wix query ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      const batch = data.products ?? [];
      const hit = batch.find((p: { sku?: string; variants?: { variant?: { sku?: string } }[] }) =>
        (p.sku?.trim() || p.variants?.[0]?.variant?.sku?.trim()) === sku);
      if (hit) { existing = { id: hit.id, name: hit.name }; break; }
      const total = data.totalResults ?? data.metadata?.count ?? batch.length;
      offset += batch.length;
      if (batch.length === 0 || offset >= total) break;
    }

    if (existing) {
      const { error: linkErr } = await admin
        .from("products")
        .update({ wix_product_id: existing.id, wix_synced_at: new Date().toISOString() })
        .eq("sku", sku);
      if (linkErr) throw new Error(`Link write failed: ${linkErr.message}`);
      return json({ linked_existing: true, id: existing.id, name: existing.name });
    }

    // --- create it, hidden --------------------------------------------------
    const createRes = await wix("/stores/v1/products", {
      method: "POST",
      body: JSON.stringify(buildCreateBody(pim as PimRow)),
    });
    const created = await createRes.json();
    const id = created?.product?.id;
    if (!createRes.ok || !id) {
      return json({ error: `Wix create failed (${createRes.status}): ${JSON.stringify(created).slice(0, 300)}` }, 502);
    }

    const { error: linkErr } = await admin
      .from("products")
      .update({ wix_product_id: id, wix_synced_at: new Date().toISOString() })
      .eq("sku", sku);
    if (linkErr) {
      // The product exists on Wix but the PIM link failed — surface loudly so
      // it can be re-linked instead of silently duplicated later.
      return json({ error: `Created on Wix (${id}) but linking failed: ${linkErr.message}. Re-run to link.` }, 500);
    }

    return json({
      created: true,
      id,
      name: created.product.name,
      visible: created.product.visible,
      price: created.product.priceData?.price ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[wix-create-product] FAILED:", message);
    return json({ error: message }, 500);
  }
});
