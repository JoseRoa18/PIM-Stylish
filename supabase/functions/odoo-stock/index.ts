// One warehouse's stock in Odoo for a list of SKUs — the same numbers as Odoo's
// Inventory → Reporting → Stock with that warehouse selected. Read only.
//
// Body: { skus: string[], warehouse?: string }  (warehouse code, default "ATL")
//   →   { ok, warehouse, stock: { [sku]: { on_hand, free, incoming, forecasted } } }
// A SKU Odoo does not have for that warehouse's company is simply not in `stock`.
// Odoo's quantities need the warehouse's company allowed; since Odoo 17 the
// context key is `warehouse_id` (`warehouse` is ignored in part and gives wrong
// numbers). Duplicate records of one SKU are added up.
//
// Auth: a signed-in session, or a service-role bearer (proven through GoTrue
// admin — the runtime's SUPABASE_SERVICE_ROLE_KEY is not the .env key).
// Secrets: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY.

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

type Odoo = (model: string, method: string, args: unknown[], kwargs?: Record<string, unknown>) => Promise<any>;
async function odooClient(): Promise<Odoo> {
  const url = Deno.env.get("ODOO_URL")!.replace(/\/$/, "");
  const db = Deno.env.get("ODOO_DB")!;
  const user = Deno.env.get("ODOO_USER")!;
  const key = Deno.env.get("ODOO_API_KEY")!;
  let id = 0;
  const rpc = async (service: string, method: string, args: unknown[]) => {
    const r = await fetch(`${url}/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: ++id }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`Odoo: ${j.error.data?.message ?? j.error.message}`);
    return j.result;
  };
  const uid = await rpc("common", "authenticate", [db, user, key, {}]);
  if (!uid) throw new Error("Odoo refused the PIM's login (ODOO_USER / ODOO_API_KEY).");
  return (model, method, args, kwargs = {}) => rpc("object", "execute_kw", [db, uid, key, model, method, args, kwargs]);
}

async function isAllowed(bearer: string) {
  if (!bearer) return false;
  const url = Deno.env.get("SUPABASE_URL")!;
  const session = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const { data: { user } } = await session.auth.getUser();
  if (user) return true;
  const { error } = await createClient(url, bearer).auth.admin.listUsers({ perPage: 1 });
  return !error;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!(await isAllowed(bearer))) return json({ error: "Sign in to read Odoo's stock." }, 401);

    const body = await req.json().catch(() => ({}));
    const skus = Array.isArray(body.skus) ? [...new Set(body.skus.filter((s: unknown) => typeof s === "string" && s))] as string[] : [];
    const code = typeof body.warehouse === "string" && body.warehouse ? body.warehouse : "ATL";
    if (!skus.length) return json({ ok: true, warehouse: code, stock: {} });
    if (skus.length > 2000) return json({ error: "At most 2,000 SKUs per call." }, 400);

    const odoo = await odooClient();
    const [warehouse] = await odoo("stock.warehouse", "search_read", [[["code", "=", code]]], {
      fields: ["id", "name", "company_id"],
      limit: 1,
    });
    if (!warehouse) return json({ error: `Odoo has no warehouse with the code ${code}.` }, 404);
    const context = { warehouse_id: warehouse.id, allowed_company_ids: [warehouse.company_id[0]] };

    const stock: Record<string, { on_hand: number; free: number; incoming: number; forecasted: number }> = {};
    for (let i = 0; i < skus.length; i += 200) {
      const rows = await odoo("product.product", "search_read", [[["default_code", "in", skus.slice(i, i + 200)]]], {
        fields: ["default_code", "qty_available", "free_qty", "incoming_qty", "virtual_available"],
        context,
      }) as { default_code: string; qty_available: number; free_qty: number; incoming_qty: number; virtual_available: number }[];
      for (const r of rows) {
        const s = (stock[r.default_code] ??= { on_hand: 0, free: 0, incoming: 0, forecasted: 0 });
        s.on_hand += Number(r.qty_available) || 0;
        s.free += Number(r.free_qty) || 0;
        s.incoming += Number(r.incoming_qty) || 0;
        s.forecasted += Number(r.virtual_available) || 0;
      }
    }
    return json({ ok: true, warehouse: warehouse.name, stock });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
