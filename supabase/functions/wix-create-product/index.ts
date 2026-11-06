// Create a PIM product on Wix — the missing first step of the per-channel
// publish flow (PIM first, then each marketplace by hand, channel by channel).
//
// Behavior the flow demands:
//   - A new product goes up VISIBLE and OUT OF STOCK, whatever the PIM's
//     visibility flag says (user, 2026-11-06: Odoo gives it its stock later).
//     Wix's own stock default is not relied on: it is created hidden, set to
//     0 units (the way the stores keep every product: quantity tracked) and
//     read back, only then shown. It is never visible and in stock. If it can't
//     be set to 0 it is deleted again and nothing is linked, so a retry starts
//     clean. A product Wix already has is linked as it is, stock untouched.
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
// Body: { sku: string, site?: string } — site defaults to SinksDirect
// Canada; the link is written to wix_links (plus the legacy products columns
// for the CA site).
// Caller must be an authenticated admin or editor.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isExcluded, excludedMessage } from "../_shared/exclusions.ts";
import { resolveWixSite, siteSells, type WixSite } from "../_shared/wixSites.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WIX_BASE = "https://www.wixapis.com";
// A product without options has this one variant in Wix's inventory.
const NO_OPTIONS_VARIANT = "00000000-0000-0000-0000-000000000000";

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
  map_usd: number | null;
  msrp_cad: number | null;
  msrp_usd: number | null;
  sale_price_cad: number | null;
  on_sale: boolean | null;
  shipping_weight_lb: number | null;
  additional_info_sections: { title?: string; description?: string }[] | null;
  wix_product_id: string | null;
}

