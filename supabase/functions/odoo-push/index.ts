// Stylish PIM → Odoo: the product data the PIM owns, sent the moment it is
// saved (user, 2026-11-11: "apenas alguien le dé SAVE en PIM la información
// viaje a Odoo"). ONE WAY ONLY — nothing here ever copies an Odoo value into
// the PIM ("el flujo es solo PIM to Odoo, nunca Odoo to PIM").
//
// What travels (`fields`), read HERE from the database, never from the caller:
//   upc             attributes.upc                 → Barcode ("Master UPC")
//   box             attributes.shipping_dimensions_in { length, width, height }
//                                                  → Shipping Length / Width / Height (Inches)
//   weight          products.shipping_weight_lb    → Shipping Weight (Lbs)
//   product_weight  attributes.product_weight_lb   → Overall Product Weight
//   model           products.model_name            → Model Name
//   hs              attributes.hs_code             → HS Code (Odoo's own closed list)
//   country         attributes.country_of_origin   → Country of Origin
//   image           the product's main image       → the product's picture
//   ids             the marketplace ids of the Aliases tab → Odoo's own id fields:
//                   Home Depot CA → Home Depot.ca SKU · Rona → Rona.ca SKU ·
//                   Lowe's US → Lowe's SKU · BB&B / Overstock → BB&B.com SKU ·
//                   Best Buy CA → Best Buy.ca SKU · Amazon Canada / USA seller SKU
//                   → ALIAS AMZ CAN / USA · their ASIN → ASIN Amazon.ca / .com.
//                   An id the PIM lacks is left as Odoo has it, without a word.
//   title           attributes.general_title_en    → the product's Name, ONLY on
//                   products the PIM itself created in Odoo (table
//                   odoo_created_products; user: "el Odoo description será el
//                   general title de nosotros"; for the ones Odoo already had:
//                   "NO, no todavía")
// The PIM's page and its spreadsheet import call this right after a save,
// with the SKUs and the fields that save changed.
//
// `create: true` (the "Create it in Odoo too" box of a new PIM product): a SKU
// Odoo does not have is created there with what every PIM product in Odoo has
// — Goods, tracked in inventory, Units, shared by both companies — plus its
// category (from the PIM's, the accessories by kind), brand and everything
// above (the General Title is also its Name; else the Model Name, else the
// SKU). Route, bill of materials, vendor, cost and reordering stay with
// operations. A SKU Odoo has under another spelling (D-701H-2 for D-701H2)
// is NOT created — unless that other spelling is itself a PIM product
// (A-906 / A906 are two products).
//
// What it never does:
//   · write to an archived Odoo product, or guess between two active ones;
//   · empty a field — what the PIM lacks is left as Odoo has it;
//   · send half a box (the three sides go together), something that is not a
//     UPC (12–14 digits, right check digit), or an HS code Odoo's list lacks;
//   · put a UPC on a second Odoo product (Odoo takes a Barcode once).
// Matching: the PIM's SKU = Odoo's default_code, exact, then ignoring case —
// the DASH is kept.
//
// What could not go for a reason Odoo's side can fix (the product is not
// there yet, is archived, another product holds the UPC, the HS code is not
// on Odoo's list, Odoo gave an error) is noted in `odoo_pending` and tried
// again every hour (`retry: true`, cron odoo-push-retry-hourly) until it goes.
//
// Switch: app_settings 'odoo_push' { enabled } (Settings → Odoo). Off →
// nothing is sent and the answer is { off: true }. `dryRun` reads and compares
// whatever the switch says and writes nothing.
//
// Body: { skus: string[] (≤ 100), fields?: string[], create?: boolean, dryRun?: boolean }
//       { retry: true, dryRun?: boolean }   — the pending ones (cron)
//   `fields` left out = ["upc"] (pages opened before the other fields existed).
// Answer: { ok, off?, dryRun, results: [{ sku, state, note, reason?, changes, held }] }
//   state   "updated" / "created" (on a dry run "would_update" / "would_create") | "same" | "held"
//   changes [{ field, before, after }]      held [{ field, reason, note }]
//   reasons no_<field> (nothing to send: said, not a failure) · bad_upc | incomplete_box |
//           hs_not_listed | country_unknown | not_in_pim | not_in_odoo | archived | several |
//           taken | look_alike | no_category | refused
// Every run that sent, created or held something writes one Activity Log
// entry (target "odoo") with Odoo's values before the change.
//
// Auth: a signed-in admin or editor, a service-role bearer (proven through
// GoTrue's admin API), or — for `retry` only — the cron's x-cron-secret.
// Deployed with verify_jwt off so pg_net can call it.
// Secrets: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY, CRON_SECRET.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX_SKUS = 100;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const FIELD_KEYS = ["upc", "box", "weight", "product_weight", "model", "hs", "country", "image", "ids", "title"] as const;
type FieldKey = typeof FIELD_KEYS[number];
const LABEL: Record<FieldKey, string> = { upc: "UPC", box: "box", weight: "shipping weight", product_weight: "product weight", model: "model name", hs: "HS code", country: "country of origin", image: "picture", ids: "marketplace id", title: "name" };
// The marketplace ids the PIM keeps (Aliases tab) and the Odoo field of each.
const ALIAS_FIELDS: Record<string, { field: string; name: string }> = {
  "Home Depot CA": { field: "homedepot_ca_sku", name: "Home Depot CA" },
  "Rona": { field: "rona_ca_sku", name: "Rona" },
  "Lowe's US": { field: "lowes_sku", name: "Lowe's" },
  "BB&B / Overstock": { field: "bbb_com_sku", name: "BB&B" },
  "Best Buy CA": { field: "bestbuy_ca_sku", name: "Best Buy" },
};
const AMAZON_FIELDS: Record<string, { seller: string; asin: string; name: string }> = {
  ca: { seller: "alias_amz_ca", asin: "asin_amazon_ca", name: "Amazon Canada" },
  us: { seller: "alias_amz_us", asin: "asin_amazon_com", name: "Amazon USA" },
};
const ID_FIELDS = [...Object.values(ALIAS_FIELDS).map((a) => a.field), ...Object.values(AMAZON_FIELDS).flatMap((a) => [a.seller, a.asin])];
// Nothing to send for that field (the PIM has no value): said on the card, not a failure.
const isSoft = (reason: string) => reason.startsWith("no_") && reason !== "no_category";
// What Odoo's side can fix: noted in odoo_pending and tried again every hour.
const RETRY = new Set(["not_in_odoo", "archived", "several", "taken", "hs_not_listed", "country_unknown", "refused"]);

