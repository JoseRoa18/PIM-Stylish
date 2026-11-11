// Stylish PIM → Odoo: the product data the PIM owns, sent the moment it is
// saved (user, 2026-11-11: "apenas alguien le dé SAVE en PIM la información
// viaje a Odoo"). ONE WAY ONLY — nothing here ever copies an Odoo value into
// the PIM ("el flujo es solo PIM to Odoo, nunca Odoo to PIM").
//
// What travels (`fields`), read HERE from the database, never from the caller:
//   upc     attributes.upc                → product Barcode ("Master UPC")
//   box     attributes.shipping_dimensions_in { length, width, height }
//                                         → Shipping Length / Width / Height (Inches)
//   weight  products.shipping_weight_lb   → Shipping Weight (Lbs)
//   title   attributes.general_title_en   → the product's Name, ONLY on products
//           the PIM itself created in Odoo (table odoo_created_products; user:
//           "el Odoo description será el general title de nosotros")
// The PIM's page and its spreadsheet import call this right after a save,
// with the SKUs and the fields that save changed.
//
// `create: true` (the "Create it in Odoo too" box of a new PIM product): a SKU
// Odoo does not have is created there with what every PIM product in Odoo has
// — Goods, tracked in inventory, Units, shared by both companies — plus its
// category (from the PIM's, the accessories by kind), brand, Model Name,
// General Title (also its Name; else the Model Name, else the SKU), UPC and
// shipping box. Route, bill of materials, vendor, cost and reordering stay
// with operations. A SKU Odoo has under another spelling (D-701H-2 for
// D-701H2) is NOT created — unless that other spelling is itself a PIM
// product (A-906 / A906 are two products).
//
// What it never does:
//   · write to an archived Odoo product, or guess between two active ones;
//   · empty a field — what the PIM lacks is left as Odoo has it;
//   · send half a box (the three sides go together) or something that is not
//     a UPC (12–14 digits, right check digit);
//   · put a UPC on a second Odoo product (Odoo takes a Barcode once).
// Matching: the PIM's SKU = Odoo's default_code, exact, then ignoring case —
// the DASH is kept.
//
// Switch: app_settings 'odoo_push' { enabled } (Settings → Odoo). Off →
// nothing is sent and the answer is { off: true }. `dryRun` reads and compares
// whatever the switch says and writes nothing.
//
// Body: { skus: string[] (≤ 100), fields?: ("upc"|"box"|"weight"|"title")[], create?: boolean, dryRun?: boolean }
//   `fields` left out = ["upc"] (pages opened before the box was added).
// Answer: { ok, off?, dryRun, results: [{ sku, state, note, reason?, changes, held }] }
//   state   "updated" / "created" (on a dry run "would_update" / "would_create") | "same" | "held"
//   changes [{ field, before, after }]      held [{ field, reason, note }]
//   reasons no_upc | no_box | no_weight (nothing to send: said, not a failure) · bad_upc |
//           incomplete_box | not_in_pim | not_in_odoo | archived | several | taken |
//           look_alike | no_category | refused
// Every run that sent, created or held something writes one Activity Log
// entry (target "odoo") with Odoo's values before the change.
//
// Auth: a signed-in admin or editor, or a service-role bearer (proven through
// GoTrue's admin API). Secrets: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX_SKUS = 100;
const FIELD_KEYS = ["upc", "box", "weight", "title"] as const;
type FieldKey = typeof FIELD_KEYS[number];
// Nothing to send for that field: said on the card, not a failure.
const SOFT = new Set(["no_upc", "no_box", "no_weight"]);

type Change = { field: FieldKey; before: string; after: string };
type Hold = { field: FieldKey | "product"; reason: string; note: string };
type Result = { sku: string; state: "updated" | "would_update" | "created" | "would_create" | "same" | "held"; note: string; reason?: string; changes: Change[]; held: Hold[]; odooId?: number; values?: Record<string, unknown> };
type PimProduct = { sku: string; brand: string | null; category: string | null; model_name: string | null; product_type: string | null; shipping_weight_lb: number | string | null; upc: string | null; box: { length?: unknown; width?: unknown; height?: unknown } | null; title: string | null };
type OdooProduct = { id: number; default_code: string; barcode: string | false; active: boolean; name: string; product_tmpl_id: [number, string]; shipping_length_in: number; shipping_width_in: number; shipping_height_in: number; shipping_weight: number };
// A planned write: the Odoo values, which record takes them, and how to tell it was kept.
type Planned = Change & { on: "product" | "template"; values: Record<string, unknown>; kept: (now: OdooProduct) => boolean };

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
// correct check digit — the PIM completeness rule.
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
const LABEL: Record<FieldKey, string> = { upc: "UPC", box: "box", weight: "shipping weight", title: "name" };

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

