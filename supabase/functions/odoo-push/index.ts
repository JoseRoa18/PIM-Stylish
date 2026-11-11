// Stylish PIM → Odoo: the product data the PIM owns, sent the moment it is
// saved (user, 2026-11-11: "apenas alguien le dé SAVE en PIM la información
// viaje a Odoo … en este caso solo UPC").
//
// Today ONE field travels: the product's UPC (products.attributes.upc) →
// Odoo's product Barcode (product.product.barcode, shown as "Master UPC").
// The PIM's page and its spreadsheet import call this right after a save that
// changed a UPC, with the SKUs. The UPC itself is read HERE from the database,
// never taken from the caller.
//
// What it never does:
//   · create a product in Odoo, or write to an archived one;
//   · empty a Barcode — a product with no UPC in the PIM is left as Odoo has it;
//   · send something that is not a UPC (12–14 digits, right check digit);
//   · put a UPC on a second Odoo product — one that another active product
//     already has is held back and named (Odoo takes a Barcode once);
//   · guess between two active Odoo products with the same SKU.
// Matching: the PIM's SKU = Odoo's default_code, exact, then ignoring case —
// the DASH is kept (dashed and undashed SKUs are different products here).
//
// Switch: app_settings 'odoo_push' { enabled } (Settings → Odoo), off until
// the user turns it on. Off → nothing is sent and the answer is { off: true }.
// `dryRun` reads and compares whatever the switch says and writes nothing.
//
// Body: { skus: string[] (at most 100), dryRun?: boolean }
// Answer: { ok, off?, dryRun, results: [{ sku, state, reason?, note, pim, before?, after? }] }
//   state  "updated" (written; "would_update" on a dry run) | "same" | "held"
//   reason (held) no_upc | bad_upc | not_in_pim | not_in_odoo | archived | several | taken | refused
// Every run that sent or held something writes one Activity Log entry
// (target "odoo") with Odoo's value before the change.
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

type Result = { sku: string; state: "updated" | "would_update" | "same" | "held"; reason?: string; note: string; pim: string; before?: string; after?: string; odooId?: number };
type OdooProduct = { id: number; default_code: string; barcode: string | false; active: boolean };

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
  // (writing the same Barcode twice changes nothing); an answer from Odoo
  // itself — an error it gives — is never retried.
  const rpc = async (service: string, method: string, args: unknown[]) => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: ++id });
    for (let attempt = 1; ; attempt++) {
      let j: { error?: { message?: string; data?: { message?: string } }; result?: unknown };
      try {
        const r = await fetch(`${url}/jsonrpc`, { method: "POST", headers: { "content-type": "application/json" }, body });
        if (r.status === 429 || r.status >= 500) throw new Error(`Odoo answered ${r.status}`);
        j = await r.json();
      } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((ok) => setTimeout(ok, 600 * 2 ** (attempt - 1) + Math.random() * 500));
        continue;
      }
      if (j.error) throw new Error(String(j.error.data?.message ?? j.error.message ?? "Odoo gave an error").trim());
      return j.result;
    }
  };
  const uid = await rpc("common", "authenticate", [db, user, key, {}]);
  if (!uid) throw new Error("Odoo refused the PIM's login (ODOO_USER / ODOO_API_KEY).");
  return (model, method, args, kwargs = {}) => rpc("object", "execute_kw", [db, uid, key, model, method, args, kwargs]);
}

const FIELDS = ["default_code", "barcode", "active"];
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const barcodeOf = (p: OdooProduct) => String(p.barcode || "").trim();