type Change = { field: FieldKey; before: string; after: string; what?: string };
type Hold = { field: FieldKey | "product"; reason: string; note: string };
type Result = { sku: string; state: "updated" | "would_update" | "created" | "would_create" | "same" | "held"; note: string; reason?: string; changes: Change[]; held: Hold[]; odooId?: number; values?: Record<string, unknown> };
type PimProduct = {
  sku: string; brand: string | null; category: string | null; model_name: string | null; product_type: string | null; shipping_weight_lb: number | string | null;
  upc: string | null; box: { length?: unknown; width?: unknown; height?: unknown } | null; title: string | null; product_weight: string | null; hs: string | null; country: string | null;
};
type OdooProduct = {
  id: number; default_code: string; barcode: string | false; active: boolean; name: string; product_tmpl_id: [number, string];
  shipping_length_in: number; shipping_width_in: number; shipping_height_in: number; shipping_weight: number;
  overall_product_weight: number; model_name: string | false; hs_code: string | false; country_of_origin: [number, string] | false;
};
// A planned write: the Odoo values, which record takes them, and how to tell it was kept.
type Planned = Change & { on: "product" | "template"; values: Record<string, unknown>; kept: (now: OdooProduct) => boolean };
// What the lookups of a run know about Odoo.
type Known = { takenBy: (upc: string, self?: number) => string[]; hsKeys: Set<string>; countries: Map<string, number>; pimMade: Set<string>; images: Map<string, string>; ids: Map<string, { field: string; name: string; value: string }[]> };

// The role claim of a JWT, read without a signature check — it only picks
// which real check to run on the bearer.
function claimRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(b64)).role ?? null;
  } catch {
    return null;
  }
}

// What is wrong with a UPC, or null: UPC-A (12), EAN-13 or GTIN-14 with a
// correct check digit.
function upcIssue(upc: string): string | null {
  if (!/^\d+$/.test(upc)) return "is not a number";
  if (upc.length < 12 || upc.length > 14) return `has ${upc.length} digits (a UPC has 12)`;
  const digits = upc.split("").map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check ? null : "has a wrong check digit";
}

// A measure: a number above 0, else nothing (Odoo keeps 0 where it has none).
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const sameNum = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) < 0.005;
const show = (n: number | null) => (n == null ? "—" : String(Math.round(n * 100) / 100));
const boxText = (d: (number | null)[]) => `${d.map(show).join(" × ")} in`;
const text = (v: unknown) => String(v ?? "").trim();

// The Odoo category of a PIM product. Checked against the 367 products Odoo
// already had on 2026-11-11: it gives every one the category Odoo has.
const SINKS = ["kitchen_sink", "bar_prep_sink", "laundry_sink", "outdoor_sink"];
const KITCHEN_FAUCETS = ["kitchen_faucet", "kitchen_faucet_combo", "cold_water_tap", "pot_filler"];
function odooCategory(p: PimProduct): string {
  const category = String(p.category ?? "");
  if (SINKS.includes(category)) return "Kitchen Sink";
  if (category === "bathroom_sink") return "Porcelain Sinks";
  if (KITCHEN_FAUCETS.includes(category)) return "Kitchen Faucet";
  if (category === "bathroom_faucet") return "Bathroom Faucet and Showers";
  const t = `${p.product_type ?? ""} ${p.title ?? ""} ${p.model_name ?? ""}`.toLowerCase();
  if (/colander|drying rack|drying mat|dish rack|dish organizer|sink basket|accessories kit/.test(t) && !/(cutting|serving) board with/.test(t)) return "ColandersDryingRack";
  if (/(cutting|serving) board/.test(t)) return "Cutting Board";
  if (/\b(cap|cover|adapter)\b/.test(String(p.model_name ?? "").toLowerCase())) return "Other Accessories";
  if (/soap dispenser/.test(t)) return "Soap Dispenser";
  if (/strainer/.test(t)) return "Strainers";
  if (/pop-?up|drain/.test(t)) return "Pop-up Drains";
  if (/deck plate|faucet plate|hole cover|escutcheon/.test(t)) return "Faucet Plates";
  return "Other Accessories";
}