const FIELDS = ["default_code", "barcode", "active", "name", "product_tmpl_id", "shipping_length_in", "shipping_width_in", "shipping_height_in", "shipping_weight"];
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

// What each asked field needs on an Odoo product: the writes, and what is
// held back with its reason.
function plan(p: PimProduct, rec: OdooProduct, want: Set<FieldKey>, takenBy: (upc: string) => string[], pimMade: boolean) {
  const planned: Planned[] = [];
  const held: Hold[] = [];

  if (want.has("upc")) {
    const upc = text(p.upc);
    const issue = upc ? upcIssue(upc) : null;
    const before = barcodeOf(rec);
    if (!upc) held.push({ field: "upc", reason: "no_upc", note: "No UPC in the PIM: Odoo's Barcode was left as it is." });
    else if (issue) held.push({ field: "upc", reason: "bad_upc", note: `The PIM's UPC ${upc} ${issue}: not sent to Odoo.` });
    else if (before !== upc) {
      const taken = takenBy(upc);
      if (taken.length) held.push({ field: "upc", reason: "taken", note: `In Odoo the UPC ${upc} is on ${taken.join(", ")}: Odoo takes a Barcode on one product only.` });
      else planned.push({ field: "upc", before, after: upc, on: "product", values: { barcode: upc }, kept: (now) => barcodeOf(now) === upc });
    }
  }

  if (want.has("box")) {
    const sides = [num(p.box?.length), num(p.box?.width), num(p.box?.height)];
    const have = sides.filter((x) => x != null).length;
    const odooSides = [num(rec.shipping_length_in), num(rec.shipping_width_in), num(rec.shipping_height_in)];
    if (have === 0) held.push({ field: "box", reason: "no_box", note: "No shipping box in the PIM: Odoo's was left as it is." });
    else if (have < 3) held.push({ field: "box", reason: "incomplete_box", note: `The PIM has ${have} of the 3 sides of the shipping box: not sent to Odoo.` });
    else if (!sides.every((x, i) => sameNum(x, odooSides[i]))) {
      planned.push({
        field: "box", before: odooSides.some((x) => x != null) ? boxText(odooSides) : "", after: boxText(sides), on: "template",
        values: { shipping_length_in: sides[0], shipping_width_in: sides[1], shipping_height_in: sides[2] },
        kept: (now) => sides.every((x, i) => sameNum(x, [num(now.shipping_length_in), num(now.shipping_width_in), num(now.shipping_height_in)][i])),
      });
    }
  }

  if (want.has("weight")) {
    const weight = num(p.shipping_weight_lb);
    const before = num(rec.shipping_weight);
    if (weight == null) held.push({ field: "weight", reason: "no_weight", note: "No shipping weight in the PIM: Odoo's was left as it is." });
    else if (!sameNum(weight, before)) {
      planned.push({ field: "weight", before: before == null ? "" : `${show(before)} lb`, after: `${show(weight)} lb`, on: "template", values: { shipping_weight: weight }, kept: (now) => sameNum(weight, num(now.shipping_weight)) });
    }
  }

  // The Name follows the General Title only on products the PIM created there.
  if (want.has("title") && pimMade) {
    const title = text(p.title);
    if (title && text(rec.name) !== title) planned.push({ field: "title", before: text(rec.name), after: title, on: "template", values: { name: title }, kept: (now) => text(now.name) === title });
  }
  return { planned, held };
}

const changeText = (c: Change, had = "it had") => {
  if (c.field === "upc") return `UPC ${c.after} (${c.before ? `${had} ${c.before}` : "its Barcode was empty"})`;
  if (c.field === "title") return `the name “${c.after}”${c.before ? ` (${had} “${c.before}”)` : ""}`;
  return `${LABEL[c.field]} ${c.after} (${c.before ? `${had} ${c.before}` : `${had} none`})`;
};

