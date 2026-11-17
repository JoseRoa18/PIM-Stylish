// The Operations tab of the EOS ScoreCard, filled by the PIM (user, 2026-11-16:
// "necesito que la mayoría de todo eso se pueda traer automático, sea de
// ShipStation, de Odoo o de algún otro sitio" — "Conéctalo pues, dale").
// Called by scorecard-fill for the board "operations", with that function's
// own tools — so a rule it already has (the value of a return, a product's
// cost) is the same code here.
//
// ShipStation is NOT a source (user, 2026-11-17: "Desconecta ShipStation de EOS
// ScoreCard … de cualquier item o KPI"). Until that day its labels gave the cost
// per label, the orders processed, the cost of a return label and when an order
// shipped (same-day shipping, processed on time, not processed in 24 h, and the
// marketplace tabs' on-time rows copied here): those rows are typed by their
// people now, and nothing below reads public.shipstation_labels.
//
// Where each number comes from (everything is read; nothing is written but
// the scorecard's own values):
//   · Odoo: every order of the country (Open Box sales, wrong / missing items,
//     returns over sales), the returns bodega received and where the goods
//     went, the manufacturing orders, the inventory counts, costs, and its
//     replenishment report's days of inventory for three single SKUs;
//   · WeCare, our customer-care app (its own API, GET /api/pim/scorecard, with
//     the key it gave the PIM): tickets closed, resolution time and customer
//     satisfaction of the week — totals only, worked out there with its
//     dashboard's own rules;
//   · the PIM's stock and sales (product_inventory, product_sales): stock
//     available for sale, products under 70 days of inventory, excess and
//     obsolete inventory.
//
// Columns, as on every tab: a column (its Sunday) holds the numbers of the
// week BEFORE it, Eastern days. Three kinds of row:
//   · a week's own number (orders, returns…): every column asked for;
//   · SNAPSHOT — today's state (stock, days of inventory): this week's column
//     only, as the team types it on the day of the meeting;
//   · ONCE — Odoo keeps only a product's LAST count date, so a week's count
//     shrinks as products are counted again: the week in progress is written
//     at every run, and a closed week only while it has no number yet.
//
// A new row: its key in OPS_KEYS (and AUTO_KEYS in autoMetrics.js, with
// `ops: true`), its number below, and the key on the measurable.

export const OPS_BOARD = "operations";

type Market = "ca" | "us";
type Odoo = (model: string, method: string, args: unknown[], kwargs?: Record<string, unknown>) => Promise<any>;
interface Row { id: string; market: Market | null; name: string; auto_key: string }
interface OrderRow { id: number; date: string; state: string; mp: number | null }
interface LineRow { orderId: number; code: string | null; qty: number; subtotal: number; goods: boolean }
export interface OpsOut { metricId: string; board: string; market: string; name: string; key: string; week: string; value: number | null; note?: string | null }
export interface OpsTools {
  addDays: (day: string, n: number) => string;
  etMidnightUtc: (day: string) => string;
  isoOf: (odooTime: string) => string;
  etMs: (day: string) => number;
  round2: (n: number) => number;
  ratio: (a: number, b: number) => number | null;
  receivedReturns: (odoo: Odoo, pickDomain: unknown[], sinceDay: string) => Promise<{ at: string; orderId: number; value: number }[]>;
  costsBySku: (odoo: Odoo, company: number, skus: string[]) => Promise<Map<string, number>>;
  usdPerUnit: (odoo: Odoo, company: number) => Promise<number | null>;
}
interface Ctx { admin: any; odoo: Odoo; rows: Row[]; loop: string[]; thisColumn: string; runColumn: string; diag: Record<string, any>; tools: OpsTools }

// Odoo: the companies, each country's warehouse, and the "marketplaces" that
// are not sales (marketplace.master).
const COMPANY: Record<Market, number> = { ca: 2, us: 1 };
const WAREHOUSE: Record<Market, string> = { ca: "CBG", us: "ATL" };
const MARKETS: Market[] = ["ca", "us"];
const MP = { warranty: 18, missing: 19, correct: 20, wrong: 21, reviewCa: 22, reviewUs: 23 };
const NOT_A_SALE = new Set([MP.warranty, MP.missing, MP.correct, MP.wrong, MP.reviewCa, MP.reviewUs]);
const DOI_DAYS = 70;      // "below 70 days of inventory"
const EXCESS_DAYS = 180;  // "inventory excess over 180 days"