// A picture as Odoo takes it (base64), or the reason it could not be read.
async function pictureOf(url: string): Promise<{ data?: string; problem?: string }> {
  try {
    const res = await fetch(url);
    if (!res.ok) return { problem: `the PIM's image could not be read (${res.status})` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) return { problem: `the PIM's image is too big for Odoo (${Math.round(bytes.length / 1048576)} MB)` };
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { data: btoa(binary) };
  } catch (err) {
    return { problem: `the PIM's image could not be read (${(err as Error).message})` };
  }
}

// ================================= Odoo ===================================

type Odoo = (model: string, method: string, args: unknown[], kwargs?: Record<string, unknown>) => Promise<any>;
async function odooClient(): Promise<Odoo> {
  const url = (Deno.env.get("ODOO_URL") ?? "").replace(/\/$/, "");
  const db = Deno.env.get("ODOO_DB");
  const user = Deno.env.get("ODOO_USER");
  const key = Deno.env.get("ODOO_API_KEY");
  if (!url || !db || !user || !key) throw new Error("The ODOO_URL / ODOO_DB / ODOO_USER / ODOO_API_KEY secrets are not set.");
  let id = 0;
  // A request that does not get through is sent again after a growing pause
  // (writing the same values twice changes nothing) — except a create, sent
  // ONCE: twice would make two products. An answer from Odoo itself — an
  // error it gives — is never retried.
  const rpc = async (service: string, method: string, args: unknown[], once = false) => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: ++id });
    for (let attempt = 1; ; attempt++) {
      let j: { error?: { message?: string; data?: { message?: string } }; result?: unknown };
      try {
        const r = await fetch(`${url}/jsonrpc`, { method: "POST", headers: { "content-type": "application/json" }, body });
        if (r.status === 429 || r.status >= 500) throw new Error(`Odoo answered ${r.status}`);
        j = await r.json();
      } catch (err) {
        if (once || attempt >= 4) throw err;
        await new Promise((ok) => setTimeout(ok, 600 * 2 ** (attempt - 1) + Math.random() * 500));
        continue;
      }
      if (j.error) throw new Error(String(j.error.data?.message ?? j.error.message ?? "Odoo gave an error").trim());
      return j.result;
    }
  };
  const uid = await rpc("common", "authenticate", [db, user, key, {}]);
  if (!uid) throw new Error("Odoo refused the PIM's login (ODOO_USER / ODOO_API_KEY).");
  return (model, method, args, kwargs = {}) => rpc("object", "execute_kw", [db, uid, key, model, method, args, kwargs], method === "create");
}

const FIELDS = ["default_code", "barcode", "active", "name", "product_tmpl_id", "shipping_length_in", "shipping_width_in", "shipping_height_in", "shipping_weight", "overall_product_weight", "model_name", "hs_code", "country_of_origin", ...ID_FIELDS];
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const barcodeOf = (p: { barcode: string | false }) => text(p.barcode || "");

// Odoo's products for these SKUs, archived ones included: SKU → its records.
async function findProducts(odoo: Odoo, skus: string[], context: Record<string, unknown>): Promise<Map<string, OdooProduct[]>> {
  const found = new Map<string, OdooProduct[]>();
  const add = (sku: string, p: OdooProduct) => found.set(sku, [...(found.get(sku) ?? []), p]);
  const exact = new Set(skus);
  const all = { ...context, active_test: false };
  const rows = await odoo("product.product", "search_read", [[["default_code", "in", skus]]], { fields: FIELDS, context: all }) as OdooProduct[];
  for (const r of rows) if (exact.has(text(r.default_code))) add(text(r.default_code), r);
  // What the exact spelling did not find, once more ignoring case.
  const missing = skus.filter((s) => !found.has(s));
  const byUpper = new Map(missing.map((s) => [s.toUpperCase(), s]));
  for (let i = 0; i < missing.length; i += 40) {
    const part = missing.slice(i, i + 40);
    const domain: unknown[] = [...Array(part.length - 1).fill("|"), ...part.map((s) => ["default_code", "=ilike", likeEscape(s)])];
    const more = await odoo("product.product", "search_read", [domain], { fields: FIELDS, context: all }) as OdooProduct[];
    for (const r of more) {
      const sku = byUpper.get(text(r.default_code).toUpperCase());
      if (sku) add(sku, r);
    }
  }
  return found;
}

// ============================== what to send ===============================

