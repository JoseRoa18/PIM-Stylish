// Stylish PIM → Walmart US: create NEW items from PIM data (feed MP_ITEM,
// item spec 5.0). Sandbox by default; production only with an explicit
// confirmation, and never from anywhere but this function.
//
// How it works:
//   1. Reads the products (+ media) from the PIM and maps each one to its
//      Walmart product type. Only the types with agreed rules are built
//      (Sinks today); the rest are reported as "mapping not defined".
//   2. mode "preview" returns, per SKU, every field that would be sent
//      (Walmart's field name, section, value), the missing required fields
//      and the warnings — nothing is sent.
//   3. mode "preview" with validate=true also checks every built item against
//      Walmart's OFFICIAL item spec (JSON Schema, read live from the Get Spec
//      API) — the same rules Walmart applies on ingestion — without sending.
//      (Walmart's sandbox cannot receive feeds: /v3/feeds answers 520 there.)
//   4. mode "submit" posts the MP_ITEM feed (multipart, as documented).
//      sandbox=true targets sandbox.walmartapis.com; production needs
//      sandbox=false AND confirm="CREATE".
//   5. mode "status" reads a feed's per-item outcome (feedId).
//   6. mode "spec" returns Walmart's official MP_ITEM JSON Schema for the
//      product types asked (default Sinks) — read-only, to audit which fields
//      Walmart asks for against what the PIM fills.
//   7. mode "account" (read-only, production) returns the account's ship nodes
//      (the fulfillmentCenterID inventory needs), partner profile and item count.
//   8. mode "get" (read-only, production): one GET on an allowed Walmart path
//      (catalog search, items, feeds, taxonomy, settings) — for diagnosing item setup.
//
// Body: {
//   mode?: "preview" | "submit" | "status" | "spec", default preview
//   skus?: string[],                           preview / submit
//   validate?: boolean,                        preview: check against the official spec
//   sandbox?: boolean,                         default true
//   confirm?: "CREATE",                        submit to production only
//   feedId?: string,                           status
//   productTypes?: string[],                   spec (default ["Sinks"])
//   trim?: "required",                         preview / submit: only the spec's required fields
//   setup?: "match",                           preview / submit: an OFFER on the listing Walmart
//                                              already has for the UPC (feed MP_ITEM_MATCH, any
//                                              category) instead of a new item — see buildMatch
//   path?: string,                             get: the Walmart GET path
// }
// Caller: authenticated admin/editor.
// Secrets: WALMART_US_PROD_CLIENT_ID/SECRET, WALMART_US_SANDBOX_CLIENT_ID/SECRET.
//
// Media: the item spec carries the main image and secondary images (URLs).
// It has NO field for videos or PDF documents — those are not part of item
// setup on Walmart (only children's-product certificate references).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import Ajv from "https://esm.sh/ajv@8.17.1";
import { isExcluded, excludedMessage } from "../_shared/exclusions.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SPEC_VERSION = "5.0.20260803-17_50_56-api";
const WARRANTY_URL_US = "https://www.stylishkbusa.com/warranty";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function wmHeaders(extra: Record<string, string>) {
  return { "WM_SVC.NAME": "Walmart Marketplace", "WM_QOS.CORRELATION_ID": crypto.randomUUID(), "Accept": "application/json", "WM_MARKET": "us", ...extra };
}
async function getToken(base: string, cid: string, sec: string): Promise<string> {
  const res = await fetch(`${base}/v3/token`, {
    method: "POST",
    headers: wmHeaders({ Authorization: `Basic ${btoa(`${cid}:${sec}`)}`, "Content-Type": "application/x-www-form-urlencoded" }),
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Walmart token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

// ---------------------------------------------------------------- PIM helpers
type Product = Record<string, unknown> & { sku: string; attributes?: Record<string, unknown> | null };
type MediaRow = { sku: string; storage_path: string; media_type: string; is_primary: boolean; display_order: number | null; image_role: string | null; language?: string | null };

const attr = (p: Product) => (p.attributes ?? {}) as Record<string, unknown>;
const text = (v: unknown) => (v == null ? "" : String(v).trim());
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(text).filter(Boolean) : text(v) ? text(v).split(/;|\n/).map((s) => s.trim()).filter(Boolean) : [];
const stripHtml = (s: unknown) => text(s).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const yes = (v: unknown) => /^(true|yes|1)$/i.test(text(v));
// A number with at most 2 decimals, as Walmart wants (no "31.000").
const money = (v: unknown) => { const n = num(v); return n == null ? null : Math.round(n * 100) / 100; };
const inches = (v: unknown) => { const n = num(v); return n == null ? null : Math.round(n * 1000) / 1000; };
// "30 inch x 18 inch x 10 inch" — the external size, as the user asked.
const fmtIn = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

const SINK_CATS = new Set(["kitchen_sink", "bathroom_sink", "bar_prep_sink", "outdoor_sink", "laundry_sink"]);
function productTypeFor(p: Product): string | null {
  const c = text(p.category);
  if (SINK_CATS.has(c)) return "Sinks";
  return null; // Faucets and accessories: rules not agreed yet
}

// Walmart's 18 colour categories. Rules agreed 2026-09-22.
function colorCategory(p: Product): string[] {
  const material = text(p.material).toLowerCase();
  const finish = text(p.finish).toLowerCase();
  const colour = text(p.color).toLowerCase();
  const pick = (s: string) => {
    if (/black|graphite|noir/.test(s)) return "Black";
    if (/gray|grey/.test(s)) return "Gray";
    if (/white|blanc/.test(s)) return "White";
    if (/beige|sand|cream/.test(s)) return "Beige";
    if (/brown|espresso|walnut/.test(s)) return "Brown";
    if (/gold|brass/.test(s)) return "Gold";
    if (/bronze/.test(s)) return "Bronze";
    if (/blue|navy/.test(s)) return "Blue";
    if (/green/.test(s)) return "Green";
    if (/red/.test(s)) return "Red";
    return null;
  };
  if (/granite|composite|quartz|porcelain|ceramic|fireclay/.test(material)) {
    const c = pick(finish) ?? pick(colour);
    return c ? [c] : [];
  }
  // Stainless steel: black PVD finishes are Black, everything else is Silver.
  if (/stainless/.test(material)) return /black|graphite/.test(finish) ? ["Black"] : ["Silver"];
  const c = pick(finish) ?? pick(colour);
  return c ? [c] : [];
}

// Walmart's "features" (closed list). Rules agreed 2026-09-22 for Sinks:
// Sound Dampening on every stainless sink, Workstation when it is one,
// Easy to Clean / Easy To Install / Hardware Included on all.
function sinkFeatures(p: Product): string[] {
  const out: string[] = [];
  if (/stainless/i.test(text(p.material))) out.push("Sound Dampening");
  if (yes(attr(p).has_workstation) || /workstation/i.test(text(attr(p).general_title_en))) out.push("Workstation");
  out.push("Easy to Clean", "Easy To Install", "Hardware Included");
  return out;
}

// The PIM's installation type: "Undermount", "Dual Mount", "Top Mount", "Drop-In".
const installation = (p: Product) => (text(p.installation_type) || text(attr(p).installation_type)).toLowerCase();

// sink_type (multi-value): the bowl configuration (user rule: single → Single
// Basin Sink, double → Double Bowl Sink) PLUS the installation (Undermount Sink /
// Drop-In Sink; Dual Mount = both, since it installs either way). Farmhouse /
// drainboard / corner add their own.
function sinkType(p: Product): string[] {
  const cfg = `${text(p.bowl_configuration)} ${text(attr(p).bowl_configuration)}`.toLowerCase();
  const bowls = num(p.number_of_bowls) ?? num(attr(p).number_of_bowls);
  const inst = `${installation(p)} ${text(attr(p).general_title_en)}`.toLowerCase();
  const out: string[] = [];
  if (/double|2 bowl|60\/40|50\/50|70\/30/.test(cfg) || bowls === 2) out.push("Double Bowl Sink");
  else if (/single|1 bowl/.test(cfg) || bowls === 1) out.push("Single Basin Sink");
  const how = installation(p);
  if (/dual/.test(how)) out.push("Undermount Sink", "Drop-In Sink");
  else if (/under/.test(how)) out.push("Undermount Sink");
  else if (/drop|top/.test(how)) out.push("Drop-In Sink");
  if (/farmhouse|apron/.test(inst)) out.push("Farmhouse Sink");
  if (/drainboard/.test(inst)) out.push("Drainboard Sink");
  if (/corner/.test(inst)) out.push("Corner Sink");
  if (text(p.category) === "bar_prep_sink") out.push("Island Bar Prep Sink");
  return [...new Set(out)];
}

type Row = { field: string; section: string; value: string; required?: boolean };

// The product's UPC / GTIN when it is a real one (840994000000 is the
// Excel-rounded placeholder several products carry).
function productIdOf(p: Product): { productId: string; productIdType: "UPC" | "GTIN" } | null {
  const upc = text(p.upc) || text(attr(p).upc);
  if (!/^\d{12,14}$/.test(upc) || /^0+$/.test(upc) || upc === "840994000000") return null;
  return { productId: upc, productIdType: upc.length === 12 ? "UPC" : "GTIN" };
}

// Offer setup by match (feed MP_ITEM_MATCH, spec 4.2 — Walmart's documented
// request sample, "Create an offer for an existing Walmart item"; Get Spec
// serves no schema for it). Most Stylish products already have a listing in
// Walmart's catalog without offers (from Walmart Canada, found 2026-09-28 on
// S-414T); the offer rides on that listing, Walmart keeps its content, and a
// full MP_ITEM with the same UPC fails with ERR_PDI_0001. The offer carries
// only what Walmart asks for: SKU, product id, price (MAP Blue USD), shipping
// weight, condition.
const MATCH_HEADER = { processMode: "REPLACE", subset: "EXTERNAL", locale: "en", sellingChannel: "mpsetupbymatch", version: "4.2" };
function buildMatch(p: Product) {
  const rows: Row[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  const item: Record<string, unknown> = {};
  const set = (field: string, value: unknown, shown?: string) => {
    if (value == null || value === "") { missing.push(field); return; }
    item[field] = value;
    rows.push({ field, section: "Selling", value: shown ?? (typeof value === "object" ? JSON.stringify(value) : String(value)), required: true });
  };
  set("sku", p.sku);
  const id = productIdOf(p);
  if (id) set("productIdentifiers", id, `${id.productIdType} ${id.productId}`);
  else missing.push("productIdentifiers (UPC)");
  set("price", money(p.map_usd));
  set("ShippingWeight", money(p.shipping_weight_lb));
  set("condition", "New");
  return { item: { Item: item }, rows, missing: [...new Set(missing)], warnings };
}

// Build one MPItem for a sink. Returns the item, the human-readable rows,
// the missing required fields and the warnings.
function buildSink(p: Product, media: MediaRow[], group: { id: string; primary: boolean } | null) {
  const a = attr(p);
  const rows: Row[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  const vis: Record<string, unknown> = {};
  const ord: Record<string, unknown> = {};
  const set = (target: Record<string, unknown>, field: string, value: unknown, section: string, shown?: string, required = false) => {
    const empty = value == null || value === "" || (Array.isArray(value) && !value.length);
    if (empty) { if (required) missing.push(field); return; }
    target[field] = value;
    rows.push({ field, section, value: shown ?? (Array.isArray(value) ? value.join(" | ") : typeof value === "object" ? JSON.stringify(value) : String(value)), required });
  };

  // ---- Orderable (selling data)
  set(ord, "sku", p.sku, "Selling", undefined, true);
  const id = productIdOf(p);
  if (id) set(ord, "productIdentifiers", id, "Selling", `${id.productIdType} ${id.productId}`, true);
  else missing.push("productIdentifiers (UPC)");
  set(ord, "price", money(p.map_usd), "Selling", undefined, true);
  set(ord, "ShippingWeight", money(p.shipping_weight_lb), "Selling", undefined, true);
  set(ord, "country_of_origin_substantial_transformation", text(p.country_of_origin) || "China", "Selling", undefined, true);
  set(ord, "msrp", money(p.msrp_usd), "Selling");
  set(ord, "fulfillmentLagTime", 1, "Selling");
  const box = (a.shipping_dimensions_in ?? {}) as Record<string, unknown>;
  if (num(box.length) && num(box.width) && num(box.height) && money(p.shipping_weight_lb)) {
    set(ord, "product_package_dimensions_and_weight", {
      product_package_dimensions_depth: inches(box.length), product_package_dimensions_width: inches(box.width),
      product_package_dimensions_height: inches(box.height), product_package_weight: money(p.shipping_weight_lb),
    }, "Selling", `${fmtIn(num(box.length)!)} x ${fmtIn(num(box.width)!)} x ${fmtIn(num(box.height)!)} in · ${money(p.shipping_weight_lb)} lb`);
  } else warnings.push("no shipping box dimensions — package dimensions not sent");
  set(ord, "electronicsIndicator", "No", "Selling");
  set(ord, "chemicalAerosolPesticide", "No", "Selling");
  set(ord, "batteryTechnologyType", "Does Not Contain a Battery", "Selling");
  set(ord, "shipsInOriginalPackaging", "Yes", "Selling");
  set(ord, "MustShipAlone", "No", "Selling");

  // ---- Visible: listing
  set(vis, "productName", (text(a.general_title_en) || text(p.quickbooks_description)).replace(/\s+/g, " "), "Listing", undefined, true);
  if (text(vis.productName as string).length > 199) warnings.push("product name over 199 characters");
  set(vis, "brand", text(p.brand), "Listing", undefined, true);
  set(vis, "manufacturer", text(p.manufacturer) || text(a.manufacturer) || text(p.brand), "Listing");
  set(vis, "manufacturerPartNumber", p.sku, "Listing");
  set(vis, "modelNumber", p.sku, "Listing");
  set(vis, "productLine", text(p.model_name) ? [text(p.model_name)] : [], "Listing");
  set(vis, "condition", "New", "Listing", undefined, true);
  if (group) {
    set(vis, "variantGroupId", group.id, "Listing");
    set(vis, "variantAttributeNames", ["finish"], "Listing");
    set(vis, "isPrimaryVariant", group.primary ? "Yes" : "No", "Listing");
  }

  // ---- Visible: content
  set(vis, "shortDescription", stripHtml(p.description), "Content", undefined, true);
  const bullets = listOf(p.bullet_points).length ? listOf(p.bullet_points) : listOf(a.bullet_points);
  if (bullets.length && bullets.length < 4) warnings.push(`${bullets.length} bullets — Walmart wants at least 4`);
  set(vis, "keyFeatures", bullets, "Content", bullets.join(" | "), true);

  // ---- Visible: media. White images only (the gray SinksDirect hero stays
  // off). Main = the language-neutral primary. Secondary = ONE language set,
  // the same rule the Wix US pushes use: the EN set when the product has one,
  // else the non-French artwork (EN/ES + untagged), else the EN/FR set rather
  // than no photos. Sets never mix — the EN/FR and EN/ES copies are duplicates.
  const images = media
    .filter((m) => m.media_type === "image" && /^https?:\/\//i.test(m.storage_path ?? "") && m.image_role !== "sinksdirect_main")
    .sort((x, y) => Number(y.is_primary) - Number(x.is_primary) || (x.display_order ?? 0) - (y.display_order ?? 0));
  const main = images.find((m) => m.is_primary) ?? images[0];
  set(vis, "mainImageUrl", main?.storage_path ?? "", "Media", main ? main.storage_path.split("/").pop() : undefined, true);
  const others = images.filter((m) => m !== main);
  const lang = (m: MediaRow) => (m as MediaRow & { language?: string | null }).language ?? null;
  let chosen = others.filter((m) => lang(m) === "en");
  let setName = "EN set";
  if (!chosen.length) { chosen = others.filter((m) => lang(m) !== "en_fr" && lang(m) !== "fr"); setName = "EN/ES + untagged set"; }
  if (!chosen.length) { chosen = others.filter((m) => lang(m) === "en_fr"); setName = "EN/FR set (no US artwork)"; }
  const secondary = chosen.map((m) => m.storage_path);
  if (secondary.length >= 3) set(vis, "productSecondaryImageURL", secondary, "Media", `${setName} · ${secondary.map((u) => u.split("/").pop()).join(" | ")}`);
  else if (secondary.length) warnings.push(`${secondary.length} secondary image(s) in the ${setName} — Walmart wants at least 3, none sent`);
  if (chosen.length && others.length > chosen.length) warnings.push(`${others.length - chosen.length} image(s) of the other language set not sent (sets never mix)`);

  // ---- Visible: compliance & warranty
  set(vis, "isProp65WarningRequired", "No", "Compliance", undefined, true);
  set(vis, "has_written_warranty", "Yes - Warranty Text", "Compliance", undefined, true);
  set(vis, "warrantyText", text(a.warranty_text_us), "Compliance", text(a.warranty_text_us).slice(0, 80) + (text(a.warranty_text_us).length > 80 ? "…" : ""));
  if (!text(a.warranty_text_us)) missing.push("warrantyText (Warranty Text USA)");
  set(vis, "warrantyURL", text(a.warranty_url_us) || WARRANTY_URL_US, "Compliance");
  set(vis, "netContent", { productNetContentUnit: "Each", productNetContentMeasure: 1 }, "Compliance", "1 Each", true);

  // ---- Visible: specifications
  set(vis, "material", text(p.material) ? [text(p.material)] : [], "Specifications", undefined, true);
  set(vis, "finish", text(p.finish), "Specifications");
  set(vis, "color", text(p.color) || text(p.finish), "Specifications");
  set(vis, "colorCategory", colorCategory(p), "Specifications");
  set(vis, "sink_type", sinkType(p), "Specifications", undefined, true);
  // mountType (user rule 2026-09-22): "Drop-in" only for Drop-In / Top Mount sinks;
  // Undermount and Dual Mount send nothing (Walmart's list has no such value).
  if (/drop|top/.test(installation(p))) set(vis, "mountType", ["Drop-in"], "Specifications");
  set(vis, "shape", text(p.shape) || text(a.sink_shape), "Specifications");
  const ext = (a.external_dimensions_in ?? {}) as Record<string, unknown>;
  const L = num(ext.length), W = num(ext.width), D = num(ext.depth);
  if (L && W && D) set(vis, "size", `${fmtIn(L)} inch x ${fmtIn(W)} inch x ${fmtIn(D)} inch`, "Specifications");
  else warnings.push("no external dimensions — size and assembled dimensions not sent");
  if (L) set(vis, "assembledProductLength", { unit: "in", measure: inches(L) }, "Specifications", `${fmtIn(L)} in`);
  if (W) set(vis, "assembledProductWidth", { unit: "in", measure: inches(W) }, "Specifications", `${fmtIn(W)} in`);
  if (D) set(vis, "assembledProductHeight", { unit: "in", measure: inches(D) }, "Specifications", `${fmtIn(D)} in`);
  const weight = money(p.weight_lb) ?? money(a.product_weight_lb) ?? money(a.weight_lb);
  if (weight) set(vis, "assembledProductWeight", { unit: "lb", measure: weight }, "Specifications", `${weight} lb`);
  set(vis, "features", sinkFeatures(p), "Specifications");
  const acc = listOf(p.included_components).length ? listOf(p.included_components) : listOf(a.accessories_included);
  set(vis, "accessoriesIncluded", acc, "Specifications");
  const pieces = num(a.number_of_pieces);
  if (pieces) set(vis, "pieceCount", Math.round(pieces), "Specifications");
  set(vis, "recommendedLocations", [text(p.category) === "bathroom_sink" ? "Bathroom" : "Kitchen"], "Specifications");
  set(vis, "recommendedUses", [text(p.category) === "bathroom_sink" ? "Bath" : "Kitchen Sink"], "Specifications");

  return { item: { Visible: { Sinks: vis }, Orderable: ord }, rows, missing: [...new Set(missing)], warnings };
}

// The fields the Sinks spec requires (Get Spec, 5.0.20260803): Orderable's
// `required` list and Visible.Sinks' `required` list, plus warrantyText, which
// has_written_warranty = "Yes - Warranty Text" makes conditional-required.
type MPItem = { Visible: { Sinks: Record<string, unknown> }; Orderable: Record<string, unknown> };
const REQUIRED_ORDERABLE = ["sku", "productIdentifiers", "price", "ShippingWeight", "country_of_origin_substantial_transformation"];
const REQUIRED_SINKS = ["productName", "brand", "condition", "shortDescription", "keyFeatures", "mainImageUrl", "isProp65WarningRequired", "has_written_warranty", "warrantyText", "material", "netContent", "sink_type"];
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
function trimToRequired(item: MPItem): MPItem {
  return { Visible: { Sinks: pick(item.Visible.Sinks, REQUIRED_SINKS) }, Orderable: pick(item.Orderable, REQUIRED_ORDERABLE) };
}

// ---------------------------------------------------------------- spec validation
// Walmart's Get Spec API returns the JSON Schema (draft-07) of the MP_ITEM
// feed for the requested product types. Validating locally catches what
// Walmart would reject on ingestion, without posting anything.
async function fetchSpec(base: string, wm: string, productTypes: string[], feedType = "MP_ITEM", version = SPEC_VERSION) {
  const res = await fetch(`${base}/v3/items/spec`, {
    method: "POST",
    headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": wm, "Content-Type": "application/json" }),
    body: JSON.stringify({ feedType, version, productTypes }),
  });
  if (!res.ok) throw new Error(`Walmart spec ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).schema;
}
function validateFeed(schema: unknown, feed: unknown): { valid: boolean; errors: { path: string; message: string }[] } {
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  const check = ajv.compile(schema as object);
  const valid = check(feed) as boolean;
  const errors = (check.errors ?? []).map((e: { instancePath: string; message?: string; params?: Record<string, unknown> }) => ({
    path: e.instancePath || "/",
    message: `${e.message ?? "invalid"}${e.params?.allowedValues ? ` (${(e.params.allowedValues as string[]).slice(0, 6).join(", ")}…)` : ""}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ""}`,
  }));
  return { valid, errors };
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // --- caller: admin/editor session ---------------------------------------
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Missing Authorization header." }, 401);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) return json({ error: "Invalid or expired session." }, 401);
    const { data: profile } = await admin.from("profiles").select("role").eq("id", caller.id).maybeSingle();
    if (!["admin", "editor"].includes(profile?.role ?? "")) return json({ error: "Only admins and editors can create Walmart listings." }, 403);

    const body = await req.json().catch(() => ({}));
    const mode: string = body.mode ?? "preview";
    const sandbox = body.sandbox !== false;
    const base = sandbox ? "https://sandbox.walmartapis.com" : "https://marketplace.walmartapis.com";
    const env = sandbox ? "sandbox" : "production";
    const CID = Deno.env.get(sandbox ? "WALMART_US_SANDBOX_CLIENT_ID" : "WALMART_US_PROD_CLIENT_ID");
    const SEC = Deno.env.get(sandbox ? "WALMART_US_SANDBOX_CLIENT_SECRET" : "WALMART_US_PROD_CLIENT_SECRET");
    if (!CID || !SEC) return json({ error: `Walmart US ${env} secrets are not set.` }, 500);

    // --- status ----------------------------------------------------------------
    if (mode === "status") {
      if (!body.feedId) return json({ error: "feedId is required." }, 400);
      const wm = await getToken(base, CID, SEC);
      const items: unknown[] = [];
      let offset = 0;
      let summary: Record<string, unknown> = {};
      for (let page = 0; page < 20; page++) {
        const res = await fetch(`${base}/v3/feeds/${encodeURIComponent(body.feedId)}?includeDetails=true&limit=50&offset=${offset}`, { headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": wm }) });
        const t = await res.text();
        if (!res.ok) return json({ ok: false, env, status: res.status, body: t.slice(0, 400) }, 502);
        const d = JSON.parse(t) as Record<string, unknown>;
        summary = { feedStatus: d.feedStatus, itemsReceived: d.itemsReceived, itemsSucceeded: d.itemsSucceeded, itemsFailed: d.itemsFailed, itemsProcessing: d.itemsProcessing };
        const page_ = ((d.itemDetails as Record<string, unknown>)?.itemIngestionStatus ?? []) as unknown[];
        items.push(...page_);
        offset += 50;
        if (page_.length < 50 || offset >= Number(d.itemsReceived ?? 0)) break;
      }
      return json({ ok: true, env, feedId: body.feedId, ...summary, items });
    }

    // --- spec (read-only) ------------------------------------------------------
    if (mode === "spec") {
      const PCID = Deno.env.get("WALMART_US_PROD_CLIENT_ID"), PSEC = Deno.env.get("WALMART_US_PROD_CLIENT_SECRET");
      if (!PCID || !PSEC) return json({ error: "Walmart US production secrets are not set (needed to read the spec)." }, 500);
      const prodBase = "https://marketplace.walmartapis.com";
      const wm = await getToken(prodBase, PCID, PSEC);
      const types: string[] = Array.isArray(body.productTypes) && body.productTypes.length ? body.productTypes.map(String) : ["Sinks"];
      const feedType = body.feedType ? String(body.feedType) : "MP_ITEM";
      const version = body.version ? String(body.version) : SPEC_VERSION;
      const schema = await fetchSpec(prodBase, wm, types, feedType, version);
      return json({ ok: true, feedType, specVersion: version, productTypes: types, schema });
    }

    // --- account (read-only) ---------------------------------------------------
    if (mode === "account") {
      const PCID = Deno.env.get("WALMART_US_PROD_CLIENT_ID"), PSEC = Deno.env.get("WALMART_US_PROD_CLIENT_SECRET");
      if (!PCID || !PSEC) return json({ error: "Walmart US production secrets are not set." }, 500);
      const prodBase = "https://marketplace.walmartapis.com";
      const wm = await getToken(prodBase, PCID, PSEC);
      const out: Record<string, unknown> = {};
      for (const [key, path] of [["shipNodes", "/v3/settings/shipping/shipnodes"], ["partnerProfile", "/v3/settings/partnerprofile"], ["items", "/v3/items?limit=5"]]) {
        const r = await fetch(`${prodBase}${path}`, { headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": wm }) });
        const t = await r.text();
        let parsed: unknown = t.slice(0, 4000);
        try { parsed = JSON.parse(t); } catch { /* keep text */ }
        out[key] = { status: r.status, body: parsed };
      }
      return json({ ok: true, env: "production", ...out });
    }

    // --- get (read-only diagnostics) -------------------------------------------
    if (mode === "get") {
      const path = String(body.path ?? "");
      if (!/^\/v3\/(items\/walmart\/search|items(\/|\?|$)|feeds(\/|\?|$)|utilities\/taxonomy|settings\/)/.test(path)) return json({ error: "path not allowed (read-only diagnostics: /v3/items/walmart/search, /v3/items, /v3/feeds, /v3/utilities/taxonomy, /v3/settings/…)" }, 400);
      const PCID = Deno.env.get("WALMART_US_PROD_CLIENT_ID"), PSEC = Deno.env.get("WALMART_US_PROD_CLIENT_SECRET");
      if (!PCID || !PSEC) return json({ error: "Walmart US production secrets are not set." }, 500);
      const prodBase = "https://marketplace.walmartapis.com";
      const wm = await getToken(prodBase, PCID, PSEC);
      const r = await fetch(`${prodBase}${path}`, { headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": wm }) });
      const t = await r.text();
      let parsed: unknown = t.slice(0, 20000);
      try { parsed = JSON.parse(t); } catch { /* keep text */ }
      return json({ ok: r.ok, env: "production", path, status: r.status, body: parsed });
    }

    // --- build ----------------------------------------------------------------
    const skus: string[] = Array.isArray(body.skus) ? body.skus.map(String) : body.sku ? [String(body.sku)] : [];
    if (!skus.length) return json({ error: "skus[] is required." }, 400);
    if (skus.length > 200) return json({ error: "At most 200 SKUs per feed." }, 400);
    const { data: products, error: pErr } = await admin.from("products").select("*").in("sku", skus);
    if (pErr) return json({ error: `PIM read failed: ${pErr.message}` }, 500);
    const { data: mediaRows } = await admin.from("product_media").select("sku, storage_path, media_type, is_primary, display_order, image_role, language").in("sku", skus);
    const mediaBySku = new Map<string, MediaRow[]>();
    for (const m of (mediaRows ?? []) as MediaRow[]) mediaBySku.set(m.sku, [...(mediaBySku.get(m.sku) ?? []), m]);

    // Variant groups: family members in this batch share a group; the first is primary.
    const families = new Map<string, number>();
    for (const p of (products ?? []) as Product[]) if (p.family_number != null) families.set(String(p.family_number), (families.get(String(p.family_number)) ?? 0) + 1);
    const primarySeen = new Set<string>();

    const report: Record<string, unknown>[] = [];
    const items: unknown[] = [];
    const skipped: { sku: string; reason: string }[] = [];
    // setup "match": an offer on the listing Walmart's catalog already has for
    // the UPC (feed MP_ITEM_MATCH) — any category, no content sent.
    const matchSetup = body.setup === "match";
    for (const sku of skus) {
      const p = ((products ?? []) as Product[]).find((x) => x.sku === sku);
      if (!p) { skipped.push({ sku, reason: "not in the PIM" }); continue; }
      if (isExcluded(p, "walmart_us")) { skipped.push({ sku, reason: excludedMessage(sku, "walmart_us") }); continue; }
      if (matchSetup) {
        const built = buildMatch(p);
        report.push({ sku, productType: "Offer by match", ready: built.missing.length === 0, missing: built.missing, warnings: built.warnings, rows: built.rows, fields: built.rows.length });
        if (!built.missing.length) items.push(built.item);
        continue;
      }
      const type = productTypeFor(p);
      if (!type) { skipped.push({ sku, reason: `no Walmart mapping yet for category "${text(p.category)}" (Sinks only for now)` }); continue; }
      let group: { id: string; primary: boolean } | null = null;
      if (p.family_number != null) {
        const fam = String(p.family_number);
        const primary = !primarySeen.has(fam);
        primarySeen.add(fam);
        group = { id: `STYLISH-FAM-${fam}`, primary };
      }
      const built = buildSink(p, mediaBySku.get(sku) ?? [], group);
      report.push({ sku, productType: type, ready: built.missing.length === 0, missing: built.missing, warnings: built.warnings, rows: built.rows, fields: built.rows.length });
      if (!built.missing.length) items.push(built.item);
    }

    const feed = matchSetup
      ? { MPItemFeedHeader: MATCH_HEADER, MPItem: items }
      : { MPItemFeedHeader: { businessUnit: "WALMART_US", locale: "en", version: SPEC_VERSION }, MPItem: items };
    if (mode === "preview") {
      let validation: Record<string, unknown> | undefined;
      // No spec check for a match offer: Get Spec serves no MP_ITEM_MATCH schema.
      if (body.validate === true && items.length && !matchSetup) {
        const PCID = Deno.env.get("WALMART_US_PROD_CLIENT_ID"), PSEC = Deno.env.get("WALMART_US_PROD_CLIENT_SECRET");
        if (!PCID || !PSEC) return json({ error: "Walmart US production secrets are not set (needed to read the spec)." }, 500);
        const prodBase = "https://marketplace.walmartapis.com";
        const wm = await getToken(prodBase, PCID, PSEC);
        const types = [...new Set((report as { productType: string; ready: boolean }[]).filter((r) => r.ready).map((r) => r.productType))];
        const schema = await fetchSpec(prodBase, wm, types);
        // Validate each item on its own so errors point at a SKU.
        const readyRows = (report as { sku: string; ready: boolean }[]).filter((r) => r.ready);
        const perSku: Record<string, { path: string; message: string }[]> = {};
        let allValid = true;
        readyRows.forEach((r, i) => {
          const item = body.trim === "required" ? trimToRequired(items[i] as MPItem) : items[i];
          const one = validateFeed(schema, { MPItemFeedHeader: feed.MPItemFeedHeader, MPItem: [item] });
          if (!one.valid) { allValid = false; perSku[r.sku] = one.errors.map((e) => ({ ...e, path: e.path.replace(/^\/MPItem\/0/, "") })); }
        });
        validation = { valid: allValid, specVersion: SPEC_VERSION, checked: readyRows.length, errors: perSku };
        for (const r of report) {
          const errs = perSku[String(r.sku)];
          if (errs) (r as Record<string, unknown>).specErrors = errs;
        }
      }
      const shown = body.trim === "required" && !matchSetup ? { ...feed, MPItem: (items as MPItem[]).map(trimToRequired) } : feed;
      return json({ ok: true, env, preview: true, setup: matchSetup ? "match" : "item", trimmed: body.trim === "required" && !matchSetup, products: report, skipped, validation, payload: body.debug ? shown : undefined });
    }

    // --- submit ---------------------------------------------------------------
    if (mode !== "submit") return json({ error: `unknown mode "${mode}"` }, 400);
    if (!sandbox && body.confirm !== "CREATE") return json({ error: 'Production submit needs confirm: "CREATE".' }, 400);
    if (!items.length) return json({ error: "Nothing to submit: no SKU has every required field.", products: report, skipped }, 400);
    const wm = await getToken(base, CID, SEC);
    // trim: "required" sends only what the spec requires (no variant group, no
    // optional attributes) — to tell a Walmart-side rejection of the account
    // from one of the optional fields (ERR_PDI_0001, 2026-09-28).
    const trimmed = body.trim === "required" && !matchSetup;
    const sendFeed = trimmed ? { ...feed, MPItem: (items as MPItem[]).map(trimToRequired) } : feed;
    const feedType = matchSetup ? "MP_ITEM_MATCH" : "MP_ITEM";
    const form = new FormData();
    form.append("file", new Blob([JSON.stringify(sendFeed)], { type: "application/json" }), matchSetup ? "mp_item_match.json" : "mp_item.json");
    const res = await fetch(`${base}/v3/feeds?feedType=${feedType}`, {
      method: "POST",
      headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": wm }),
      body: form,
    });
    const t = await res.text();
    if (!res.ok) return json({ error: `Walmart feed ${res.status}: ${t.slice(0, 400)}`, env, products: report, skipped }, 502);
    let feedId: string | null = null;
    try { feedId = JSON.parse(t).feedId ?? null; } catch { /* keep null */ }

    // Read back what Walmart did (item setup takes minutes; report what is known so far).
    let outcome: Record<string, unknown> = {};
    if (feedId) {
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((r) => setTimeout(r, 5000));
        const r = await fetch(`${base}/v3/feeds/${encodeURIComponent(feedId)}?includeDetails=true&limit=50&offset=0`, { headers: wmHeaders({ "WM_SEC.ACCESS_TOKEN": wm }) });
        if (!r.ok) continue;
        const d = await r.json() as Record<string, unknown>;
        outcome = { feedStatus: d.feedStatus, itemsReceived: d.itemsReceived, itemsSucceeded: d.itemsSucceeded, itemsFailed: d.itemsFailed, itemsProcessing: d.itemsProcessing };
        const its = ((d.itemDetails as Record<string, unknown>)?.itemIngestionStatus ?? []) as Record<string, unknown>[];
        outcome.items = its;
        if (d.feedStatus === "PROCESSED" || d.feedStatus === "ERROR") break;
      }
    }
    const submitted = (report as { sku: string; ready: boolean }[]).filter((r) => r.ready).map((r) => r.sku);
    await admin.from("audit_log").insert({
      actor_id: caller.id, actor_email: caller.email ?? null, actor_name: null, action: "push", entity_type: "channel", entity_id: "walmart_us", target: "walmart",
      summary: `${sandbox ? "Sandbox test:" : "Submitted"} ${submitted.length} Walmart US ${matchSetup ? "offer(s) by match" : "item(s)"}${trimmed ? " (required fields only)" : ""}: ${submitted.slice(0, 8).join(", ")}${submitted.length > 8 ? "…" : ""} — feed ${feedId ?? "?"}${outcome.feedStatus ? `, ${outcome.feedStatus}` : ""}`,
      metadata: { env, feedId, feedType, skus: submitted, trimmed, ...outcome, items: undefined },
    }).then(() => {}, () => {});
    return json({ ok: true, env, feedId, feedType, setup: matchSetup ? "match" : "item", submitted, trimmed, products: report, skipped, ...outcome, sent: trimmed ? sendFeed : undefined });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[walmart-add-items] FAILED:", message);
    return json({ error: message }, 500);
  }
});
