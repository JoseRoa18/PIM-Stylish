// A product that is not on Best Buy Canada yet (user, 2026-11-06: "necesitamos
// crear productos desde 0 y actualizarlos también"). Listing it takes two
// things on Best Buy: the product in its catalog and our offer on it. Best Buy
// takes no offer until the product exists, so the two can't go at the same moment.
//
// A PERSON CHOOSES (user, the same day: "yo elijo qué oferta crear"; "¿se le puede
// agregar el offer de una vez?"): a product and its offer go only for a product a
// person sent. The only thing that goes by itself is the offer a person asked for
// with the product (offer_wanted), at the first `check` after Best Buy approves it:
// the hourly cron (user's OK, 2026-11-06) or an editor opening its card or the list.
//
//   create — the product, through the content import (P41, the row the page built
//            with lib/bestbuyContent.js), for Best Buy's review; `offer: true` asks
//            for its offer once approved. Refused when Best Buy already has the UPC.
//   offer  — the offer now: MAP Blue and warranty 0 (_shared/bestbuyOffer.js).
//            Refused until the UPC is in Best Buy's catalog, or when that listing
//            plainly is another kind of product (D-701N2, a drain, is a faucet
//            combo there): the UPC has to be sorted out first (UPCs are hands off).
//   want_offer — a product in review: ask for its offer, or stop asking.
//   lookup, candidates — read only.
//   check  — follows the listings under way: the review's and the offer's outcome,
//            and sends the offer that was asked for once Best Buy approves.
//
// Caller: a signed-in user or the service-role key (lookup, candidates); an admin
// or editor (create, offer, want_offer, check); the cron's secret (check only).
// create, offer and want_offer refuse a script's key, and check sends no offer on
// the service-role key: they are a person's or the cron's.
// State: bestbuy_new_listings. Secrets: BESTBUY_API_KEY, CRON_SECRET.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isServiceRole } from "../_shared/serviceRole.ts";
import { isExcluded } from "../_shared/exclusions.ts";
import { refusals, submitContentImport } from "../_shared/bestbuyContentImport.ts";
import { catalogMismatch, offerLine, offerPlan, upcType } from "../_shared/bestbuyOffer.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const BASE = "https://marketplace.bestbuy.ca/api";
const PRODUCT_COLUMNS = "sku, brand, model_name, category, map_cad, attributes, channel_exclusions";
const READ_ONLY = ["lookup", "candidates"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const KEY = Deno.env.get("BESTBUY_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    if (!KEY) return json({ error: "BESTBUY_API_KEY secret is not set." }, 500);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // --- caller ---------------------------------------------------------------
    const body = await req.json().catch(() => ({}));
    const mode = String(body.mode ?? "lookup");
    const cronSecret = Deno.env.get("CRON_SECRET");
    const viaCron = Boolean(cronSecret && req.headers.get("x-cron-secret") === cronSecret);
    if (viaCron && mode !== "check") return json({ error: "The cron only checks." }, 403);
    let caller: { id: string | null; email: string | null } = { id: null, email: viaCron ? "cron" : "service role" };
    if (!viaCron) {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!token) return json({ error: "Missing Authorization header." }, 401);
      if (!(await isServiceRole(SUPABASE_URL, token, SERVICE_ROLE))) {
        const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
        const { data: { user } } = await callerClient.auth.getUser();
        if (!user) return json({ error: "Invalid or expired session." }, 401);
        const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
        if (!READ_ONLY.includes(mode) && !["admin", "editor"].includes(profile?.role ?? "")) return json({ error: "Only admins and editors can list products on Best Buy." }, 403);
        caller = { id: user.id, email: user.email ?? null };
      }
    }
    // What a person chooses is a person's click, never a script's key.
    if (["create", "offer", "want_offer"].includes(mode) && !caller.id) return json({ error: "Only a signed-in person can list a product on Best Buy." }, 403);

    // --- Best Buy and the PIM -------------------------------------------------
    const mirakl = (path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, { ...init, headers: { Authorization: KEY, Accept: "application/json", ...(init.headers ?? {}) } });
    // Best Buy answers 429 to a few reads in a row (seen on /offers, 2026-11-06): wait as it says, a few times.
    const read = async (path: string) => {
      for (let attempt = 0; ; attempt++) {
        const res = await mirakl(path);
        if (res.status === 429 && attempt < 3) {
          const asked = Number(res.headers.get("retry-after"));
          await new Promise((r) => setTimeout(r, (asked > 0 ? Math.min(asked, 10) : 2 + attempt * 2) * 1000));
          continue;
        }
        if (res.status === 429) throw new Error("Best Buy is limiting requests right now. Try again in a minute.");
        if (!res.ok) throw new Error(`Best Buy answered ${res.status} to ${path.split("?")[0]}: ${(await res.text()).slice(0, 200)}`);
        return res.json();
      }
    };
    const liveOffer = async (sku: string) => ((await read(`/offers?sku=${encodeURIComponent(sku)}&max=5`)).offers ?? []).find((o: { shop_sku?: string }) => o.shop_sku === sku) ?? null;
    const inCatalog = async (upc: string, type: string) => ((await read(`/products?product_references=${encodeURIComponent(`${type}|${upc}`)}`)).products ?? []).find((p: { product_id?: string }) => String(p.product_id) === upc) ?? null;
    const loadProduct = async (sku: string) => {
      const { data, error } = await admin.from("products").select(PRODUCT_COLUMNS).eq("sku", sku).maybeSingle();
      if (error) throw error;
      return data;
    };
    const log = (sku: string, summary: string, metadata: Record<string, unknown>) => admin.from("audit_log").insert({
      actor_id: caller.id, actor_email: caller.email, actor_name: caller.id ? null : "PIM automation",
      action: "push", entity_type: "product", entity_id: sku, target: "marketplace.bestbuy.ca", summary, metadata,
    });
    // A row's first save carries the upc and via the table requires. Any later
    // save is an UPDATE: an upsert of only the changed fields fails those NOT
    // NULL checks even when the row exists, and that error went unread, so the
    // status never moved and `check` sent the same offers every hour (60 times
    // each, 2026-11-06 to 11-09).
    const save = async (sku: string, fields: Record<string, unknown>) => {
      const row = { checked_at: new Date().toISOString(), ...fields };
      const table = admin.from("bestbuy_new_listings");
      const { error } = "upc" in fields && "via" in fields
        ? await table.upsert({ sku, ...row }, { onConflict: "sku" })
        : await table.update(row).eq("sku", sku);
      if (error) throw new Error(`Could not save ${sku}: ${error.message}`);
    };
    const catalogInfo = (l: Record<string, any> | null) => (l ? { bb_product_id: l.product_sku ?? null, title: l.product_title ?? null, category_code: l.category_code ?? null, category_label: l.category_label ?? null } : null);
    // The same shape as an offer of the channel_health snapshot.
    const offerShape = (o: Record<string, any>) => ({
      sku: o.shop_sku, upc: o.product_references?.[0]?.reference ?? null, price: o.price ?? null, discount_price: o.discount?.discount_price ?? null,
      quantity: o.quantity ?? null, active: o.active ?? null, category_code: o.category_code ?? null, category_label: o.category_label ?? null,
      product_brand: o.product_brand ?? null, product_title: o.product_title ?? null, bb_product_id: o.product_sku ?? null,
    });
    const sendOffer = async (sku: string, plan: ReturnType<typeof offerPlan>) => {
      const res = await mirakl("/offers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ import_mode: "PARTIAL_UPDATE", offers: [offerLine(sku, plan)] }) });
      const answer = await res.json().catch(() => ({}));
      if (!res.ok || !answer.import_id) throw new Error(`Best Buy refused the offer (${res.status}): ${JSON.stringify(answer).slice(0, 300)}`);
      return String(answer.import_id);
    };

    // --- lookup ---------------------------------------------------------------
    if (mode === "lookup") {
      const sku = String(body.sku ?? "").trim();
      const product = sku ? await loadProduct(sku) : null;
      if (!product) return json({ error: `${sku || "That product"} is not in the PIM.` }, 404);
      const plan = offerPlan(product);
      const offer = await liveOffer(sku);
      const listing = plan.upc && plan.upcType && !offer ? await inCatalog(plan.upc, plan.upcType) : null;
      return json({ ok: true, offer: offer ? offerShape(offer) : null, catalog: catalogInfo(listing), mismatch: listing ? catalogMismatch(product, listing.product_title) : false, plan });
    }

    // --- candidates -----------------------------------------------------------
    if (mode === "candidates") {
      // The offers from the latest snapshot (twice a day): paging Best Buy's /offers
      // on every visit runs into its 429. An offer newer than it is a listing marked live below.
      const { data: snaps, error: snapErr } = await admin.from("channel_health").select("results").eq("channel", "bestbuy").order("run_at", { ascending: false }).limit(1);
      if (snapErr) throw snapErr;
      const offered = new Set<string>((snaps?.[0]?.results ?? []).map((o: { sku?: string }) => String(o.sku)));
      const products: Record<string, any>[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await admin.from("products").select(PRODUCT_COLUMNS).order("sku").range(from, from + 999);
        if (error) throw error;
        products.push(...(data ?? []));
        if ((data ?? []).length < 1000) break;
      }
      const { data: rows, error: rowsErr } = await admin.from("bestbuy_new_listings").select("sku, status, note, offer_wanted");
      if (rowsErr) throw rowsErr;
      const listings = new Map((rows ?? []).map((r) => [r.sku, r]));
      for (const r of rows ?? []) if (r.status === "live") offered.add(r.sku);
      const missing = products.filter((p) => !offered.has(p.sku) && !isExcluded(p, "bestbuy"));
      const { data: inv, error: invErr } = await admin.from("product_inventory").select("sku, available").eq("market", "ca").range(0, 4999);
      if (invErr) throw invErr;
      const stock = new Map((inv ?? []).map((i) => [i.sku, Number(i.available) || 0]));
      const plans = missing.map((p) => ({ p, plan: offerPlan(p) }));
      const found = new Map<string, Record<string, any>>();
      const byType = new Map<string, string[]>();
      for (const { plan } of plans) {
        if (plan.upc && plan.upcType) byType.set(plan.upcType, [...(byType.get(plan.upcType) ?? []), plan.upc]);
      }
      for (const [type, upcs] of byType) {
        for (let i = 0; i < upcs.length; i += 50) {
          const refs = upcs.slice(i, i + 50).map((u) => encodeURIComponent(`${type}|${u}`)).join(",");
          for (const x of (await read(`/products?product_references=${refs}&max=100`)).products ?? []) found.set(String(x.product_id), x);
        }
      }
      return json({
        ok: true,
        candidates: plans.map(({ p, plan }) => {
          const l = plan.upc ? found.get(plan.upc) ?? null : null;
          return {
            sku: p.sku, model: p.model_name ?? null, category: p.category ?? null, price: plan.price, quantity: stock.get(p.sku) ?? 0, problems: plan.problems,
            tracked: stock.has(p.sku), catalog: catalogInfo(l), mismatch: l ? catalogMismatch(p, l.product_title) : false, listing: listings.get(p.sku) ?? null,
          };
        }),
      });
    }

    // --- create: the product --------------------------------------------------
    if (mode === "create") {
      const sku = String(body.sku ?? "").trim();
      const product = sku ? await loadProduct(sku) : null;
      if (!product) return json({ error: `${sku || "That product"} is not in the PIM.` }, 404);
      if (isExcluded(product, "bestbuy")) return json({ error: `${sku} is excluded from Best Buy Canada.` }, 409);
      const { data: open } = await admin.from("bestbuy_new_listings").select("status").eq("sku", sku).maybeSingle();
      if (open?.status === "in_review") return json({ error: `${sku} is already in Best Buy's review.` }, 409);
      if (await liveOffer(sku)) return json({ error: `${sku} already has an offer on Best Buy: push it to update it.` }, 409);
      const upc = String(product.attributes?.upc ?? "").trim();
      const type = upcType(upc);
      if (!type) return json({ error: `${sku} needs a UPC of 12 or 13 digits in the PIM.` }, 400);
      if (await inCatalog(upc, type)) return json({ error: `Best Buy already has the UPC ${upc}: only the offer is missing.` }, 409);
      const row = body.row as Record<string, string> | undefined;
      const categoryCode = String(row?.BBYCat ?? "");
      if (!row || row.shop_sku !== sku || !categoryCode) return json({ error: "The product's content row is missing or is not this product's." }, 400);
      const banned = Object.keys(row).filter((k) => /price|quantity/i.test(k));
      if (banned.length) return json({ error: `${banned.join(", ")} not allowed: prices and stock belong to the offer.` }, 400);
      const wanted = body.offer === true;
      const sent = await submitContentImport(KEY, [row]);
      const requested = { upc, category_code: categoryCode, via: "content", content_import_id: sent.import_id, offer_import_id: null, offer_wanted: wanted, requested_by: caller.id, requested_at: new Date().toISOString(), offer_sent_at: null, live_at: null };
      if (sent.lines_error > 0) {
        const note = sent.transformation_errors ?? `Refused (import ${sent.import_id})`;
        await save(sku, { ...requested, status: "refused", note });
        return json({ ok: false, status: "refused", import_id: sent.import_id, note });
      }
      await save(sku, { ...requested, status: "in_review", note: null });
      await log(sku, `Sent ${sku} to Best Buy as a new product (import ${sent.import_id}, ${categoryCode})${wanted ? ", its offer to go once approved" : ""} — accepted as the PIM recommends`, { imports: [sent.import_id], category_code: categoryCode, offer_wanted: wanted });
      return json({ ok: true, status: "in_review", import_id: sent.import_id, offer_wanted: wanted });
    }

    // --- want_offer: a product in review --------------------------------------
    if (mode === "want_offer") {
      const sku = String(body.sku ?? "").trim();
      const want = body.want === true;
      const { data: row } = await admin.from("bestbuy_new_listings").select("status").eq("sku", sku).maybeSingle();
      if (row?.status !== "in_review") return json({ error: `${sku} is not in Best Buy's review.` }, 409);
      await save(sku, { offer_wanted: want });
      await log(sku, want ? `${sku}: its offer will go once Best Buy approves it` : `${sku}: its offer will not go by itself`, { offer_wanted: want });
      return json({ ok: true, offer_wanted: want });
    }

    // --- offer: now, a person's click ------------------------------------------
    if (mode === "offer") {
      const sku = String(body.sku ?? "").trim();
      const product = sku ? await loadProduct(sku) : null;
      if (!product) return json({ error: `${sku || "That product"} is not in the PIM.` }, 404);
      if (isExcluded(product, "bestbuy")) return json({ error: `${sku} is excluded from Best Buy Canada.` }, 409);
      if (await liveOffer(sku)) return json({ error: `${sku} already has an offer on Best Buy.` }, 409);
      const plan = offerPlan(product);
      if (plan.problems.length) return json({ error: `The offer can't go: ${plan.problems.join("; ")}.` }, 400);
      const listing = await inCatalog(plan.upc!, plan.upcType!);
      if (!listing) return json({ error: `Best Buy does not have the UPC ${plan.upc} yet: the product has to be created and approved first.` }, 409);
      if (catalogMismatch(product, listing.product_title)) {
        return json({ error: `Best Buy has the UPC ${plan.upc} as another product: "${listing.product_title}". Nothing was sent; the UPC has to be sorted out first.` }, 409);
      }
      const importId = await sendOffer(sku, plan);
      const { data: earlier } = await admin.from("bestbuy_new_listings").select("via, content_import_id").eq("sku", sku).maybeSingle();
      await save(sku, {
        upc: plan.upc, category_code: listing.category_code ?? null, via: earlier?.via ?? "catalog", content_import_id: earlier?.content_import_id ?? null, status: "offer_sent", note: null,
        offer_import_id: importId, bb_product_id: listing.product_sku ?? null, requested_by: caller.id, requested_at: new Date().toISOString(), offer_sent_at: new Date().toISOString(), live_at: null,
      });
      await log(sku, `Created the offer of ${sku} on Best Buy (import ${importId}): MAP Blue C$${Number(plan.price).toFixed(2)}, warranty 0`, { offer_import: importId, price: plan.price, bb_product_id: listing.product_sku ?? null });
      return json({ ok: true, status: "offer_sent", import_id: importId });
    }

    // --- check ----------------------------------------------------------------
    if (mode === "check") {
      let query = admin.from("bestbuy_new_listings").select("*").in("status", ["in_review", "offer_sent"]);
      if (body.sku) query = query.eq("sku", String(body.sku));
      const { data: rows, error } = await query.limit(40);
      if (error) throw error;
      const results: Record<string, unknown>[] = [];
      for (const r of rows ?? []) {
        try {
          if (r.status === "in_review") {
            const listing = await inCatalog(r.upc, upcType(r.upc) ?? "UPC-A");
            if (listing) {
              // No offer asked for, or a script's key: Best Buy approved it, nothing more.
              if (!r.offer_wanted || !(caller.id || viaCron)) {
                if (!r.offer_wanted) await save(r.sku, { status: "approved", note: null, bb_product_id: listing.product_sku ?? null });
                results.push({ sku: r.sku, status: "approved" });
                continue;
              }
              // The offer the person asked for with the product: read again now,
              // so a price changed or a switch turned off during the review counts.
              const product = await loadProduct(r.sku);
              const plan = product ? offerPlan(product) : null;
              const stop = !product || isExcluded(product, "bestbuy") ? "It was switched off for Best Buy during the review, so the offer did not go."
                : plan!.problems.length ? `Best Buy approved it, but the offer can't go: ${plan!.problems.join("; ")}.`
                  : catalogMismatch(product, listing.product_title) ? `Best Buy has the UPC ${r.upc} as another product: "${listing.product_title}". The offer did not go.` : null;
              if (stop) {
                await save(r.sku, { status: "approved", note: stop, bb_product_id: listing.product_sku ?? null });
                results.push({ sku: r.sku, status: "approved", note: stop });
                continue;
              }
              const importId = await sendOffer(r.sku, plan!);
              await save(r.sku, { status: "offer_sent", note: null, offer_import_id: importId, bb_product_id: listing.product_sku ?? null, offer_sent_at: new Date().toISOString() });
              await log(r.sku, `Best Buy approved ${r.sku}: the offer asked for with it went (import ${importId}), MAP Blue C$${Number(plan!.price).toFixed(2)}, warranty 0`, { offer_import: importId, price: plan!.price, bb_product_id: listing.product_sku ?? null });
              results.push({ sku: r.sku, status: "offer_sent", import_id: importId });
              continue;
            }
            const st = await read(`/products/imports/${r.content_import_id}`);
            const d = st.integration_details ?? {};
            const notTaken = Number(d.invalid_products ?? 0) + Number(d.rejected_products ?? 0) + Number(d.products_not_accepted ?? 0) + Number(d.products_with_wrong_identifiers ?? 0);
            if (String(st.import_status) === "FAILED" || notTaken > 0) {
              let note = `Best Buy did not take it (import ${r.content_import_id}, ${st.import_status}).`;
              if (st.has_error_report) {
                const rep = await mirakl(`/products/imports/${r.content_import_id}/error_report`);
                if (rep.ok) note = refusals(await rep.text());
              }
              await save(r.sku, { status: "refused", note });
              results.push({ sku: r.sku, status: "refused", note });
              continue;
            }
            await save(r.sku, {});
            results.push({ sku: r.sku, status: "in_review", import: st.import_status });
            continue;
          }
          const st = await read(`/offers/imports/${r.offer_import_id}`);
          if (Number(st.lines_in_error ?? 0) > 0) {
            let note = `Best Buy refused the offer (import ${r.offer_import_id}).`;
            const rep = await mirakl(`/offers/imports/${r.offer_import_id}/error_report`);
            if (rep.ok) note = refusals(await rep.text());
            await save(r.sku, { status: "failed", note });
            results.push({ sku: r.sku, status: "failed", note });
            continue;
          }
          const offer = await liveOffer(r.sku);
          if (offer) {
            await save(r.sku, { status: "live", note: null, bb_product_id: offer.product_sku ?? r.bb_product_id, live_at: new Date().toISOString() });
            results.push({ sku: r.sku, status: "live" });
          } else {
            await save(r.sku, {});
            results.push({ sku: r.sku, status: "offer_sent", import: st.status });
          }
        } catch (err) {
          results.push({ sku: r.sku, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return json({ ok: true, checked: results.length, results });
    }

    return json({ error: `Unknown mode "${mode}".` }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[bestbuy-new-listing] FAILED:", message);
    return json({ error: message }, 500);
  }
});