// Same shapes as wix-push-product's buildProductPatch, minus visibility
// (hidden until it is out of stock) — keep the two in sync.
function buildCreateBody(pim: PimRow, site: WixSite): Record<string, unknown> {
  const price = pim[site.priceField as keyof PimRow] as number | null;
  const product: Record<string, unknown> = {
    name: pim.model_name?.trim() || pim.sku,
    productType: "physical",
    sku: pim.sku,
    visible: false,
    // Per-site selling price: SinksDirect sites sell at MAP, Stylish at MSRP.
    priceData: { price: price != null ? Number(price) : 0, currency: site.currency },
  };
  if (pim.description != null) product.description = pim.description;
  if (pim.brand != null) product.brand = pim.brand;
  if (pim.ribbon != null) product.ribbon = pim.ribbon;
  if (pim.shipping_weight_lb != null) product.weight = Number(pim.shipping_weight_lb);
  if (site.hasSale && pim.on_sale && pim.sale_price_cad != null && price != null) {
    const amount = Math.max(0, Number(price) - Number(pim.sale_price_cad));
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
    const site = resolveWixSite(body.site);

    const { data: pim, error: pimErr } = await admin
      .from("products")
      .select("sku, model_name, brand, description, ribbon, map_cad, map_usd, msrp_cad, msrp_usd, sale_price_cad, on_sale, shipping_weight_lb, additional_info_sections, wix_product_id, channel_exclusions")
      .eq("sku", sku)
      .maybeSingle();
    if (pimErr) throw new Error(`PIM read failed: ${pimErr.message}`);
    if (!pim) return json({ error: `${sku} not found in the PIM.` }, 404);
    if (isExcluded(pim, `wix_${site.key}`)) return json({ error: excludedMessage(sku, `wix_${site.key}`) }, 409);
    // Brand rule (2026-09-09): Azuni is never sold on the Stylish stores.
    if (!siteSells(site, pim.brand)) return json({ error: `${sku} is ${pim.brand} — ${pim.brand} products are not sold on ${site.label}.` }, 409);
    const { data: linkRow, error: linkReadErr } = await admin
      .from("wix_links")
      .select("wix_product_id")
      .eq("site", site.key)
      .eq("sku", sku)
      .maybeSingle();
    if (linkReadErr) throw new Error(`Link read failed: ${linkReadErr.message}`);
    if (linkRow || (site.legacyColumns && pim.wix_product_id)) {
      return json({ error: `${sku} is already linked to ${site.label} — use Push to update it.` }, 409);
    }
    // No price, no listing: a $0 product is one stock update away from being
    // sold for nothing. Complete the PIM first.
    if (pim[site.priceField] == null) {
      return json({ error: `${sku} has no ${site.priceField.replace("_", " ").toUpperCase()} in the PIM — the ${site.label} selling price. Set its pricing first, then create it on Wix.` }, 400);
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

    // Writes the per-site link; the legacy products columns follow for CA.
    async function writeLink(wixProductId: string): Promise<string | null> {
      const now = new Date().toISOString();
      const { error: linkErr } = await admin
        .from("wix_links")
        .upsert(
          { site: site.key, sku, wix_product_id: wixProductId, synced_at: now },
          { onConflict: "site,sku" },
        );
      if (linkErr) return linkErr.message;
      if (site.legacyColumns) {
        const { error: legacyErr } = await admin
          .from("products")
          .update({ wix_product_id: wixProductId, wix_synced_at: now })
          .eq("sku", sku);
        if (legacyErr) return legacyErr.message;
      }
      return null;
    }

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
      const linkErrMsg = await writeLink(existing.id);
      if (linkErrMsg) throw new Error(`Link write failed: ${linkErrMsg}`);
      return json({ linked_existing: true, site: site.key, id: existing.id, name: existing.name });
    }

    // 0 units, quantity tracked. Returns an error text, or null once Wix reads it out of stock.
    async function setOutOfStock(wixProductId: string): Promise<string | null> {
      const res = await wix(`/stores/v2/inventoryItems/product/${wixProductId}`, {
        method: "PATCH",
        body: JSON.stringify({ inventoryItem: { trackQuantity: true, variants: [{ variantId: NO_OPTIONS_VARIANT, quantity: 0 }] } }),
      });
      if (!res.ok) return `Wix inventory ${res.status}: ${(await res.text()).slice(0, 200)}`;
      // The read can lag the write by a moment.
      for (let i = 0; i < 5; i += 1) {
        if (i) await new Promise((r) => setTimeout(r, 1000));
        const read = await wix(`/stores/v1/products/${wixProductId}`);
        if (!read.ok) continue;
        const { product } = await read.json();
        if (product?.stock?.inStock === false) return null;
      }
      return "Wix still reads it in stock";
    }

    // --- create it: hidden, out of stock, then shown --------------------------
    const createRes = await wix("/stores/v1/products", {
      method: "POST",
      body: JSON.stringify(buildCreateBody(pim as PimRow, site)),
    });
    const created = await createRes.json();
    const id = created?.product?.id;
    if (!createRes.ok || !id) {
      return json({ error: `Wix create failed (${createRes.status}): ${JSON.stringify(created).slice(0, 300)}` }, 502);
    }

    const stockErr = await setOutOfStock(id);
    if (stockErr) {
      // Never left behind in stock: taken off again (only the product this call
      // just made), nothing linked, and a retry creates it from the start.
      const del = await wix(`/stores/v1/products/${id}`, { method: "DELETE" });
      return json({
        error: del.ok
          ? `${sku} could not be set out of stock on ${site.label} (${stockErr}), so it was not created. Try again.`
          : `${sku} could not be set out of stock on ${site.label} (${stockErr}) and could not be removed: hidden product ${id} is left on the store. Remove it in Wix before trying again.`,
      }, 502);
    }

    // Out of stock is sure: now it can be seen. A failure here leaves it hidden
    // and out of stock, which is safe; the page says so and a push shows it.
    const showRes = await wix(`/stores/v1/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ product: { visible: true } }),
    });
    const visible = showRes.ok;

    const linkErrMsg = await writeLink(id);
    if (linkErrMsg) {
      // The product exists on Wix but the PIM link failed — surface loudly so
      // it can be re-linked instead of silently duplicated later.
      return json({ error: `Created on ${site.label} (${id}) but linking failed: ${linkErrMsg}. Re-run to link.` }, 500);
    }

    return json({
      created: true,
      site: site.key,
      id,
      name: created.product.name,
      visible,
      out_of_stock: true,
      ...(visible ? {} : { warning: `Created out of stock, but Wix did not show it (${showRes.status}): it stays hidden until the next push.` }),
      price: created.product.priceData?.price ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[wix-create-product] FAILED:", message);
    return json({ error: message }, 500);
  }
});
