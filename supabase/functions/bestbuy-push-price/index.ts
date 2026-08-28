// Push offer PRICES to Best Buy (Mirakl OF24) — the price-only counterpart
// of wix-push-product, built after the no-price-push rule was lifted
// 2026-08-16. Never touches content, stock, or state: each update carries
// only price and/or the scheduled discount fields.
//
// Body: {
//   updates: [{
//     sku: string,                  // Mirakl shop_sku
//     price?: number,               // regular selling price (the MAP)
//     discount_price?: number,      // promo price (scheduled discount)
//     discount_start_date?: string, // ISO date — promo month start
//     discount_end_date?: string,   // ISO date — promo month end
//   }],
//   dryRun?: boolean, // true → return the exact Mirakl payload, POST nothing
// }
//
// Mirakl runs OF24 in NORMAL mode (import_mode in the JSON body is ignored on
// this instance): fields missing from a line are BLANKED. On 2026-08-28 a
// price-only push zeroed the stock of 127 live offers. Every line is therefore
// merged with the live offer (quantity, price, discount) before submission.
//
// Mirakl's OF24 import is asynchronous: the POST returns an import id and the
// lines process server-side. This function polls the import status for up to
// ~40s and reports lines_in_error plus the error report when something is
// rejected — a push that silently half-applies is worse than a failed one.
//
// Caller must be an authenticated admin or editor.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MIRAKL_BASE = "https://marketplace.bestbuy.ca";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface PriceUpdate {
  sku: string;
  price?: number;
  discount_price?: number;
  discount_start_date?: string;
  discount_end_date?: string;
  quantity?: number; // only for stock RESTORES — never sent by the price flows
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function buildOfferLine(u: PriceUpdate): Record<string, unknown> | string {
  if (typeof u.sku !== "string" || !u.sku.trim()) return "missing sku";
  const line: Record<string, unknown> = {
    shop_sku: u.sku.trim(),
    update_delete: "update",
  };
  const hasPrice = typeof u.price === "number" && Number.isFinite(u.price) && u.price > 0;
  const hasDiscount = typeof u.discount_price === "number" &&
    Number.isFinite(u.discount_price) && u.discount_price > 0;
  const hasQty = typeof u.quantity === "number" && Number.isInteger(u.quantity) && u.quantity >= 0;
  if (!hasPrice && !hasDiscount && !hasQty) return `${u.sku}: nothing to update (no price, no discount, no quantity)`;
  if (hasPrice) line.price = u.price;
  if (hasQty) line.quantity = u.quantity;
  if (hasDiscount) {
    for (const dte of [u.discount_start_date, u.discount_end_date]) {
      if (dte != null && !ISO_DATE.test(dte)) return `${u.sku}: discount dates must be YYYY-MM-DD`;
    }
    // A discount above the selling price would be ignored or rejected — catch
    // the modeling mistake here instead of in Mirakl's error report.
    if (hasPrice && (u.discount_price as number) >= (u.price as number)) {
      return `${u.sku}: discount_price (${u.discount_price}) must be below price (${u.price})`;
    }
    // Best Buy's Mirakl runs volume pricing: a discount is stored as ranges
    // ({price, quantity_threshold}) and a bare discount_price is silently
    // ignored (verified 2026-08-28). Send both — ranges carry the value.
    line.discount_price = u.discount_price;
    line.discount_ranges = [{ price: u.discount_price, quantity_threshold: 1 }];
    if (u.discount_start_date) line.discount_start_date = u.discount_start_date;
    if (u.discount_end_date) line.discount_end_date = u.discount_end_date;
  }
  return line;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const API_KEY = Deno.env.get("BESTBUY_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    if (!API_KEY) return json({ error: "BESTBUY_API_KEY secret is not set." }, 500);

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
      return json({ error: "Only admins and editors can push prices." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const updates: PriceUpdate[] = Array.isArray(body.updates) ? body.updates : [];
    const dryRun = body.dryRun === true;
    if (!updates.length) return json({ error: "updates[] is required." }, 400);
    if (updates.length > 500) return json({ error: "Too many updates in one push (max 500)." }, 400);

    // --- merge the LIVE offer into each line -------------------------------
    // Mirakl processes OF24 in NORMAL mode (it ignores import_mode in the JSON
    // body): every field missing from a line is BLANKED on the offer. On
    // 2026-08-28 a price-only push zeroed the stock of 127 live offers. So each
    // line carries the offer's current quantity, price and discount unless the
    // caller sets them explicitly.
    const live = new Map<string, { price: number | null; quantity: number; discount: Record<string, unknown> | null }>();
    const wanted = new Set(updates.map((u) => String(u.sku).trim()));
    let offset = 0;
    for (;;) {
      const res = await fetch(`${MIRAKL_BASE}/api/offers?max=100&offset=${offset}`, {
        headers: { Authorization: API_KEY, Accept: "application/json" },
      });
      if (!res.ok) return json({ error: `Could not read live offers before pushing (Mirakl ${res.status}) — nothing was sent.` }, 502);
      const data = await res.json();
      for (const o of data.offers ?? []) {
        if (wanted.has(o.shop_sku)) {
          live.set(o.shop_sku, { price: o.price ?? null, quantity: o.quantity ?? 0, discount: o.discount ?? null });
        }
      }
      offset += 100;
      if (!data.offers?.length || offset >= (data.total_count ?? 0)) break;
    }
    const isoDate = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);
    const merged: PriceUpdate[] = updates.map((u) => {
      const cur = live.get(String(u.sku).trim());
      if (!cur) return u; // unknown at Best Buy — Mirakl will report the line
      const out: PriceUpdate = { ...u };
      if (typeof out.quantity !== "number") out.quantity = cur.quantity;
      if (typeof out.price !== "number" && cur.price != null) out.price = cur.price;
      const d = cur.discount;
      if (typeof out.discount_price !== "number" && d && typeof d.discount_price === "number") {
        out.discount_price = d.discount_price as number;
        out.discount_start_date = isoDate(d.start_date);
        out.discount_end_date = isoDate(d.end_date);
      }
      return out;
    });

    const offers: Record<string, unknown>[] = [];
    const invalid: string[] = [];
    for (const u of merged) {
      const line = buildOfferLine(u);
      if (typeof line === "string") invalid.push(line);
      else offers.push(line);
    }
    if (invalid.length) {
      return json({ error: `Invalid updates: ${invalid.join("; ")}` }, 400);
    }

    if (dryRun) {
      return json({ ok: true, dryRun: true, count: offers.length, payload: { import_mode: "PARTIAL_UPDATE", offers } });
    }

    // --- submit the OF24 import --------------------------------------------
    const submit = await fetch(`${MIRAKL_BASE}/api/offers`, {
      method: "POST",
      headers: { Authorization: API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ import_mode: "PARTIAL_UPDATE", offers }),
    });
    const submitBody = await submit.json().catch(() => ({}));
    if (!submit.ok) {
      return json({ error: `Mirakl OF24 ${submit.status}: ${JSON.stringify(submitBody).slice(0, 300)}` }, 502);
    }
    const importId = submitBody.import_id;
    if (!importId) {
      return json({ error: `Mirakl accepted the push but returned no import id: ${JSON.stringify(submitBody).slice(0, 200)}` }, 502);
    }

    // --- poll the async import so the caller learns the real outcome --------
    let status = "WAITING";
    let linesRead = 0;
    let linesInError = 0;
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const chk = await fetch(`${MIRAKL_BASE}/api/offers/imports/${importId}`, {
        headers: { Authorization: API_KEY, Accept: "application/json" },
      });
      if (!chk.ok) continue;
      const st = await chk.json();
      status = String(st.status ?? status);
      linesRead = st.lines_read ?? linesRead;
      linesInError = st.lines_in_error ?? linesInError;
      if (status === "COMPLETE" || status === "FAILED") break;
    }

    let errorReport: string | null = null;
    if (linesInError > 0) {
      const rep = await fetch(`${MIRAKL_BASE}/api/offers/imports/${importId}/error_report`, {
        headers: { Authorization: API_KEY },
      });
      if (rep.ok) errorReport = (await rep.text()).slice(0, 1500);
    }

    return json({
      ok: linesInError === 0 && status !== "FAILED",
      import_id: importId,
      status,
      pushed: offers.length,
      lines_read: linesRead,
      lines_in_error: linesInError,
      error_report: errorReport,
      still_processing: status !== "COMPLETE" && status !== "FAILED",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[bestbuy-push-price] FAILED:", message);
    return json({ error: message }, 500);
  }
});
