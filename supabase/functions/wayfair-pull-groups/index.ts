// Stylish PIM ← Wayfair: pull catalog listing/item-group IDs.
//
// Queries Wayfair's Product Catalog API (supplierCatalogItems) for every
// catalog item on the supplier account, maps supplierPartNumber → listingId
// (Wayfair's item-group identifier, e.g. "GTQE1086"), and fills
// products.wayfair_item_group_id for matching PIM SKUs.
//
// Request body: {
//   skus?: string[],       // limit the Wayfair query to these part numbers
//   apply?: boolean=false, // false = dry-run report; true = write to products
//   overwrite?: boolean=false, // also replace non-null wayfair_item_group_id
// }
//
// Response: { ok, supplier, totalWayfairItems, matched, unmatchedWayfair,
//             unmatchedPim, applied?, sample }
//
// Required secrets: WAYFAIR_CLIENT_ID, WAYFAIR_CLIENT_SECRET,
//                   WAYFAIR_SUPPLIER_ID, WAYFAIR_ENV
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

const CATALOG_QUERY = `query($input: SupplierCatalogItemsInput!) {
  supplierCatalogItems(input: $input) {
    __typename
    ... on SupplierCatalogItems {
      paginationInfo { page pageSize hasNextPage totalPages totalCount }
      supplier { supplierId supplierName }
      catalogItems {
        supplierPartNumber
        catalogItemStatus
        listings { listingId }
      }
    }
    ... on SupplierCatalogItemsError { __typename }
  }
}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { skus, apply = false, overwrite = false, supplier = "CAN" } = body as {
      skus?: string[];
      apply?: boolean;
      overwrite?: boolean;
      supplier?: string;
    };
    // products.wayfair_item_group_id holds the CANADIAN supplier's listing ids;
    // for other suppliers this endpoint is read-only (diff/report) until the
    // schema grows a per-supplier column.
    if (apply && supplier !== "CAN") {
      return json({ error: `apply=true is only supported for the CAN supplier (got ${supplier})` }, 400);
    }

    const CLIENT_ID = supplier === "USA" ? Deno.env.get("WAYFAIR_USA_CLIENT_ID") : Deno.env.get("WAYFAIR_CLIENT_ID");
    const CLIENT_SECRET = supplier === "USA" ? Deno.env.get("WAYFAIR_USA_CLIENT_SECRET") : Deno.env.get("WAYFAIR_CLIENT_SECRET");
    const SUPPLIER_ID = supplier === "USA" ? Deno.env.get("WAYFAIR_USA_SUPPLIER_ID") : Deno.env.get("WAYFAIR_SUPPLIER_ID");
    const ENV = Deno.env.get("WAYFAIR_ENV") ?? "sandbox";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!CLIENT_ID || !CLIENT_SECRET || !SUPPLIER_ID) {
      return json({ error: "Missing WAYFAIR_* secrets" }, 500);
    }

    const endpoint = ENV === "production"
      ? "https://api.wayfair.io/v1/product-catalog-api/graphql"
      : "https://api.wayfair.io/sandbox/v1/product-catalog-api/graphql";

    const token = await getToken(CLIENT_ID, CLIENT_SECRET);

    // Page through the supplier's Wayfair catalog.
    type WfItem = { supplierPartNumber: string; catalogItemStatus: string | null; listings: { listingId: string }[] };
    const items: WfItem[] = [];
    let supplier: { supplierId: string; supplierName: string } | null = null;
    let page = 1;
    const pageSize = 30; // Wayfair caps page size at 30
    for (;;) {
      const filter = skus?.length ? { supplierPartNumbers: skus } : undefined;
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-SELECTED-SUPPLIER-ID": String(SUPPLIER_ID),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: CATALOG_QUERY,
          variables: { input: { filter, paginationOptions: { page, pageSize } } },
        }),
      });
      const gql = await r.json();
      if (gql.errors) return json({ error: gql.errors[0]?.message, details: gql.errors }, 502);
      const out = gql.data?.supplierCatalogItems;
      if (out?.__typename !== "SupplierCatalogItems") {
        return json({ error: `Wayfair returned ${out?.__typename ?? "no data"}` }, 502);
      }
      supplier = out.supplier;
      items.push(...(out.catalogItems ?? []));
      if (!out.paginationInfo?.hasNextPage || page >= (out.paginationInfo?.totalPages ?? page)) break;
      page++;
      if (page > 200) break; // hard stop; 20k items is far beyond this catalog
    }

    // supplierPartNumber → first listingId
    const wfMap = new Map<string, string>();
    const noListing: string[] = [];
    for (const it of items) {
      const id = it.listings?.[0]?.listingId;
      if (id) wfMap.set(it.supplierPartNumber, id);
      else noListing.push(it.supplierPartNumber);
    }

    // Read PIM SKUs (optionally restricted) with their current group ids.
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
    let q = supabase.from("products").select("sku, wayfair_item_group_id");
    if (skus?.length) q = q.in("sku", skus);
    const { data: pimRows, error: pErr } = await q;
    if (pErr) return json({ error: `PIM read failed: ${pErr.message}` }, 500);

    const pimSkus = new Set((pimRows ?? []).map((r) => r.sku));
    const updates: { sku: string; id: string; had: string | null }[] = [];
    for (const row of pimRows ?? []) {
      const id = wfMap.get(row.sku);
      if (!id) continue;
      if (row.wayfair_item_group_id && !overwrite) continue;
      if (row.wayfair_item_group_id === id) continue;
      updates.push({ sku: row.sku, id, had: row.wayfair_item_group_id });
    }

    let applied = 0;
    if (apply) {
      for (const u of updates) {
        const { error } = await supabase
          .from("products")
          .update({ wayfair_item_group_id: u.id })
          .eq("sku", u.sku);
        if (!error) applied++;
      }
    }

    const unmatchedWayfair = [...wfMap.keys()].filter((s) => !pimSkus.has(s));
    return json({
      ok: true,
      env: ENV,
      supplier,
      totalWayfairItems: items.length,
      withListingId: wfMap.size,
      withoutListingId: noListing.length,
      matched: updates.length,
      ...(apply ? { applied } : { dryRun: true }),
      unmatchedWayfair: unmatchedWayfair.slice(0, 50),
      unmatchedWayfairCount: unmatchedWayfair.length,
      sample: updates.slice(0, 20),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
