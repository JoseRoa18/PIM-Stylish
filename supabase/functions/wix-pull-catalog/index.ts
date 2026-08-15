// Read the ENTIRE Wix store catalog in one call (paginated server-side) —
// the fleet-level read that channel monitoring needs. Read-only: nothing is
// written to Wix. Callers (wixSync.refreshWixCatalog in the browser, the
// health-refresh cron) join the result against the PIM and persist the
// channel_health snapshot. Body: { site? } — defaults to SinksDirect Canada.

import { resolveWixSite } from "../_shared/wixSites.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface WixMediaItem {
  mediaType?: string;
  image?: { url?: string };
  thumbnail?: { url?: string };
}

interface WixProduct {
  id?: string;
  sku?: string;
  name?: string;
  visible?: boolean;
  description?: string;
  priceData?: { price?: number; discountedPrice?: number };
  additionalInfoSections?: Array<{ title?: string; description?: string }>;
  media?: { mainMedia?: WixMediaItem; items?: WixMediaItem[] };
  variants?: Array<{ variant?: { sku?: string } }>;
}

function pickSku(p: WixProduct): string | null {
  if (p.sku && p.sku.trim()) return p.sku.trim();
  const variantSku = p.variants?.[0]?.variant?.sku;
  if (variantSku && variantSku.trim()) return variantSku.trim();
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const WIX_API_KEY = Deno.env.get("WIX_API_KEY");
    if (!WIX_API_KEY) {
      return json({ error: "Missing WIX_API_KEY secret." }, 500);
    }
    const body = await req.json().catch(() => ({}));
    const site = resolveWixSite(body.site);
    const WIX_SITE_ID = site.siteId;

    const products: {
      id: string; sku: string | null; name: string; visible: boolean;
      price: number | null; discountedPrice: number | null;
      descriptionLength: number; imageCount: number; hasMainImage: boolean;
      sectionTitles: string[];
    }[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const resp = await fetch("https://www.wixapis.com/stores/v1/products/query", {
        method: "POST",
        headers: {
          "Authorization": WIX_API_KEY,
          "wix-site-id": WIX_SITE_ID,
          "Content-Type": "application/json",
        },
        // includeHiddenProducts: without it Wix silently omits non-visible
        // products — a linked product someone hid on the site would read as a
        // BROKEN LINK instead of "hidden". Found by the CRUD test: a fresh
        // hidden product never showed up in the pull.
        body: JSON.stringify({ query: { paging: { limit, offset } }, includeHiddenProducts: true }),
      });
      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Wix API ${resp.status}: ${errBody.slice(0, 200)}`);
      }
      const data = await resp.json();
      const batch: WixProduct[] = data.products ?? [];
      for (const p of batch) {
        // Compact content fingerprint per listing so listing-health can score
        // the store WITHOUT a per-product cache: strip the description down to
        // its text length, media down to counts, sections down to titles.
        const isImage = (m?: WixMediaItem) =>
          (m?.mediaType ?? "image").toLowerCase().includes("image");
        const images = (p.media?.items ?? []).filter(isImage);
        products.push({
          id: p.id ?? "",
          sku: pickSku(p),
          name: p.name ?? "",
          visible: p.visible !== false,
          price: p.priceData?.price ?? null,
          discountedPrice: p.priceData?.discountedPrice ?? null,
          descriptionLength: (p.description ?? "").replace(/<[^>]*>/g, "").trim().length,
          imageCount: images.length,
          hasMainImage: isImage(p.media?.mainMedia) &&
            Boolean(p.media?.mainMedia?.image?.url ?? p.media?.mainMedia?.thumbnail?.url),
          sectionTitles: (p.additionalInfoSections ?? [])
            .map((s) => (s.title ?? "").trim())
            .filter(Boolean),
        });
      }
      const total = data.totalResults ?? data.metadata?.count ?? products.length;
      offset += batch.length;
      if (batch.length === 0 || offset >= total) break;
    }

    return json({ site: site.key, total: products.length, products });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[wix-pull-catalog] FAILED:", message);
    return json({ error: message }, 500);
  }
});