// A field of the PIM as Odoo takes it: the values to write, or why not.
// (`image` is added by the caller: reading the picture takes a request.)
function valueOf(field: FieldKey, p: PimProduct, known: Known): { values?: Record<string, unknown>; show?: string; hold?: Hold } {
  const none = (what: string): { hold: Hold } => ({ hold: { field, reason: `no_${field}`, note: `No ${what} in the PIM: Odoo's was left as it is.` } });
  if (field === "upc") {
    const upc = text(p.upc);
    if (!upc) return { hold: { field, reason: "no_upc", note: "No UPC in the PIM: Odoo's Barcode was left as it is." } };
    const issue = upcIssue(upc);
    if (issue) return { hold: { field, reason: "bad_upc", note: `The PIM's UPC ${upc} ${issue}: not sent to Odoo.` } };
    return { values: { barcode: upc }, show: upc };
  }
  if (field === "box") {
    const sides = [num(p.box?.length), num(p.box?.width), num(p.box?.height)];
    const have = sides.filter((x) => x != null).length;
    if (have === 0) return none("shipping box");
    if (have < 3) return { hold: { field, reason: "incomplete_box", note: `The PIM has ${have} of the 3 sides of the shipping box: not sent to Odoo.` } };
    return { values: { shipping_length_in: sides[0], shipping_width_in: sides[1], shipping_height_in: sides[2] }, show: boxText(sides) };
  }
  if (field === "weight") {
    const weight = num(p.shipping_weight_lb);
    return weight == null ? none("shipping weight") : { values: { shipping_weight: weight }, show: `${show(weight)} lb` };
  }
  if (field === "product_weight") {
    const weight = num(p.product_weight);
    return weight == null ? none("product weight") : { values: { overall_product_weight: weight }, show: `${show(weight)} lb` };
  }
  if (field === "model") {
    const model = text(p.model_name);
    return model ? { values: { model_name: model }, show: `“${model}”` } : none("model name");
  }
  if (field === "hs") {
    const hs = text(p.hs);
    if (!hs) return none("HS code");
    if (!known.hsKeys.has(hs)) return { hold: { field, reason: "hs_not_listed", note: `The HS code ${hs} is not on Odoo's list of HS codes: not sent.` } };
    return { values: { hs_code: hs }, show: hs };
  }
  if (field === "country") {
    const country = text(p.country);
    if (!country) return none("country of origin");
    const id = known.countries.get(country.toLowerCase());
    if (!id) return { hold: { field, reason: "country_unknown", note: `Odoo has no country named ${country}: not sent.` } };
    return { values: { country_of_origin: id }, show: country };
  }
  if (field === "title") {
    const title = text(p.title);
    return title ? { values: { name: title }, show: `“${title}”` } : {};
  }
  return {};
}

// What each asked field needs on an Odoo product: the writes, and what is
// held back with its reason.
function plan(p: PimProduct, rec: OdooProduct, want: Set<FieldKey>, known: Known) {
  const planned: Planned[] = [];
  const held: Hold[] = [];
  const odooSides = [num(rec.shipping_length_in), num(rec.shipping_width_in), num(rec.shipping_height_in)];
  // What Odoo has for a field (as shown), and whether it already is the PIM's value.
  const there: Record<string, { before: string; same: (v: Record<string, unknown>) => boolean; kept: (v: Record<string, unknown>) => (now: OdooProduct) => boolean }> = {
    upc: { before: barcodeOf(rec), same: (v) => barcodeOf(rec) === v.barcode, kept: (v) => (now) => barcodeOf(now) === v.barcode },
    box: {
      before: odooSides.some((x) => x != null) ? boxText(odooSides) : "",
      same: (v) => [v.shipping_length_in, v.shipping_width_in, v.shipping_height_in].every((x, i) => sameNum(x as number, odooSides[i])),
      kept: (v) => (now) => [v.shipping_length_in, v.shipping_width_in, v.shipping_height_in].every((x, i) => sameNum(x as number, [num(now.shipping_length_in), num(now.shipping_width_in), num(now.shipping_height_in)][i])),
    },
    weight: { before: num(rec.shipping_weight) == null ? "" : `${show(num(rec.shipping_weight))} lb`, same: (v) => sameNum(v.shipping_weight as number, num(rec.shipping_weight)), kept: (v) => (now) => sameNum(v.shipping_weight as number, num(now.shipping_weight)) },
    product_weight: { before: num(rec.overall_product_weight) == null ? "" : `${show(num(rec.overall_product_weight))} lb`, same: (v) => sameNum(v.overall_product_weight as number, num(rec.overall_product_weight)), kept: (v) => (now) => sameNum(v.overall_product_weight as number, num(now.overall_product_weight)) },
    model: { before: text(rec.model_name || "") ? `“${text(rec.model_name || "")}”` : "", same: (v) => text(rec.model_name || "") === v.model_name, kept: (v) => (now) => text(now.model_name || "") === v.model_name },
    hs: { before: text(rec.hs_code || ""), same: (v) => text(rec.hs_code || "") === v.hs_code, kept: (v) => (now) => text(now.hs_code || "") === v.hs_code },
    country: { before: rec.country_of_origin ? rec.country_of_origin[1] : "", same: (v) => (rec.country_of_origin ? rec.country_of_origin[0] : 0) === v.country_of_origin, kept: (v) => (now) => (now.country_of_origin ? now.country_of_origin[0] : 0) === v.country_of_origin },
    title: { before: text(rec.name) ? `“${text(rec.name)}”` : "", same: (v) => text(rec.name) === v.name, kept: (v) => (now) => text(now.name) === v.name },
  };

  // The marketplace ids: each one the PIM has, where Odoo holds something else.
  if (want.has("ids")) {
    const odooIds = rec as unknown as Record<string, string | false>;
    for (const id of known.ids.get(p.sku) ?? []) {
      const before = text(odooIds[id.field] || "");
      if (before === id.value) continue;
      planned.push({ field: "ids", what: id.name, before, after: id.value, on: "template", values: { [id.field]: id.value }, kept: (now) => text((now as unknown as Record<string, string | false>)[id.field] || "") === id.value });
    }
  }

  for (const field of FIELD_KEYS) {
    if (!want.has(field) || field === "image" || field === "ids") continue;
    // The Name follows the General Title only on products the PIM created there.
    if (field === "title" && !known.pimMade.has(p.sku)) continue;
    const v = valueOf(field, p, known);
    if (v.hold) { held.push(v.hold); continue; }
    if (!v.values || there[field].same(v.values)) continue;
    if (field === "upc") {
      const taken = known.takenBy(String(v.values.barcode), rec.id);
      if (taken.length) { held.push({ field, reason: "taken", note: `In Odoo the UPC ${v.values.barcode} is on ${taken.join(", ")}: Odoo takes a Barcode on one product only.` }); continue; }
    }
    planned.push({ field, before: there[field].before, after: v.show ?? "", on: field === "upc" ? "product" : "template", values: v.values, kept: there[field].kept(v.values) });
  }
  return { planned, held };
}