// Days of inventory of one SKU, read from Odoo's replenishment report.
const SINGLE_SKU: Record<string, string> = { ops_doi_st05: "ST-05", ops_doi_a918kit: "A-918KIT", ops_doi_a919kit: "A-919KIT" };
// Products under 70 days of inventory, by group.
const SINK = /sink/;
const FAUCET = /faucet|cold_water_tap|pot_filler/;
const DOI_GROUP: Record<string, (p: { sku: string; category: string }) => boolean> = {
  ops_doi_sinks: (p) => SINK.test(p.category),
  ops_doi_faucets: (p) => FAUCET.test(p.category),
  ops_doi_versa: (p) => p.sku.startsWith("S-6"),
  ops_doi_pietra: (p) => p.sku.startsWith("S-8"),
  ops_doi_porcelain: (p) => p.sku.startsWith("P-"),
  ops_doi_accessories: (p) => !SINK.test(p.category) && !FAUCET.test(p.category),
};
// Customer care, asked from WeCare (both countries together: the rows have no country).
const CARE_KEYS = ["ops_care_tickets_closed", "ops_care_resolution_hours", "ops_care_csat"];
const ORDER_KEYS = ["ops_open_box_sales", "ops_shipment_errors", "ops_returns_over_sales", "ops_oos_assembly_loss"];
const RETURN_KEYS = ["ops_returns_processed", "ops_returns_to_stock", "ops_returns_to_openbox"];
const ASSEMBLY_KEYS = ["ops_assembly_sinks", "ops_assembly_versa"];
const COUNT_KEYS = ["ops_cycle_count", "ops_inventory_accuracy"];
const STOCK_KEYS = ["ops_in_stock", ...Object.keys(DOI_GROUP), "ops_inventory_excess", "ops_obsolete_value"];
const SNAPSHOT = new Set([...STOCK_KEYS, ...Object.keys(SINGLE_SKU), "ops_oos_assembly_loss"]);
const ONCE = new Set(COUNT_KEYS);
export const OPS_KEYS = [...CARE_KEYS, ...ORDER_KEYS, ...RETURN_KEYS, ...ASSEMBLY_KEYS, ...COUNT_KEYS, ...STOCK_KEYS, ...Object.keys(SINGLE_SKU)];

/** Every row of a table read (the API returns at most 1,000 per request). */
async function allRows(build: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}
/** Odoo's "<warehouse>: <operation>" name of a picking type → the country of its warehouse. */
const marketOf = (pickingType: [number, string] | false): Market | null => {
  const name = pickingType ? pickingType[1] : "";
  return /\bCBG\b/.test(name) ? "ca" : /\bATL\b/.test(name) ? "us" : null;
};

