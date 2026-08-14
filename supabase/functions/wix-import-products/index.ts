// Wix Stores → Stylish PIM linker (link-only mode).
//
// What this does:
//   - Fetch every product from the chosen Wix site's Stores catalog.
//   - For each Wix product with a SKU, find the matching PIM row (by sku).
//   - Upsert the (site, sku) row in wix_links; for SinksDirect CA the legacy
//     products.wix_product_id / wix_synced_at columns are kept in sync too.
//   - Does NOT insert new rows. Does NOT modify name/brand/description/price/category.
//
// Modes:
//   { dryRun: true, site? }   → no DB writes, returns a preview of what would link.
//   { dryRun: false, site? }  → applies the updates. site defaults to SinksDirect CA.
//
// Required secrets (Supabase Dashboard → Edge Functions → Secrets):
//   WIX_API_KEY   — account-level Wix API key
//   WIX_SITE_ID   — SinksDirect Canada site UUID
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { resolveWixSite } from "../_shared/wixSites.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface WixProduct {
  id: string;
  name?: string;
  sku?: string;
  variants?: Array<{ variant?: { sku?: string } }>;
}

function pickSku(p: WixProduct): string | null {
  if (p.sku && p.sku.trim()) return p.sku.trim();
  const variantSku = p.variants?.[0]?.variant?.sku;
  if (variantSku && variantSku.trim()) return variantSku.trim();
  return null;
}