// Odoo's products for these SKUs, archived ones included: SKU → its records.
async function findProducts(odoo: Odoo, skus: string[], context: Record<string, unknown>): Promise<Map<string, OdooProduct[]>> {
  const found = new Map<string, OdooProduct[]>();
  const add = (sku: string, p: OdooProduct) => found.set(sku, [...(found.get(sku) ?? []), p]);
  const exact = new Set(skus);
  const all = { ...context, active_test: false };
  const rows = await odoo("product.product", "search_read", [[["default_code", "in", skus]]], { fields: FIELDS, context: all }) as OdooProduct[];
  for (const r of rows) if (exact.has(String(r.default_code).trim())) add(String(r.default_code).trim(), r);
  // What the exact spelling did not find, once more ignoring case.
  const missing = skus.filter((s) => !found.has(s));
  const byUpper = new Map(missing.map((s) => [s.toUpperCase(), s]));
  for (let i = 0; i < missing.length; i += 40) {
    const part = missing.slice(i, i + 40);
    const domain: unknown[] = [...Array(part.length - 1).fill("|"), ...part.map((s) => ["default_code", "=ilike", likeEscape(s)])];
    const more = await odoo("product.product", "search_read", [domain], { fields: FIELDS, context: all }) as OdooProduct[];
    for (const r of more) {
      const sku = byUpper.get(String(r.default_code ?? "").trim().toUpperCase());
      if (sku) add(sku, r);
    }
  }
  return found;
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
    const skus = [...new Set((Array.isArray(body.skus) ? body.skus : []).map((s) => String(s ?? "").trim()).filter(Boolean))];
    if (!skus.length) return json({ error: "No SKUs given." }, 400);
    if (skus.length > MAX_SKUS) return json({ error: `At most ${MAX_SKUS} SKUs per call (${skus.length} given).` }, 400);

    // --- the switch -----------------------------------------------------------
    const { data: setting, error: sErr } = await admin.from("app_settings").select("value").eq("key", "odoo_push").maybeSingle();
    if (sErr) return json({ error: sErr.message }, 500);
    const enabled = (setting?.value as { enabled?: boolean } | null)?.enabled === true;
    if (!enabled && !dryRun) return json({ ok: true, off: true, dryRun: false, results: [] });

    // --- the PIM's UPCs -------------------------------------------------------
    const { data: products, error: pErr } = await admin.from("products").select("sku, upc:attributes->>upc").in("sku", skus);
    if (pErr) return json({ error: pErr.message }, 500);
    const pim = new Map((products ?? []).map((p: { sku: string; upc: string | null }) => [p.sku, String(p.upc ?? "").trim()]));

    const results: Result[] = [];
    const hold = (sku: string, reason: string, note: string, extra: Partial<Result> = {}) => results.push({ sku, state: "held", reason, note, pim: pim.get(sku) ?? "", ...extra });

    const toSend: string[] = [];
    for (const sku of skus) {
      if (!pim.has(sku)) { hold(sku, "not_in_pim", `The PIM has no product with the SKU ${sku}.`); continue; }
      const upc = pim.get(sku)!;
      if (!upc) { hold(sku, "no_upc", "No UPC in the PIM: Odoo's Barcode was left as it is."); continue; }
      const issue = upcIssue(upc);
      if (issue) { hold(sku, "bad_upc", `The PIM's UPC ${upc} ${issue}: not sent to Odoo.`); continue; }
      toSend.push(sku);
    }

    if (toSend.length) {
      const odoo = await odooClient();
      // Every company the PIM's Odoo user can see: a product of one company
      // only is invisible from the other.
      const companies = (await odoo("res.company", "search_read", [[]], { fields: ["id"] }) as { id: number }[]).map((c) => c.id);
      const context = { allowed_company_ids: companies };
      const found = await findProducts(odoo, toSend, context);

      // Who holds each UPC in Odoo today (active products).
      const upcs = [...new Set(toSend.map((s) => pim.get(s)!))];
      const holders = await odoo("product.product", "search_read", [[["barcode", "in", upcs]]], { fields: FIELDS, context }) as OdooProduct[];

      const writes: { sku: string; id: number; upc: string; before: string }[] = [];
      for (const sku of toSend) {
        const upc = pim.get(sku)!;
        const records = found.get(sku) ?? [];
        const active = records.filter((r) => r.active);
        if (!records.length) { hold(sku, "not_in_odoo", `Odoo has no product with the SKU ${sku}.`); continue; }
        if (!active.length) { hold(sku, "archived", `${sku} is archived in Odoo: not written.`); continue; }
        if (active.length > 1) { hold(sku, "several", `Odoo has ${active.length} active products with the SKU ${sku}: not written.`); continue; }
        const rec = active[0];
        const before = barcodeOf(rec);
        if (before === upc) { results.push({ sku, state: "same", note: `Odoo already has ${upc}.`, pim: upc, before, after: before, odooId: rec.id }); continue; }
        const taken = holders.filter((h) => h.id !== rec.id && barcodeOf(h) === upc).map((h) => String(h.default_code).trim());
        if (taken.length) { hold(sku, "taken", `In Odoo the UPC ${upc} is on ${taken.join(", ")}: Odoo takes a Barcode on one product only.`, { before, odooId: rec.id }); continue; }
        writes.push({ sku, id: rec.id, upc, before });
      }

      for (const w of writes) {
        const was = w.before ? `it had ${w.before}` : "its Barcode was empty";
        if (dryRun) { results.push({ sku: w.sku, state: "would_update", note: `Odoo would get ${w.upc} (${was}).`, pim: w.upc, before: w.before, after: w.upc, odooId: w.id }); continue; }
        try {
          await odoo("product.product", "write", [[w.id], { barcode: w.upc }], { context });
          const [now] = await odoo("product.product", "read", [[w.id], ["barcode"]], { context }) as OdooProduct[];
          const after = now ? barcodeOf(now) : "";
          if (after !== w.upc) { hold(w.sku, "refused", `Odoo did not keep the UPC ${w.upc} (its Barcode reads ${after || "empty"}).`, { before: w.before, after, odooId: w.id }); continue; }
          results.push({ sku: w.sku, state: "updated", note: `Odoo now has ${w.upc} (${was}).`, pim: w.upc, before: w.before, after, odooId: w.id });
        } catch (err) {
          hold(w.sku, "refused", `Odoo refused the UPC ${w.upc}: ${(err as Error).message}`, { before: w.before, odooId: w.id });
        }
      }
    }

    // --- Activity Log: what was sent, what was held, Odoo's value before ------
    const order = new Map(skus.map((s, i) => [s, i]));
    results.sort((a, b) => order.get(a.sku)! - order.get(b.sku)!);
    const updated = results.filter((r) => r.state === "updated");
    const held = results.filter((r) => r.state === "held");
    if (!dryRun && (updated.length || held.length)) {
      const one = updated.length + held.length === 1 ? (updated[0] ?? held[0]) : null;
      const summary = one
        ? (one.state === "updated" ? `Sent the UPC of ${one.sku} to Odoo: ${one.after} (${one.before ? `Odoo had ${one.before}` : "Odoo's Barcode was empty"})` : `The UPC of ${one.sku} was not sent to Odoo: ${one.note}`)
        : `UPCs sent to Odoo: ${updated.length} updated${held.length ? `, ${held.length} not sent` : ""}`;
      await admin.from("audit_log").insert({
        actor_id: caller.id, actor_email: caller.email, actor_name: caller.id ? null : "PIM automation",
        action: "push", entity_type: "product", entity_id: one ? one.sku : `${updated.length + held.length} products`, target: "odoo", summary,
        metadata: { field: "upc", updated: updated.map(({ sku, before, after }) => ({ sku, before, after })), held: held.map(({ sku, reason, note, pim: upc }) => ({ sku, reason, note, upc })) },
      });
    }

    return json({ ok: true, dryRun, results });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
