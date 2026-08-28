// Stylish PIM ← Best Buy Canada (Mirakl): pull the seller's offers.
//
// STRICTLY READ-ONLY: this function only performs GET requests against the
// Mirakl offers API — it never creates, updates or deletes anything at
// Best Buy. It exists so the browser never sees the API key (Supabase secret)
// and to avoid CORS.
//
// Request body: {} (none needed)
// Response: { ok, total, offers: [{ sku, price, discount_price, discount_start,
//   discount_end, origin_price, quantity, active, state,
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

  // --- read-only inspection modes (diagnostics) ---------------------------
  //   { importId } → status of an OF24 import + its error report
  //   { sku }      → the raw Mirakl offer object for one shop_sku
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.importId) {
      const id = String(body.importId);
      const st = await fetch(`https://marketplace.bestbuy.ca/api/offers/imports/${id}`, {
        headers: { Authorization: apiKey, Accept: "application/json" },
      });
      const status = await st.json().catch(() => ({}));
      const rep = await fetch(`https://marketplace.bestbuy.ca/api/offers/imports/${id}/error_report`, {
        headers: { Authorization: apiKey },
      });
      const errorReport = rep.ok ? (await rep.text()).slice(0, 4000) : `(${rep.status})`;
      return json({ ok: true, import_id: id, status, error_report: errorReport });
    }
    if (body?.imports) {
      // Recent OF24 imports from ANY source (PIM, portal, feeds) — shows who
      // else is writing to the offers.
      const r = await fetch(`https://marketplace.bestbuy.ca/api/offers/imports?max=${Number(body.imports) || 25}&sort=date_created&order=desc`, {
        headers: { Authorization: apiKey, Accept: "application/json" },
      });
      return json({ ok: r.ok, status: r.status, raw: await r.json().catch(() => null) });
    }
    if (body?.offerId) {
      const r = await fetch(`https://marketplace.bestbuy.ca/api/offers/${encodeURIComponent(String(body.offerId))}`, {
        headers: { Authorization: apiKey, Accept: "application/json" },
      });
      return json({ ok: r.ok, status: r.status, raw: await r.json().catch(() => null) });
    }
    if (body?.sku) {
      const r = await fetch(
        `https://marketplace.bestbuy.ca/api/offers?sku=${encodeURIComponent(String(body.sku))}&max=5`,
        { headers: { Authorization: apiKey, Accept: "application/json" } },
      );
      return json({ ok: r.ok, status: r.status, raw: await r.json().catch(() => null) });
    }
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }

  try {
    const offers: Array<{
      sku: string; price: number | null; quantity: number; active: boolean; state: string;
      discount_price: number | null; discount_start: string | null; discount_end: string | null;
      origin_price: number | null;
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
          // Scheduled / active discount (Mirakl OF21 `discount` object). The
          // monthly promo is pushed as exactly this, so the alignment can only
          // see a promo when these fields ride along.
          discount_price: o.discount?.discount_price ?? null,
          discount_start: o.discount?.start_date ?? null,
          discount_end: o.discount?.end_date ?? null,
          origin_price: o.discount?.origin_price ?? null,
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