const changeText = (c: Change, had = "it had") => {
  if (c.field === "upc") return `UPC ${c.after} (${c.before ? `${had} ${c.before}` : "its Barcode was empty"})`;
  if (c.field === "image") return "the PIM's main image as its picture";
  if (c.field === "ids") return `${c.what ?? "marketplace id"} ${c.after} (${c.before ? `${had} ${c.before}` : `${had} none`})`;
  return `${LABEL[c.field]} ${c.after} (${c.before ? `${had} ${c.before}` : `${had} none`})`;
};

function finish(sku: string, changes: Change[], held: Hold[], dryRun: boolean, odooId?: number): Result {
  const hard = held.filter((h) => !isSoft(h.reason));
  const notes = held.map((h) => h.note).join(" ");
  const reason = (hard[0] ?? held[0])?.reason;
  const plain = changes.map(({ field, before, after, what }) => ({ field, before, after, ...(what ? { what } : {}) }));
  if (changes.length) {
    const verb = dryRun ? "Odoo would get" : "Odoo now has";
    return { sku, state: dryRun ? "would_update" : "updated", note: `${verb} ${changes.map((c) => changeText(c)).join("; ")}.${notes ? ` ${notes}` : ""}`, ...(hard.length ? { reason } : {}), changes: plain, held, odooId };
  }
  if (held.length) return { sku, state: "held", note: notes, reason, changes: [], held, odooId };
  return { sku, state: "same", note: "Odoo already has the same.", changes: [], held: [], odooId };
}