async function fetchAllWixProducts(apiKey: string, siteId: string): Promise<WixProduct[]> {
  const all: WixProduct[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const resp = await fetch("https://www.wixapis.com/stores/v1/products/query", {
      method: "POST",
      headers: {
        "Authorization": apiKey,
        "wix-site-id": siteId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { paging: { limit, offset } } }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Wix API ${resp.status}: ${errBody}`);
    }

    const data = await resp.json();
    const batch: WixProduct[] = data.products ?? [];
    all.push(...batch);

    const total = data.totalResults ?? data.metadata?.count ?? all.length;
    offset += batch.length;
    if (batch.length === 0 || offset >= total) break;
  }

  return all;
}

Deno.serve(async (req) => {
  console.log(`[wix-link] ${req.method} ${req.url}`);

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

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun !== false;
    const site = resolveWixSite(body.site);
    console.log(`[wix-link] dryRun=${dryRun} site=${site.key}`);

    console.log(`[wix-link] fetching Wix products…`);
    const wixProducts = await fetchAllWixProducts(WIX_API_KEY, site.siteId);
    console.log(`[wix-link] got ${wixProducts.length} Wix products`);

    console.log(`[wix-link] loading PIM rows…`);
    const { data: existing, error: loadErr } = await supabase
      .from("products")
      .select("sku");
    if (loadErr) {
      throw new Error(`Database select failed: ${loadErr.message ?? JSON.stringify(loadErr)}`);
    }
    const { data: links, error: linksErr } = await supabase
      .from("wix_links")
      .select("sku, wix_product_id")
      .eq("site", site.key);
    if (linksErr) throw new Error(`Link select failed: ${linksErr.message}`);
    console.log(`[wix-link] loaded ${existing?.length ?? 0} PIM rows, ${links?.length ?? 0} existing links`);

    type ExistingRow = { sku: string; wix_product_id: string | null };
    const bySku = new Map<string, ExistingRow>();
    for (const row of (existing ?? []) as { sku: string }[]) {
      bySku.set(row.sku, { sku: row.sku, wix_product_id: null });
    }
    for (const link of (links ?? []) as { sku: string; wix_product_id: string }[]) {
      const row = bySku.get(link.sku);
      if (row) row.wix_product_id = link.wix_product_id;
    }

    // Classify each Wix product against the PIM.
    interface LinkOp { sku: string; wix_product_id: string; alreadyLinked: boolean }
    const linkOps: LinkOp[] = [];
    const wixOnly: Array<{ sku: string; name: string | null; wix_product_id: string }> = [];
    const skippedNoSku: Array<{ wix_product_id: string; name: string | null }> = [];

    const summary = {
      wixTotal: wixProducts.length,
      newLinks: 0,        // PIM row found, no wix_product_id yet → will set it
      alreadyLinked: 0,   // PIM row found AND already has the same wix_product_id
      wixOnly: 0,         // Wix has it, PIM does not (skipped)
      skippedNoSku: 0,    // Wix product without SKU (skipped)
    };

    const sampleNewLinks: Array<{ sku: string; name: string | null }> = [];

    for (const p of wixProducts) {
      const sku = pickSku(p);
      if (!sku) {
        summary.skippedNoSku++;
        skippedNoSku.push({ wix_product_id: p.id, name: p.name ?? null });
        continue;
      }

      const pimRow = bySku.get(sku);
      if (!pimRow) {
        summary.wixOnly++;
        if (wixOnly.length < 50) wixOnly.push({ sku, name: p.name ?? null, wix_product_id: p.id });
        continue;
      }

      const alreadyLinked = pimRow.wix_product_id === p.id;
      if (alreadyLinked) {
        summary.alreadyLinked++;
      } else {
        summary.newLinks++;
        if (sampleNewLinks.length < 5) sampleNewLinks.push({ sku, name: p.name ?? null });
      }
      // Always queue: even already-linked rows get wix_synced_at bumped.
      linkOps.push({ sku, wix_product_id: p.id, alreadyLinked });
    }

    console.log(`[wix-link] classified: newLinks=${summary.newLinks} alreadyLinked=${summary.alreadyLinked} wixOnly=${summary.wixOnly} skippedNoSku=${summary.skippedNoSku}`);

    // A site can carry two Wix products with the SAME SKU (e.g. a duplicate
    // listing). Keep the first match per SKU — a repeated (site, sku) key in
    // one upsert batch is a Postgres error ("cannot affect row a second time").
    const seenSkus = new Set<string>();
    const dupSkus: string[] = [];
    const dedupedOps = linkOps.filter((op) => {
      if (seenSkus.has(op.sku)) { dupSkus.push(op.sku); return false; }
      seenSkus.add(op.sku);
      return true;
    });
    if (dupSkus.length) console.log(`[wix-link] duplicate SKUs on site (kept first):`, dupSkus.join(","));

    let applied = 0;
    if (!dryRun && dedupedOps.length > 0) {
      const now = new Date().toISOString();
      console.log(`[wix-link] applying ${dedupedOps.length} link upserts…`);
      // Batch upserts into wix_links (chunked to keep payloads sane).
      for (let i = 0; i < dedupedOps.length; i += 200) {
        const chunk = dedupedOps.slice(i, i + 200).map((op) => ({
          site: site.key,
          sku: op.sku,
          wix_product_id: op.wix_product_id,
          synced_at: now,
        }));
        const { error } = await supabase
          .from("wix_links")
          .upsert(chunk, { onConflict: "site,sku" });
        if (error) {
          throw new Error(`Link upsert failed: ${error.message ?? JSON.stringify(error)}`);
        }
        applied += chunk.length;
      }
      // Legacy columns stay in sync for SinksDirect CA readers.
      if (site.legacyColumns) {
        for (const op of dedupedOps) {
          const { error } = await supabase
            .from("products")
            .update({ wix_product_id: op.wix_product_id, wix_synced_at: now })
            .eq("sku", op.sku);
          if (error) {
            console.error(`[wix-link] legacy update failed for sku=${op.sku}:`, JSON.stringify(error));
            throw new Error(`Update failed for sku=${op.sku}: ${error.message ?? JSON.stringify(error)}`);
          }
        }
      }
      console.log(`[wix-link] apply OK, applied=${applied}`);
    }

    return new Response(
      JSON.stringify({
        dryRun,
        site: site.key,
        summary,
        applied,
        duplicate_skus: dupSkus,
        samples: { newLinks: sampleNewLinks, wixOnly: wixOnly.slice(0, 10) },
        skippedNoSku,
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
    console.error(`[wix-link] FAILED:`, message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