function finish(sku: string, changes: Change[], held: Hold[], dryRun: boolean, odooId?: number): Result {
  const hard = held.filter((h) => !SOFT.has(h.reason));
  const notes = held.map((h) => h.note).join(" ");
  const reason = (hard[0] ?? held[0])?.reason;
  const plain = changes.map(({ field, before, after }) => ({ field, before, after }));
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

    // --- caller: a signed-in admin / editor, or the service role -------------
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!bearer) return json({ error: "Missing Authorization header." }, 401);
    let caller: { id: string | null; email: string | null } = { id: null, email: "service role" };
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

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const dryRun = body.dryRun === true;
    const create = body.create === true;
    const skus = [...new Set((Array.isArray(body.skus) ? body.skus : []).map((s) => text(s)).filter(Boolean))];
    if (!skus.length) return json({ error: "No SKUs given." }, 400);
    if (skus.length > MAX_SKUS) return json({ error: `At most ${MAX_SKUS} SKUs per call (${skus.length} given).` }, 400);
    const asked = Array.isArray(body.fields) ? body.fields.map((f) => String(f)) : ["upc"];
    const unknown = asked.filter((f) => !(FIELD_KEYS as readonly string[]).includes(f));
    if (unknown.length) return json({ error: `Unknown field "${unknown[0]}" (use ${FIELD_KEYS.join(", ")}).` }, 400);
    const want = new Set(asked as FieldKey[]);
    if (!want.size && !create) return json({ error: "No fields given." }, 400);

    // --- the switch -----------------------------------------------------------
    const { data: setting, error: sErr } = await admin.from("app_settings").select("value").eq("key", "odoo_push").maybeSingle();
    if (sErr) return json({ error: sErr.message }, 500);
    const enabled = (setting?.value as { enabled?: boolean } | null)?.enabled === true;
    if (!enabled && !dryRun) return json({ ok: true, off: true, dryRun: false, results: [] });

    // --- the PIM's values -----------------------------------------------------
    const { data: products, error: pErr } = await admin.from("products")
      .select("sku, brand, category, model_name, product_type, shipping_weight_lb, upc:attributes->>upc, box:attributes->shipping_dimensions_in, title:attributes->>general_title_en")
      .in("sku", skus);
    if (pErr) return json({ error: pErr.message }, 500);
    const pim = new Map((products ?? []).map((p) => [(p as PimProduct).sku, p as PimProduct]));
    const { data: made, error: mErr } = await admin.from("odoo_created_products").select("sku").in("sku", skus);
    if (mErr) return json({ error: mErr.message }, 500);
    const pimMade = new Set((made ?? []).map((m: { sku: string }) => m.sku));

    const results = new Map<string, Result>();
    const holdAll = (sku: string, reason: string, note: string) => results.set(sku, { sku, state: "held", note, reason, changes: [], held: [{ field: "product", reason, note }] });
    const known = skus.filter((sku) => { if (pim.has(sku)) return true; holdAll(sku, "not_in_pim", `The PIM has no product with the SKU ${sku}.`); return false; });

    if (known.length) {
      const odoo = await odooClient();
      // Every company the PIM's Odoo user can see: a product of one company
      // only is invisible from the other.
      const companies = (await odoo("res.company", "search_read", [[]], { fields: ["id"] }) as { id: number }[]).map((c) => c.id);
      const context = { allowed_company_ids: companies };
      const found = await findProducts(odoo, known, context);

      // Who holds each UPC in Odoo today (active products).
      const upcs = [...new Set(known.map((s) => text(pim.get(s)!.upc)).filter((u) => u && !upcIssue(u)))];
      const holders = want.has("upc") || create
        ? (upcs.length ? await odoo("product.product", "search_read", [[["barcode", "in", upcs]]], { fields: ["default_code", "barcode"], context }) as { id: number; default_code: string; barcode: string }[] : [])
        : [];
      const takenBy = (upc: string, self?: number) => holders.filter((h) => h.id !== self && barcodeOf(h) === upc).map((h) => text(h.default_code));

      // ---- products Odoo has: compare and write ------------------------------
      const absent: string[] = [];
      for (const sku of known) {
        const p = pim.get(sku)!;
        const records = found.get(sku) ?? [];
        const active = records.filter((r) => r.active);
        if (!records.length) { absent.push(sku); continue; }
        if (!active.length) { holdAll(sku, "archived", `${sku} is archived in Odoo: not written.`); continue; }
        if (active.length > 1) { holdAll(sku, "several", `Odoo has ${active.length} active products with the SKU ${sku}: not written.`); continue; }
        const rec = active[0];
        // Asked only to create: the product is there already.
        if (!want.size) { results.set(sku, { sku, state: "same", note: `${sku} is already in Odoo: nothing was created.`, changes: [], held: [], odooId: rec.id }); continue; }
        const { planned, held } = plan(p, rec, want, (upc) => takenBy(upc, rec.id), pimMade.has(sku));
        if (dryRun || !planned.length) { results.set(sku, finish(sku, planned, held, dryRun, rec.id)); continue; }

        const done: Planned[] = [];
        for (const on of ["product", "template"] as const) {
          const part = planned.filter((c) => c.on === on);
          if (!part.length) continue;
          try {
            await odoo(on === "product" ? "product.product" : "product.template", "write", [[on === "product" ? rec.id : rec.product_tmpl_id[0]], Object.assign({}, ...part.map((c) => c.values))], { context });
            done.push(...part);
          } catch (err) {
            for (const c of part) held.push({ field: c.field, reason: "refused", note: `Odoo refused the ${LABEL[c.field]} ${c.after}: ${(err as Error).message}` });
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
          if (text(p.model_name)) values.model_name = text(p.model_name);
          if (title) values.general_title = title;
          const held: Hold[] = [];
          const upc = text(p.upc);
          if (upc) {
            const issue = upcIssue(upc);
            const taken = issue ? [] : takenBy(upc);
            if (issue) held.push({ field: "upc", reason: "bad_upc", note: `The PIM's UPC ${upc} ${issue}: not sent to Odoo.` });
            else if (taken.length) held.push({ field: "upc", reason: "taken", note: `In Odoo the UPC ${upc} is on ${taken.join(", ")}: Odoo takes a Barcode on one product only.` });
            else values.barcode = upc;
          }
          const sides = [num(p.box?.length), num(p.box?.width), num(p.box?.height)];
          if (sides.every((x) => x != null)) Object.assign(values, { shipping_length_in: sides[0], shipping_width_in: sides[1], shipping_height_in: sides[2] });
          const weight = num(p.shipping_weight_lb);
          if (weight != null) values.shipping_weight = weight;
          const notes = held.map((h) => h.note).join(" ");
          const what = `as “${name}” in ${categoryName}`;
          if (dryRun) { results.set(sku, { sku, state: "would_create", note: `Would be created in Odoo ${what}.${notes ? ` ${notes}` : ""}`, changes: [], held, values }); continue; }
          try {
            const templateId = await odoo("product.template", "create", [values], { context }) as number;
            const [variant] = await odoo("product.product", "search_read", [[["product_tmpl_id", "=", templateId]]], { fields: ["default_code"], context }) as { id: number }[];
            const { error } = await admin.from("odoo_created_products").upsert({ sku, odoo_template_id: templateId, odoo_product_id: variant?.id ?? null, name_sent: name, created_by: caller.id, created_by_email: caller.email, created_at: new Date().toISOString() }, { onConflict: "sku" });
            results.set(sku, { sku, state: "created", note: `Created in Odoo ${what}.${notes ? ` ${notes}` : ""}${error ? ` (The PIM could not note it down: ${error.message})` : ""}`, ...(held.length ? { reason: held[0].reason } : {}), changes: [], held, odooId: variant?.id, values });
          } catch (err) {
            holdAll(sku, "refused", `Odoo refused to create ${sku}: ${(err as Error).message}`);
          }
        }
      }
    }

    // --- Activity Log: what was sent, created or held, Odoo's values before ---
    const ordered = skus.map((s) => results.get(s)!).filter(Boolean);
    const updated = ordered.filter((r) => r.state === "updated");
    const created = ordered.filter((r) => r.state === "created");
    const heldHard = ordered.filter((r) => r.held.some((h) => !SOFT.has(h.reason)));
    if (!dryRun && (updated.length || created.length || heldHard.length)) {
      const touched = [...new Set([...updated, ...created, ...heldHard].map((r) => r.sku))];
      const one = touched.length === 1 ? ordered.find((r) => r.sku === touched[0])! : null;
      const perField = FIELD_KEYS.map((f) => [LABEL[f], updated.filter((r) => r.changes.some((c) => c.field === f)).length] as const).filter(([, n]) => n);
      const summary = one
        ? (one.state === "created" ? `Created ${one.sku} in Odoo: ${one.note}`
          : one.state === "updated" ? `Sent to Odoo for ${one.sku}: ${one.changes.map((c) => changeText(c as Change, "Odoo had")).join("; ")}${one.held.some((h) => !SOFT.has(h.reason)) ? `. Not sent: ${one.held.filter((h) => !SOFT.has(h.reason)).map((h) => h.note).join(" ")}` : ""}`
          : `Not sent to Odoo for ${one.sku}: ${one.note}`)
        : `Sent to Odoo: ${updated.length} updated${perField.length ? ` (${perField.map(([l, n]) => `${l} ${n}`).join(", ")})` : ""}${created.length ? `, ${created.length} created` : ""}${heldHard.length ? `, ${heldHard.length} with something not sent` : ""}`;
      await admin.from("audit_log").insert({
        actor_id: caller.id, actor_email: caller.email, actor_name: caller.id ? null : "PIM automation",
        action: created.length && !updated.length ? "create" : "push", entity_type: "product", entity_id: one ? one.sku : `${touched.length} products`, target: "odoo", summary: summary.slice(0, 900),
        metadata: {
          fields: [...want], created: created.map((r) => ({ sku: r.sku, values: r.values })),
          updated: updated.map((r) => ({ sku: r.sku, changes: r.changes })),
          held: heldHard.map((r) => ({ sku: r.sku, held: r.held.filter((h) => !SOFT.has(h.reason)) })),
        },
      });
    }

    return json({ ok: true, dryRun, results: ordered });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