// ================================ handler =================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const dryRun = body.dryRun === true;
    const retry = body.retry === true;
    const create = body.create === true && !retry;

    // --- caller: a signed-in admin / editor, the service role, or the cron ----
    const cronSecret = Deno.env.get("CRON_SECRET");
    const viaCron = Boolean(cronSecret && req.headers.get("x-cron-secret") === cronSecret);
    if (viaCron && !retry) return json({ error: "The cron only retries what is pending." }, 403);
    let caller: { id: string | null; email: string | null } = { id: null, email: viaCron ? "cron" : "service role" };
    if (!viaCron) {
      const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!bearer) return json({ error: "Missing Authorization header." }, 401);
      let service = bearer === SERVICE_ROLE;
      if (!service && (claimRole(bearer) === "service_role" || bearer.startsWith("sb_secret_"))) {
        const { error } = await createClient(SUPABASE_URL, bearer).auth.admin.listUsers({ page: 1, perPage: 1 });
        service = !error;
      }
      if (!service) {
        const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
        const { data: { user } } = await callerClient.auth.getUser();
        if (!user) return json({ error: "Invalid or expired session." }, 401);
        const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
        if (!["admin", "editor"].includes(profile?.role ?? "")) return json({ error: "Only admins and editors can send product data to Odoo." }, 403);
        caller = { id: user.id, email: user.email ?? null };
      }
    }

    // --- the switch -----------------------------------------------------------
    const { data: setting, error: sErr } = await admin.from("app_settings").select("value").eq("key", "odoo_push").maybeSingle();
    if (sErr) return json({ error: sErr.message }, 500);
    const enabled = (setting?.value as { enabled?: boolean } | null)?.enabled === true;
    if (!enabled && !dryRun) return json({ ok: true, off: true, dryRun: false, results: [] });

    // --- what was asked: SKUs and, for each, the fields ------------------------
    const isField = (f: string): f is FieldKey => (FIELD_KEYS as readonly string[]).includes(f);
    const wantOf = new Map<string, Set<FieldKey>>();
    if (retry) {
      const { data: pending, error } = await admin.from("odoo_pending").select("sku, fields").order("tried_at", { ascending: true, nullsFirst: true }).limit(MAX_SKUS);
      if (error) return json({ error: error.message }, 500);
      for (const row of pending ?? []) wantOf.set(String(row.sku), new Set(((row.fields ?? []) as string[]).filter(isField)));
      if (!wantOf.size) return json({ ok: true, dryRun, retry: true, results: [] });
    } else {
      const skus = [...new Set((Array.isArray(body.skus) ? body.skus : []).map((s) => text(s)).filter(Boolean))];
      if (!skus.length) return json({ error: "No SKUs given." }, 400);
      if (skus.length > MAX_SKUS) return json({ error: `At most ${MAX_SKUS} SKUs per call (${skus.length} given).` }, 400);
      const asked = Array.isArray(body.fields) ? body.fields.map((f) => String(f)) : ["upc"];
      const unknown = asked.filter((f) => !isField(f));
      if (unknown.length) return json({ error: `Unknown field "${unknown[0]}" (use ${FIELD_KEYS.join(", ")}).` }, 400);
      if (!asked.length && !create) return json({ error: "No fields given." }, 400);
      for (const sku of skus) wantOf.set(sku, new Set(asked as FieldKey[]));
    }
    const skus = [...wantOf.keys()];
    const anyWant = (f: FieldKey) => [...wantOf.values()].some((w) => w.has(f));

    // --- the PIM's values -----------------------------------------------------
    const { data: products, error: pErr } = await admin.from("products")
      .select("sku, brand, category, model_name, product_type, shipping_weight_lb, upc:attributes->>upc, box:attributes->shipping_dimensions_in, title:attributes->>general_title_en, product_weight:attributes->>product_weight_lb, hs:attributes->>hs_code, country:attributes->>country_of_origin")
      .in("sku", skus);
    if (pErr) return json({ error: pErr.message }, 500);
    const pim = new Map((products ?? []).map((p) => [(p as PimProduct).sku, p as PimProduct]));
    const { data: made, error: mErr } = await admin.from("odoo_created_products").select("sku").in("sku", skus);
    if (mErr) return json({ error: mErr.message }, 500);
    // The PIM's main image of each product (its address), when a picture is asked for.
    const images = new Map<string, string>();
    if (anyWant("image") || create) {
      const { data: media, error } = await admin.from("product_media").select("sku, storage_path").in("sku", skus).eq("is_primary", true).eq("media_type", "image");
      if (error) return json({ error: error.message }, 500);
      for (const m of media ?? []) if (/^https?:\/\//.test(String(m.storage_path))) images.set(String(m.sku), String(m.storage_path));
    }

    // The marketplace ids the PIM keeps for each product, by the Odoo field that takes them.
    const ids = new Map<string, { field: string; name: string; value: string }[]>();
    if (anyWant("ids") || create) {
      const put = (sku: string, field: string, name: string, value: unknown) => { const v = text(value); if (v) ids.set(sku, [...(ids.get(sku) ?? []), { field, name, value: v }]); };
      const { data: aliases, error: aErr } = await admin.from("product_aliases").select("sku, marketplace, alias").in("sku", skus).in("marketplace", Object.keys(ALIAS_FIELDS));
      if (aErr) return json({ error: aErr.message }, 500);
      for (const a of aliases ?? []) put(String(a.sku), ALIAS_FIELDS[String(a.marketplace)].field, `${ALIAS_FIELDS[String(a.marketplace)].name} id`, a.alias);
      const { data: amazon, error: zErr } = await admin.from("amazon_links").select("sku, marketplace, seller_sku, asin").in("sku", skus);
      if (zErr) return json({ error: zErr.message }, 500);
      for (const a of amazon ?? []) {
        const m = AMAZON_FIELDS[String(a.marketplace)];
        if (!m) continue;
        put(String(a.sku), m.seller, `${m.name} seller SKU`, a.seller_sku);
        put(String(a.sku), m.asin, `${m.name} ASIN`, a.asin);
      }
    }

    const results = new Map<string, Result>();
    const holdAll = (sku: string, reason: string, note: string) => results.set(sku, { sku, state: "held", note, reason, changes: [], held: [{ field: "product", reason, note }] });
    const here = skus.filter((sku) => { if (pim.has(sku)) return true; holdAll(sku, "not_in_pim", `The PIM has no product with the SKU ${sku}.`); return false; });

    if (here.length) {
      const odoo = await odooClient();
      // Every company the PIM's Odoo user can see: a product of one company
      // only is invisible from the other.
      const companies = (await odoo("res.company", "search_read", [[]], { fields: ["id"] }) as { id: number }[]).map((c) => c.id);
      const context = { allowed_company_ids: companies };
      const found = await findProducts(odoo, here, context);

      // Who holds each UPC in Odoo today (active products).
      const upcs = [...new Set(here.map((s) => text(pim.get(s)!.upc)).filter((u) => u && !upcIssue(u)))];
      const holders = (anyWant("upc") || create) && upcs.length
        ? await odoo("product.product", "search_read", [[["barcode", "in", upcs]]], { fields: ["default_code", "barcode"], context }) as { id: number; default_code: string; barcode: string }[]
        : [];
      // Odoo's own list of HS codes, and its countries by name.
      const hsKeys = new Set<string>();
      if (anyWant("hs") || create) {
        const f = await odoo("product.template", "fields_get", [["hs_code"]], { attributes: ["selection"] }) as { hs_code?: { selection?: [string, string][] } };
        for (const [key] of f.hs_code?.selection ?? []) hsKeys.add(key);
      }
      const countries = new Map<string, number>();
      const names = [...new Set(here.map((s) => text(pim.get(s)!.country)).filter(Boolean))];
      if ((anyWant("country") || create) && names.length) {
        const rows = await odoo("res.country", "search_read", [[["name", "in", names]]], { fields: ["name"], context: { lang: "en_US" } }) as { id: number; name: string }[];
        for (const r of rows) countries.set(r.name.toLowerCase(), r.id);
      }
      const known: Known = {
        takenBy: (upc, self) => holders.filter((h) => h.id !== self && barcodeOf(h) === upc).map((h) => text(h.default_code)),
        hsKeys, countries, pimMade: new Set((made ?? []).map((m: { sku: string }) => m.sku)), images, ids,
      };

      // ---- products Odoo has: compare and write ------------------------------
      const absent: string[] = [];
      for (const sku of here) {
        const p = pim.get(sku)!;
        const want = wantOf.get(sku)!;
        const records = found.get(sku) ?? [];
        const active = records.filter((r) => r.active);
        if (!records.length) { absent.push(sku); continue; }
        if (!active.length) { holdAll(sku, "archived", `${sku} is archived in Odoo: not written.`); continue; }
        if (active.length > 1) { holdAll(sku, "several", `Odoo has ${active.length} active products with the SKU ${sku}: not written.`); continue; }
        const rec = active[0];
        // Asked only to create: the product is there already.
        if (!want.size) { results.set(sku, { sku, state: "same", note: `${sku} is already in Odoo: nothing was created.`, changes: [], held: [], odooId: rec.id }); continue; }
        const { planned, held } = plan(p, rec, want, known);
        // The picture: always sent when asked (two pictures cannot be compared cheaply).
        if (want.has("image")) {
          const url = images.get(sku);
          if (!url) held.push({ field: "image", reason: "no_image", note: "No main image in the PIM: Odoo's picture was left as it is." });
          else if (dryRun) planned.push({ field: "image", before: "", after: "the main image", on: "template", values: {}, kept: () => true });
          else {
            const picture = await pictureOf(url);
            if (picture.data) planned.push({ field: "image", before: "", after: "the main image", on: "template", values: { image_1920: picture.data }, kept: () => true });
            else held.push({ field: "image", reason: "refused", note: `The picture was not sent: ${picture.problem}.` });
          }
        }
        if (dryRun || !planned.length) { results.set(sku, finish(sku, planned, held, dryRun, rec.id)); continue; }

        const done: Planned[] = [];
        for (const on of ["product", "template"] as const) {
          const part = planned.filter((c) => c.on === on);
          if (!part.length) continue;
          try {
            await odoo(on === "product" ? "product.product" : "product.template", "write", [[on === "product" ? rec.id : rec.product_tmpl_id[0]], Object.assign({}, ...part.map((c) => c.values))], { context });
            done.push(...part);
          } catch (err) {
            for (const c of part) held.push({ field: c.field, reason: "refused", note: `Odoo refused the ${LABEL[c.field]}${c.field === "image" ? "" : ` ${c.after}`}: ${(err as Error).message}` });
          }
        }
        // Read back: only what Odoo really kept counts as sent.
        const [now] = done.length ? await odoo("product.product", "read", [[rec.id], FIELDS], { context }) as OdooProduct[] : [null];
        const keptChanges = done.filter((c) => {
          if (now && c.kept(now)) return true;
          held.push({ field: c.field, reason: "refused", note: `Odoo did not keep the ${LABEL[c.field]} ${c.after}.` });
          return false;
        });
        results.set(sku, finish(sku, keptChanges, held, false, rec.id));
      }

      // ---- products Odoo does not have ---------------------------------------
      if (absent.length && !create) for (const sku of absent) holdAll(sku, "not_in_odoo", `Odoo has no product with the SKU ${sku}.`);
      if (absent.length && create) {
        // Another spelling of the SKU already in Odoo? (archived ones included)
        const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const everything = await odoo("product.product", "search_read", [[["default_code", "!=", false]]], { fields: ["default_code"], context: { ...context, active_test: false } }) as { default_code: string }[];
        const byLoose = new Map<string, string[]>();
        for (const r of everything) { const k = loose(text(r.default_code)); byLoose.set(k, [...(byLoose.get(k) ?? []), text(r.default_code)]); }
        // …unless that spelling is a product of its own in the PIM (A-906 / A906).
        const pimSkus = new Set<string>();
        for (let from = 0; ; from += 1000) {
          const { data, error } = await admin.from("products").select("sku").order("sku").range(from, from + 999);
          if (error) throw new Error(error.message);
          for (const r of data ?? []) pimSkus.add(String(r.sku));
          if ((data ?? []).length < 1000) break;
        }
        const categories = await odoo("product.category", "search_read", [[]], { fields: ["name"] }) as { id: number; name: string }[];
        const brands = await odoo("product.brand", "search_read", [[]], { fields: ["name"] }) as { id: number; name: string }[];

        for (const sku of absent) {
          const p = pim.get(sku)!;
          const alike = [...new Set(byLoose.get(loose(sku)) ?? [])].filter((code) => !pimSkus.has(code));
          if (alike.length) { holdAll(sku, "look_alike", `Odoo has ${alike.join(", ")} — the same SKU written another way? Not created.`); continue; }
          const categoryName = odooCategory(p);
          const category = categories.find((c) => c.name === categoryName);
          if (!category) { holdAll(sku, "no_category", `Odoo has no product category named ${categoryName}: not created.`); continue; }
          const title = text(p.title);
          const name = title || text(p.model_name) || sku;
          const values: Record<string, unknown> = { default_code: sku, name, type: "consu", is_storable: true, categ_id: category.id };
          const brand = brands.find((b) => b.name.toLowerCase() === text(p.brand).toLowerCase());
          if (brand) values.product_brand_id = brand.id;
          if (title) values.general_title = title;
          // Everything the PIM sends, as it has it today (what it lacks is simply left out).
          const held: Hold[] = [];
          for (const field of FIELD_KEYS) {
            if (field === "title" || field === "image") continue;
            const v = valueOf(field, p, known);
            if (v.hold && !isSoft(v.hold.reason)) held.push(v.hold);
            if (!v.values) continue;
            if (field === "upc") {
              const taken = known.takenBy(String(v.values.barcode));
              if (taken.length) { held.push({ field, reason: "taken", note: `In Odoo the UPC ${v.values.barcode} is on ${taken.join(", ")}: Odoo takes a Barcode on one product only.` }); continue; }
            }
            Object.assign(values, v.values);
          }
          for (const id of ids.get(sku) ?? []) values[id.field] = id.value;
          const notes = held.map((h) => h.note).join(" ");
          const what = `as “${name}” in ${categoryName}`;
          if (dryRun) { results.set(sku, { sku, state: "would_create", note: `Would be created in Odoo ${what}.${notes ? ` ${notes}` : ""}`, changes: [], held, values }); continue; }
          const shown = { ...values };
          const picture = images.get(sku) ? await pictureOf(images.get(sku)!) : null;
          if (picture?.data) values.image_1920 = picture.data;
          try {
            const templateId = await odoo("product.template", "create", [values], { context }) as number;
            const [variant] = await odoo("product.product", "search_read", [[["product_tmpl_id", "=", templateId]]], { fields: ["default_code"], context }) as { id: number }[];
            const { error } = await admin.from("odoo_created_products").upsert({ sku, odoo_template_id: templateId, odoo_product_id: variant?.id ?? null, name_sent: name, created_by: caller.id, created_by_email: caller.email, created_at: new Date().toISOString() }, { onConflict: "sku" });
            results.set(sku, { sku, state: "created", note: `Created in Odoo ${what}.${notes ? ` ${notes}` : ""}${error ? ` (The PIM could not note it down: ${error.message})` : ""}`, ...(held.length ? { reason: held[0].reason } : {}), changes: [], held, odooId: variant?.id, values: shown });
          } catch (err) {
            holdAll(sku, "refused", `Odoo refused to create ${sku}: ${(err as Error).message}`);
          }
        }
      }
    }

    const ordered = skus.map((s) => results.get(s)!).filter(Boolean);

    // --- what waits for Odoo's side: noted, and tried again every hour ---------
    if (!dryRun) {
      const { data: rows } = await admin.from("odoo_pending").select("sku, fields, since").in("sku", skus);
      const before = new Map((rows ?? []).map((r) => [String(r.sku), r as { sku: string; fields: string[]; since: string }]));
      const nowIso = new Date().toISOString();
      for (const r of ordered) {
        const asked = [...(wantOf.get(r.sku) ?? [])];
        const waiting = new Set<string>();
        let why: Hold | null = null;
        for (const h of r.held) {
          if (!RETRY.has(h.reason)) continue;
          why ??= h;
          for (const f of h.field === "product" ? asked : [h.field]) waiting.add(f);
        }
        // What this run dealt with stops waiting; what it did not ask about keeps waiting.
        const kept = (before.get(r.sku)?.fields ?? []).filter((f) => !asked.includes(f));
        const fields = [...new Set([...kept, ...waiting])];
        if (fields.length) {
          await admin.from("odoo_pending").upsert({ sku: r.sku, fields, reason: why?.reason ?? null, note: why?.note ?? null, since: before.get(r.sku)?.since ?? nowIso, tried_at: nowIso }, { onConflict: "sku" });
        } else if (before.has(r.sku)) {
          await admin.from("odoo_pending").delete().eq("sku", r.sku);
        }
      }
    }

    // --- Activity Log: what was sent, created or held, Odoo's values before ---
    const updated = ordered.filter((r) => r.state === "updated");
    const created = ordered.filter((r) => r.state === "created");
    const heldHard = ordered.filter((r) => r.held.some((h) => !isSoft(h.reason)));
    // An hourly retry that still cannot send says nothing: it is already noted.
    const worthLogging = retry ? updated.length > 0 : (updated.length || created.length || heldHard.length) > 0;
    if (!dryRun && worthLogging) {
      const touched = [...new Set([...updated, ...created, ...(retry ? [] : heldHard)].map((r) => r.sku))];
      const one = touched.length === 1 ? ordered.find((r) => r.sku === touched[0])! : null;
      const perField = FIELD_KEYS.map((f) => [LABEL[f], updated.filter((r) => r.changes.some((c) => c.field === f)).length] as const).filter(([, n]) => n);
      const hardNotes = (r: Result) => r.held.filter((h) => !isSoft(h.reason)).map((h) => h.note).join(" ");
      const summary = one
        ? (one.state === "created" ? `Created ${one.sku} in Odoo: ${one.note}`
          : one.state === "updated" ? `Sent to Odoo for ${one.sku}: ${one.changes.map((c) => changeText(c, "Odoo had")).join("; ")}${!retry && hardNotes(one) ? `. Not sent: ${hardNotes(one)}` : ""}`
          : `Not sent to Odoo for ${one.sku}: ${one.note}`)
        : `Sent to Odoo: ${updated.length} updated${perField.length ? ` (${perField.map(([l, n]) => `${l} ${n}`).join(", ")})` : ""}${created.length ? `, ${created.length} created` : ""}${!retry && heldHard.length ? `, ${heldHard.length} with something not sent` : ""}`;
      await admin.from("audit_log").insert({
        actor_id: caller.id, actor_email: caller.email, actor_name: caller.id ? null : "PIM automation",
        action: created.length && !updated.length ? "create" : "push", entity_type: "product", entity_id: one ? one.sku : `${touched.length} products`, target: "odoo",
        summary: `${retry ? "(Hourly retry) " : ""}${summary}`.slice(0, 900),
        metadata: {
          retry, created: created.map((r) => ({ sku: r.sku, values: r.values })),
          updated: updated.map((r) => ({ sku: r.sku, changes: r.changes })),
          held: (retry ? [] : heldHard).map((r) => ({ sku: r.sku, held: r.held.filter((h) => !isSoft(h.reason)) })),
        },
      });
    }

    return json({ ok: true, dryRun, ...(retry ? { retry: true } : {}), results: ordered });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