/** The numbers of the Operations rows for the columns asked for. */
export async function operationsValues({ admin, odoo, rows, loop, thisColumn, runColumn, diag, tools: t }: Ctx): Promise<OpsOut[]> {
  const keys = new Set(rows.map((r) => r.auto_key));
  const has = (list: string[]) => list.some((k) => keys.has(k));
  const marketsOf = (list: string[]): Market[] => MARKETS.filter((m) => rows.some((r) => list.includes(r.auto_key) && (r.market === m || r.market == null)));
  const oldest = loop.at(-1)!;
  const newest = loop[0];
  const dataFrom = (column: string) => t.addDays(column, -7); // a column's data week: the 7 days before its Sunday
  const inDays = (iso: string, fromDay: string, toDay: string) => { const x = Date.parse(iso); return x >= t.etMs(fromDay) && x < t.etMs(toDay); };
  const sinceOdoo = t.etMidnightUtc(t.addDays(oldest, -7));
  // key | market ('' = both countries) | column → number
  const values = new Map<string, number | null>();
  const put = (key: string, market: Market | "", column: string, value: number | null | undefined) => { if (value != null && Number.isFinite(value)) values.set(`${key}|${market}|${column}`, value); };

  // ---- WeCare: the week's customer-care totals -----------------------------------
  // WeCare answers with totals only (its server/pim.js). When it cannot be
  // reached the rows keep what they have: the rest of the tab still fills.
  if (has(CARE_KEYS)) {
    const base = (Deno.env.get("WECARE_API_URL") ?? "").replace(/\/+$/, "");
    const key = Deno.env.get("WECARE_API_KEY");
    if (!base || !key) diag.wecare = "WECARE_API_URL / WECARE_API_KEY are not set";
    else {
      try {
        // each column's data week, as instants: [Sunday 00:00 Eastern, the next Sunday 00:00)
        const ranges = loop.map((column) => t.isoOf(t.etMidnightUtc(dataFrom(column))) + "_" + t.isoOf(t.etMidnightUtc(column)));
        const res = await fetch(base + "/api/pim/scorecard?ranges=" + encodeURIComponent(ranges.join(",")), { headers: { Authorization: "Bearer " + key } });
        const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; ranges?: { ticketsClosed: number; avgResolutionHours: number | null; resolvedSample: number; surveysAnswered: number; satisfactionRate: number | null }[] } | null;
        if (!res.ok || !body?.ok || !Array.isArray(body.ranges) || body.ranges.length !== loop.length) diag.wecare = "WeCare answered " + res.status + (body?.error ? ": " + body.error : "");
        else {
          loop.forEach((column, i) => {
            const w = body.ranges![i];
            put("ops_care_tickets_closed", "", column, w.ticketsClosed);
            put("ops_care_resolution_hours", "", column, w.avgResolutionHours);
            put("ops_care_csat", "", column, w.satisfactionRate);
          });
          diag.wecare = body.ranges.map((w) => w.ticketsClosed + " closed, " + w.surveysAnswered + " survey answers").join(" | ");
        }
      } catch (err) {
        diag.wecare = "WeCare could not be reached: " + (err as Error).message;
      }
    }
  }

  // ---- the PIM's stock and sales (today): this week's column --------------------
  const wantsStock = loop.includes(thisColumn) && (has(STOCK_KEYS) || keys.has("ops_oos_assembly_loss"));
  let products: { sku: string; category: string; workflow_status: string; is_obsolete: boolean }[] = [];
  const stock: Record<Market, Map<string, { available: number; onHand: number; onOrder: number }>> = { ca: new Map(), us: new Map() };
  if (wantsStock || has(ORDER_KEYS)) {
    products = (await allRows(() => admin.from("products").select("sku, category, workflow_status, is_obsolete").order("sku"))).map((p: any) => ({ ...p, category: String(p.category ?? "") }));
  }
  const live = products.filter((p) => p.workflow_status !== "archived");
  if (wantsStock) {
    const inv = await allRows(() => admin.from("product_inventory").select("market, sku, available, on_hand, warehouses").order("market").order("sku")) as { market: Market; sku: string; available: number; on_hand: number | null; warehouses: Record<string, { on_order?: number }> | null }[];
    for (const r of inv) stock[r.market]?.set(r.sku, { available: Number(r.available) || 0, onHand: Math.max(0, Number(r.on_hand) || 0), onOrder: Number(r.warehouses?.[WAREHOUSE[r.market]]?.on_order) || 0 });
    const sales = await allRows(() => admin.from("product_sales").select("market, sku, units_90").order("market").order("sku")) as { market: Market; sku: string; units_90: number }[];
    const pace: Record<Market, Map<string, number>> = { ca: new Map(), us: new Map() }; // units a day, last 90 days
    for (const s of sales) pace[s.market]?.set(s.sku, (Number(s.units_90) || 0) / 90);
    for (const market of marketsOf(STOCK_KEYS)) {
      const here = stock[market];
      // The share of the products Odoo tracks in the country that have stock (the Company tab's own number).
      if (here.size) put("ops_in_stock", market, thisColumn, t.ratio([...here.values()].filter((s) => s.available > 0).length, here.size));
      // Selling products whose stock — available for use plus on order — lasts under 70 days at the 90-day pace.
      const selling = live.filter((p) => !p.is_obsolete && here.has(p.sku) && (pace[market].get(p.sku) ?? 0) > 0);
      const days = (sku: string) => (here.get(sku)!.available + here.get(sku)!.onOrder) / pace[market].get(sku)!;
      for (const [key, inGroup] of Object.entries(DOI_GROUP)) if (keys.has(key)) put(key, market, thisColumn, selling.filter((p) => inGroup(p) && days(p.sku) < DOI_DAYS).length);
      if (keys.has("ops_inventory_excess") || keys.has("ops_obsolete_value")) {
        const costs = await t.costsBySku(odoo, COMPANY[market], live.map((p) => p.sku));
        let excess = 0;
        let obsolete = 0;
        for (const p of live) {
          const s = here.get(p.sku);
          const cost = costs.get(p.sku);
          // What is on hand, finished, at Odoo's average cost — not what could still be built from components.
          if (!s || s.onHand <= 0 || cost == null) continue;
          if (p.is_obsolete) obsolete += s.onHand * cost;
          // Sinks and faucets: the units beyond 180 days of sales; one that sold nothing in 90 days counts whole.
          else if (SINK.test(p.category) || FAUCET.test(p.category)) excess += Math.max(0, s.onHand - (pace[market].get(p.sku) ?? 0) * EXCESS_DAYS) * cost;
        }
        put("ops_inventory_excess", market, thisColumn, t.round2(excess));
        put("ops_obsolete_value", market, thisColumn, t.round2(obsolete));
        diag[`costs_${market}`] = costs.size;
      }
    }
  }

  // ---- Odoo's own days of inventory of single SKUs (today) ------------------------
  if (loop.includes(thisColumn) && has(Object.keys(SINGLE_SKU))) {
    const houses = await odoo("stock.warehouse", "search_read", [[["code", "in", Object.values(WAREHOUSE)]]], { fields: ["code", "company_id"] }) as { id: number; code: string; company_id: [number, string] }[];
    for (const market of marketsOf(Object.keys(SINGLE_SKU))) {
      const house = houses.find((w) => w.code === WAREHOUSE[market] && w.company_id?.[0] === COMPANY[market]);
      if (!house) { diag.noWarehouse = WAREHOUSE[market]; continue; }
      // The replenishment report's own numbers, read as on its screen: one warehouse, both companies allowed.
      const read = await odoo("product.product", "search_read", [[["default_code", "in", Object.values(SINGLE_SKU)]]], { fields: ["default_code", "velocity", "doi_on_hand_transit"], context: { warehouse_id: house.id, allowed_company_ids: [COMPANY[market], COMPANY[market === "ca" ? "us" : "ca"]] } }) as { default_code: string; velocity: number; doi_on_hand_transit: number }[];
      for (const [key, sku] of Object.entries(SINGLE_SKU)) {
        const p = read.find((x) => x.default_code === sku);
        if (p && Number(p.velocity) > 0) put(key, market, thisColumn, Math.round(Number(p.doi_on_hand_transit)));
      }
    }
  }

  // ---- every order of the country (Odoo) --------------------------------------------
  if (has(ORDER_KEYS)) {
    const skuSet = new Set(products.map((p) => p.sku));
    const lowerSku = new Map(products.map((p) => [p.sku.toLowerCase(), p.sku]));
    const skuOf = (code: string | null) => (code == null ? null : skuSet.has(code) ? code : lowerSku.get(code.toLowerCase()) ?? null);
    const windowFrom = t.addDays(oldest, -63); // 8 weeks before the oldest data week (average sales), 4 for returns over sales
    const fx = keys.has("ops_returns_over_sales") && rows.some((r) => r.auto_key === "ops_returns_over_sales" && r.market == null) ? await t.usdPerUnit(odoo, COMPANY.ca) : null;
    const back: Partial<Record<Market, { returned: Map<string, number>; sold: Map<string, number> }>> = {}; // per column, the 4-week sums
    for (const market of marketsOf(ORDER_KEYS)) {
      const company = COMPANY[market];
      const when = [["date_order", ">=", t.etMidnightUtc(windowFrom)], ["date_order", "<", t.etMidnightUtc(newest)]];
      const raw = await odoo("sale.order", "search_read", [[["company_id", "=", company], ["state", "in", ["sale", "done", "cancel"]], ...when]], { fields: ["date_order", "state", "currency_rate", "marketplace_name"] }) as { id: number; date_order: string; state: string; currency_rate: number; marketplace_name: [number, string] | false }[];
      const rate = new Map(raw.map((o) => [o.id, Number(o.currency_rate) || 1]));
      const orders: OrderRow[] = raw.map((o) => ({ id: o.id, date: t.isoOf(o.date_order), state: o.state, mp: o.marketplace_name ? o.marketplace_name[0] : null }));
      const rawLines = await odoo("sale.order.line", "search_read", [[["order_id.company_id", "=", company], ["order_id.state", "in", ["sale", "done"]], ...when.map((leaf) => [`order_id.${leaf[0]}`, leaf[1], leaf[2]]), ["display_type", "=", false], ["is_delivery", "=", false]]], { fields: ["order_id", "product_id", "product_uom_qty", "price_subtotal"] }) as { order_id: [number, string]; product_id: [number, string] | false; product_uom_qty: number; price_subtotal: number }[];
      const productIds = [...new Set(rawLines.map((l) => (l.product_id ? l.product_id[0] : 0)).filter(Boolean))];
      const code = new Map<number, string | null>();
      const service = new Set<number>();
      for (let i = 0; i < productIds.length; i += 400) {
        for (const p of await odoo("product.product", "read", [productIds.slice(i, i + 400)], { fields: ["default_code", "type"] }) as { id: number; default_code: string | false; type: string }[]) {
          code.set(p.id, p.default_code || null);
          if (p.type === "service") service.add(p.id);
        }
      }
      // In the company's currency: an order's own can differ (Wayfair Canada pays in USD).
      const lines: LineRow[] = rawLines.map((l) => {
        const pid = l.product_id ? l.product_id[0] : null;
        return { orderId: l.order_id[0], code: pid ? code.get(pid) ?? null : null, qty: Number(l.product_uom_qty) || 0, subtotal: (Number(l.price_subtotal) || 0) / (rate.get(l.order_id[0]) ?? 1), goods: pid != null && !service.has(pid) };
      });
      diag[`orders_${market}`] = orders.length;
      diag[`lines_${market}`] = lines.length;
      const orderOf = new Map(orders.map((o) => [o.id, o]));
      const orderDate = new Map(orders.map((o) => [o.id, o.date]));
      // A sale: a product sold with a price, on a real marketplace (not a warranty claim, a missing or wrong item sent again, a review unit).
      const real = (o: OrderRow) => o.state !== "cancel" && !(o.mp != null && NOT_A_SALE.has(o.mp));
      const sale = (l: LineRow) => l.goods && l.qty > 0 && l.subtotal > 0 && real(orderOf.get(l.orderId)!);
      const sales = lines.filter((l) => orderOf.has(l.orderId) && sale(l));

      const returns = keys.has("ops_returns_over_sales") ? await t.receivedReturns(odoo, [["sale_id.company_id", "=", company]], t.addDays(oldest, -35)) : null;
      if (returns) diag[`returns_${market}`] = returns.length;
      back[market] = { returned: new Map(), sold: new Map() };

      for (const column of loop) {
        const from = dataFrom(column);
        const week = orders.filter((o) => inDays(o.date, from, column));
        const weekIds = new Set(week.map((o) => o.id));
        // Open Box: what the -OB products sold for, before tax.
        put("ops_open_box_sales", market, column, t.round2(sales.filter((l) => weekIds.has(l.orderId) && /-OB/i.test(l.code ?? "")).reduce((s, l) => s + l.subtotal, 0)));
        // Shipment errors: the orders Odoo holds as "Wrong Items" or "Missing Items".
        put("ops_shipment_errors", market, column, week.filter((o) => o.state !== "cancel" && (o.mp === MP.wrong || o.mp === MP.missing)).length);
        if (returns) {
          // Over the 4 weeks ending with the data week (bodega validates returns in batches): the value of the goods back ÷ what was sold.
          const start = t.addDays(column, -28);
          const returned = returns.filter((r) => inDays(r.at, start, column)).reduce((s, r) => s + r.value, 0);
          const sold = sales.filter((l) => inDays(orderDate.get(l.orderId)!, start, column)).reduce((s, l) => s + l.subtotal, 0);
          put("ops_returns_over_sales", market, column, t.ratio(returned, sold));
          back[market]!.returned.set(column, returned);
          back[market]!.sold.set(column, sold);
        }
      }

      // Assembled products at 0 units now: their average weekly sales of the 8 weeks before the data week.
      if (keys.has("ops_oos_assembly_loss") && loop.includes(thisColumn) && rows.some((r) => r.auto_key === "ops_oos_assembly_loss" && r.market === market)) {
        const from = dataFrom(thisColumn);
        const assembled = new Set<string>();
        const skus = live.map((p) => p.sku);
        for (let i = 0; i < skus.length; i += 400) {
          for (const p of await odoo("product.product", "search_read", [[["default_code", "in", skus.slice(i, i + 400)]]], { fields: ["default_code", "bom_count"] }) as { default_code: string; bom_count: number }[]) if (Number(p.bom_count) > 0) assembled.add(p.default_code);
        }
        const bySku = new Map<string, number>();
        for (const l of sales) {
          const sku = skuOf(l.code);
          if (sku && inDays(orderDate.get(l.orderId)!, t.addDays(from, -56), from)) bySku.set(sku, (bySku.get(sku) ?? 0) + l.subtotal);
        }
        let loss = 0;
        const out: string[] = [];
        for (const [sku, s] of stock[market]) if (s.available <= 0 && assembled.has(sku) && bySku.get(sku)) { loss += bySku.get(sku)! / 8; out.push(sku); }
        put("ops_oos_assembly_loss", market, thisColumn, t.round2(loss));
        diag[`oosAssembled_${market}`] = out.join(", ");
      }
    }
    // Both countries together, in USD (Canada's at Odoo's rate of today).
    if (fx != null && back.ca && back.us) {
      for (const column of loop) {
        const returned = (back.ca.returned.get(column) ?? 0) * fx + (back.us.returned.get(column) ?? 0);
        const sold = (back.ca.sold.get(column) ?? 0) * fx + (back.us.sold.get(column) ?? 0);
        put("ops_returns_over_sales", "", column, t.ratio(returned, sold));
      }
    }
  }

  // ---- the returns bodega received, and where the goods went (Odoo) ----------------
  if (has(RETURN_KEYS)) {
    const picks = await odoo("stock.picking", "search_read", [[["return_id", "!=", false], ["picking_type_code", "=", "incoming"], ["state", "=", "done"], ["date_done", ">=", sinceOdoo], ["picking_type_id.warehouse_id.code", "in", Object.values(WAREHOUSE)]]], { fields: ["date_done", "picking_type_id", "move_line_ids"] }) as { id: number; date_done: string; picking_type_id: [number, string]; move_line_ids: number[] }[];
    const lineIds = picks.flatMap((p) => p.move_line_ids ?? []);
    const moved: { picking_id: [number, string]; location_dest_id: [number, string]; quantity: number }[] = [];
    for (let i = 0; i < lineIds.length; i += 400) moved.push(...await odoo("stock.move.line", "read", [lineIds.slice(i, i + 400)], { fields: ["picking_id", "location_dest_id", "quantity"] }));
    const units = new Map<number, { stock: number; openBox: number }>();
    for (const l of moved) {
      const u = units.get(l.picking_id[0]) ?? { stock: 0, openBox: 0 };
      // Odoo's Open Box locations are CAN/OB/… and USA/OB/…; everything else is stock again.
      if (/\/OB(\/|$)|open box/i.test(l.location_dest_id?.[1] ?? "")) u.openBox += Number(l.quantity) || 0; else u.stock += Number(l.quantity) || 0;
      units.set(l.picking_id[0], u);
    }
    diag.returnPickings = picks.length;
    for (const column of loop) {
      for (const market of MARKETS) {
        const week = picks.filter((p) => marketOf(p.picking_type_id) === market && inDays(t.isoOf(p.date_done), dataFrom(column), column));
        put("ops_returns_processed", market, column, week.length);
        const stockUnits = week.reduce((s, p) => s + (units.get(p.id)?.stock ?? 0), 0);
        const openBox = week.reduce((s, p) => s + (units.get(p.id)?.openBox ?? 0), 0);
        put("ops_returns_to_stock", market, column, t.ratio(stockUnits, stockUnits + openBox));
        put("ops_returns_to_openbox", market, column, t.ratio(openBox, stockUnits + openBox));
      }
    }
  }

  // ---- what was assembled (Odoo's manufacturing orders) ------------------------------
  if (has(ASSEMBLY_KEYS)) {
    const made = await odoo("mrp.production", "search_read", [[["state", "=", "done"], ["date_finished", ">=", sinceOdoo], ["picking_type_id.warehouse_id.code", "in", Object.values(WAREHOUSE)]]], { fields: ["product_id", "product_qty", "date_finished", "picking_type_id"] }) as { product_id: [number, string]; product_qty: number; date_finished: string; picking_type_id: [number, string] }[];
    const ids = [...new Set(made.map((m) => m.product_id[0]))];
    const info = new Map<number, { code: string; sink: boolean }>();
    for (let i = 0; i < ids.length; i += 400) {
      for (const p of await odoo("product.product", "read", [ids.slice(i, i + 400)], { fields: ["default_code", "categ_id"] }) as { id: number; default_code: string | false; categ_id: [number, string] | false }[]) info.set(p.id, { code: p.default_code || "", sink: /sink/i.test(p.categ_id ? p.categ_id[1] : "") });
    }
    diag.manufacturingOrders = made.length;
    for (const column of loop) {
      for (const market of MARKETS) {
        const week = made.filter((m) => marketOf(m.picking_type_id) === market && inDays(t.isoOf(m.date_finished), dataFrom(column), column));
        const qty = (keep: (x: { code: string; sink: boolean }) => boolean) => week.reduce((s, m) => { const x = info.get(m.product_id[0]); return s + (x && keep(x) ? Number(m.product_qty) || 0 : 0); }, 0);
        put("ops_assembly_sinks", market, column, qty((x) => x.sink));
        put("ops_assembly_versa", market, column, qty((x) => x.code.startsWith("S-6")));
      }
    }
  }

  // ---- inventory counts (Odoo) -----------------------------------------------------
  // The week in progress at every run; a closed week only while it has no number yet (see ONCE above).
  if (has(COUNT_KEYS)) {
    const countRows = rows.filter((r) => ONCE.has(r.auto_key) && r.market && !String(r.id).startsWith("assume"));
    const { data: have, error } = countRows.length ? await admin.from("scorecard_values").select("metric_id").in("metric_id", countRows.map((r) => r.id)).eq("week_start", thisColumn) : { data: [], error: null };
    if (error) throw error;
    const stored = new Set((have ?? []).map((v: any) => v.metric_id));
    for (const market of marketsOf(COUNT_KEYS)) {
      for (const column of loop.filter((c) => c === runColumn || c === thisColumn)) {
        const mine = rows.filter((r) => ONCE.has(r.auto_key) && r.market === market);
        if (column === thisColumn && mine.every((r) => stored.has(r.id))) continue;
        const from = dataFrom(column);
        // The products whose last count falls in the week…
        const counted = await odoo("stock.quant", "read_group", [[["last_count_date", ">=", from], ["last_count_date", "<", column], ["location_id.usage", "=", "internal"], ["warehouse_id.code", "=", WAREHOUSE[market]]], ["product_id"], ["product_id"]], { lazy: false }) as unknown[];
        // …and those whose count moved the stock by more than 5 units.
        const adjusted = await odoo("stock.move", "search_read", [[["is_inventory", "=", true], ["state", "=", "done"], ["date", ">=", t.etMidnightUtc(from)], ["date", "<", t.etMidnightUtc(column)], "|", ["location_id.warehouse_id.code", "=", WAREHOUSE[market]], ["location_dest_id.warehouse_id.code", "=", WAREHOUSE[market]]]], { fields: ["product_id", "quantity"] }) as { product_id: [number, string]; quantity: number }[];
        const off = new Set(adjusted.filter((m) => Math.abs(Number(m.quantity) || 0) > 5).map((m) => m.product_id[0])).size;
        const closedAndStored = (r: Row) => column === thisColumn && stored.has(r.id);
        for (const r of mine) {
          if (closedAndStored(r)) continue;
          if (r.auto_key === "ops_cycle_count") put(r.auto_key, market, column, counted.length);
          else if (counted.length) put(r.auto_key, market, column, t.ratio(Math.max(0, counted.length - off), counted.length));
        }
      }
    }
  }

  const out: OpsOut[] = [];
  for (const column of loop) {
    for (const r of rows) {
      if (SNAPSHOT.has(r.auto_key) && column !== thisColumn) continue;
      const value = values.get(`${r.auto_key}|${r.market ?? ""}|${column}`);
      if (value == null) continue;
      out.push({ metricId: r.id, board: OPS_BOARD, market: r.market ?? "", name: r.name, key: r.auto_key, week: column, value, note: null });
    }
  }
  return out;
}
