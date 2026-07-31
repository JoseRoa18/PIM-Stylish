// Stylish PIM ← Best Buy Canada (Mirakl): pull the seller's offers.
//
// STRICTLY READ-ONLY: this function only performs GET requests against the
// Mirakl offers API — it never creates, updates or deletes anything at
// Best Buy. It exists so the browser never sees the API key (Supabase secret)
// and to avoid CORS.
//
// Request body: {} (none needed)
// Response: { ok, total, offers: [{ sku, price, quantity, active, state,
//   category_code, category_label, product_title, product_brand, upc }] }
// The product fields feed the read-only catalog audit (PIM vs Best Buy).
//
// Required secrets: BESTBUY_API_KEY

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const apiKey = Deno.env.get("BESTBUY_API_KEY");
  if (!apiKey) return json({ error: "BESTBUY_API_KEY secret is not set" }, 500);

  // product_references is an object or an array of { reference, reference_type }
  // (e.g. UPC-A / EAN) — pick the barcode-style one.
  function extractUpc(refs: unknown): string | null {
    const list = Array.isArray(refs) ? refs : refs ? [refs] : [];
    const barcode = list.find((r) =>
      /UPC|EAN|GTIN/i.test(String((r as { reference_type?: string })?.reference_type ?? "")),
    ) ?? list[0];
    const value = (barcode as { reference?: string } | undefined)?.reference;
    return value ? String(value) : null;
  }

  try {
    const offers: Array<{
      sku: string; price: number | null; quantity: number; active: boolean; state: string;
      category_code: string | null; category_label: string | null;
      product_title: string | null; product_brand: string | null; upc: string | null;
    }> = [];
    let offset = 0;
    let total = 0;
    do {
      const res = await fetch(
        `https://marketplace.bestbuy.ca/api/offers?max=100&offset=${offset}`,
        { headers: { Authorization: apiKey, Accept: "application/json" } },
      );
      if (!res.ok) {
        return json({ error: `Best Buy API ${res.status}: ${await res.text()}` }, 502);
      }
      const data = await res.json();
      total = data.total_count ?? 0;
      for (const o of data.offers ?? []) {
        offers.push({
          sku: o.shop_sku,
          price: o.price ?? null,
          quantity: o.quantity ?? 0,
          active: Boolean(o.active),
          state: String(o.state_code ?? ""),
          category_code: o.category_code ?? null,
          category_label: o.category_label ?? null,
          product_title: o.product_title ?? null,
          product_brand: o.product_brand ?? null,
          upc: extractUpc(o.product_references),
        });
      }
      offset += 100;
      if (!data.offers?.length) break;
    } while (offers.length < total);

    return json({ ok: true, total, offers });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
