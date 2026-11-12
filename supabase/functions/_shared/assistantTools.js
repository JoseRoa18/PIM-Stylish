// The in-app assistant's lookups — every one READ ONLY.
//
// Each lookup is a GET to the database's API carrying the session of the
// person asking (`ctx.token`), so the database's own rules decide what comes
// back: the assistant sees what that person may see, never more. Nothing in
// this file writes anything.
//
//   ctx = { url, apikey, token, today, guide, db, role, groups, saveAction, saveFile }
//     today = the Eastern day, YYYY-MM-DD; guide = the guide's pieces, read in
//     memory by search_guide / read_guide; db = a supabase-js client carrying
//     the same session (the Price Alignment report reads through it);
//     role = the person's role; groups = the restricted topics they may read
//     (['company'] for the ScoreCard Company tab's viewers); saveAction =
//     (proposal) => id — keeps a change the assistant PROPOSES. The assistant
//     never makes it: the person confirms it on the page, which saves it
//     through the app's own code. saveFile = (file) => id — keeps the
//     description of an Excel file the assistant PREPARES (create_excel): the
//     person downloads it from a card, and the page reads its rows then, with
//     their own session (assistantExcel.js).
//
// Used by the `assistant` edge function (deploy this file with it, and
// assistantTables.js, assistantExcel.js, assistantTurn.js, promoCalendar.ts). The definitions are
// part of what the model is sent first and cached: changing a name, a
// description or a schema is paid once, and conversations started before it
// lose the reasoning they kept.
import { ASSISTANT_TABLES } from "./assistantTables.js";
import { checkExcelSpec, EXCEL_FORMATS, EXCEL_LIMITS, loadExcelSheet, SpecError, tableRead } from "./assistantExcel.js";
import { promoWindow, PROMO_DATE_COLUMNS } from "./promoCalendar.ts";
import { completenessContext, inCompleteness, scoreCompleteness } from "./completeness.js";
import { buildListingHealthData, MARKETPLACES } from "./listingHealth.js";
import { alignTargets, createPriceAlignment } from "./priceAlignmentReport.js";
import { alignmentSummary } from "./alignmentSummary.js";
import { WIX_SITES } from "./wixSites.ts";

const TABLE_NAMES = Object.keys(ASSISTANT_TABLES);

/** A lookup that cannot run as asked: its message goes back to the model, which tries again. */
export class ToolError extends Error {}

// eager_input_streaming: inputs arrive as they are written and are NOT checked
// by the API, so each one is checked against its schema (inputProblem) before
// it runs.
export const ASSISTANT_TOOLS = [
  {
    name: "search_guide",
    description:
      "Search the app's guide — the internal documentation of how every part of the PIM works and each rule the team has decided — and get the best-matching pieces in full. Call this before answering any question about how something works, why the app does something, what a rule is, where in the app something is done or what a number means, and whenever you would otherwise explain a behaviour from an index line alone. The guide is in English: search with English words, the way the app names things (\"Back to Blue Wayfair price change\", \"obsolete mark\", \"Best Buy stock sync\").",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A few English words that name the topic." },
        max_pieces: { type: "integer", description: "How many pieces to return in full. Default 3, at most 6." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_guide",
    description:
      "Read pieces of the app's guide by their id from <guide_index> (for example \"11.47\"). Use it when the index already shows which pieces a question needs; several ids can go in one call.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" }, description: "Ids from <guide_index>, e.g. [\"8.3\", \"8.13\"]. At most 8." } },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "find_products",
    description:
      "Find products by words: a SKU or part of one, a model name, a series, a product type, a material, a finish or color, or words of the title. Call this first whenever the person names a product loosely (\"the black 30 inch workstation sink\", \"asti\") or you are not sure of the exact SKU. Every word must match somewhere. Returns each product's SKU, model name, brand, category, type, finish, color, status, obsolete mark, MAP Blue CAD / USD and title, plus how many matched in all.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Words to look for, e.g. \"K-131\" or \"pull down matte black\"." },
        brand: { type: "string", enum: ["Stylish", "Azuni"] },
        category: { type: "string", description: "A products.category value from <database>, e.g. kitchen_sink." },
        include_obsolete: { type: "boolean", description: "Default true. false leaves obsolete products out." },
        limit: { type: "integer", description: "Default 20, at most 50." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "product_details",
    description:
      "Everything the PIM holds about ONE product, by its exact SKU: its fields and attributes, prices and costs at every level, the family's other variants, a summary of its images / videos / documents, its ids on the marketplaces (aliases, Amazon, Wix), stock and arrival date per market, units sold in 30 / 90 days per marketplace, its Where to Buy links with their last check, and the promotions it is in. Call this whenever a question is about a single product. Use find_products first if you do not have the exact SKU. The long texts (descriptions, bullets, keywords, care and warranty texts) come back only as their lengths unless include_content is true.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "The exact SKU, e.g. S-611W." },
        include_content: { type: "boolean", description: "true adds the long texts in full: descriptions, bullets, keywords, marketing copy, care and warranty texts (EN and FR). Ask for it only when the question is about that wording." },
      },
      required: ["sku"],
      additionalProperties: false,
    },
  },
  {
    name: "sales_overview",
    description:
      "Units sold in the last 30 and 90 days (from Odoo, refreshed every 3 hours): totals per market, totals per marketplace, and a ranking of products with their stock and how long it lasts at the 90-day pace. Call this for any question about what sells, best or worst sellers, sales by marketplace, or how long the stock of given products will last. Give `skus` to get those products' own numbers by marketplace. A product that sold nothing in 90 days has no numbers here.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        market: { type: "string", enum: ["ca", "us"], description: "Canada or USA. Leave out for both." },
        skus: { type: "array", items: { type: "string" }, description: "Only these products (exact SKUs)." },
        days: { type: "integer", enum: [30, 90], description: "The window the ranking is sorted by. Default 90." },
        top: { type: "integer", description: "How many products in the ranking. Default 10, at most 50." },
        sort: { type: "string", enum: ["most", "least"], description: "most = best sellers first (default); least = the slowest among the products that sold." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "promotions_overview",
    description:
      "Promotions with their real dates per country and whether each is running, upcoming or ended TODAY (monthly promotions follow each country's calendar or their own dates; flash deals, MK events and Peak Season events their dates and portals). Call this for any question about what promotion is running or coming, a promotion's dates, how many products it has, or a product's promotion price. Without arguments it lists what is running and upcoming. `promotion_id` adds that promotion's products with their promotion prices per market; `sku` keeps only the promotions that product is in.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        when: { type: "string", enum: ["current", "running", "upcoming", "ended", "all"], description: "current = running + upcoming (default)." },
        kind: { type: "string", enum: ["monthly", "flash", "mk_event", "special"], description: "special = Peak Season events." },
        promotion_id: { type: "integer", description: "One promotion, with its products." },
        sku: { type: "string", description: "Only promotions that include this exact SKU, with its prices." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "listing_health",
    description:
      "What one product is missing, by its exact SKU: its PIM completeness (score, and every mandatory field that is empty or wrong, with the tab and section of the product page where it is filled) and its Listing Health on each connected store (Sinks Direct Canada / USA, Stylish Canada / USA, Azuni, Wayfair Canada / USA, Best Buy, Walmart Canada / USA): the score, whether it is listed there, and the checks that fail. These are the app's own rules, computed now. Call this for \"what is this product missing\", \"why is its score low\", \"is it ready for <store>\". Without a SKU it returns the latest snapshot's counters per channel.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { sku: { type: "string", description: "The exact SKU. Leave out for the per-channel counters." } },
      additionalProperties: false,
    },
  },
  {
    name: "price_alignment",
    description:
      "Price Alignment as the Pricing page computes it: the price each store SHOULD show today (the MAP or the MSRP of that store, or the promotion or deal running on it) against the price it shows. Without arguments: every store with its % aligned and its counts. With `store`: that store's summary and its problems (promo missing, misaligned, no price in the PIM). With `sku`: that product on every store — expected price, live price, and whether they agree. Call this for any question about whether prices are right on a marketplace, what a product should cost on a store today, or which products are off. A difference within the margin (±10 from 200, ±5 under) counts as aligned.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        store: { type: "string", description: "A store's key or name, e.g. bestbuy, wayfair_ca, \"Sinks Direct USA\", \"Home Depot Canada\"." },
        sku: { type: "string", description: "One exact SKU, looked up on every store (or on `store`)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "propose_action",
    description:
      "Prepare a change for the person to confirm. Calling this changes NOTHING: the page shows them a card with what would change, and the change is made only if they press Confirm. So never say a change is done — say it is ready for them to confirm, and what the card shows. Two kinds exist: set_obsolete (mark products obsolete, or take the mark off) and set_prices (a product's MAP Blue / Orange / Purple or MSRP, in CAD or USD). Anything else cannot be changed from the chat: say where in the app it is done. Call this only when the person asks for the change, with exact SKUs (look them up first).",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["set_obsolete", "set_prices"] },
        skus: { type: "array", items: { type: "string" }, description: "set_obsolete: the exact SKUs, at most 50." },
        obsolete: { type: "boolean", description: "set_obsolete: true marks them obsolete, false takes the mark off." },
        prices: { type: "array", items: { type: "string" }, description: "set_prices: one \"SKU | field | new price\" per change, e.g. \"S-611W | map_cad | 800\". Fields: map_cad, map_usd (Blue), map_orange_cad, map_orange_usd, map_purple_cad, map_purple_usd, msrp_cad, msrp_usd. At most 50." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "query_table",
    description:
      `Read rows from one of the PIM's tables (listed with their columns in <database>). Use it for anything the other tools do not cover: stock (product_inventory), the Activity Log (audit_log), the ScoreCard (scorecard_metrics, then scorecard_values by metric_id), Where to Buy links, documents and images, product history, coupons, what waits for Odoo. It follows PostgREST: \`select\` is a comma list of columns, a JSON field is \`attributes->>upc\` and can be renamed (\`upc:attributes->>upc\`), and a related table can be embedded (\`promotions(name,kind)\`). Each filter is "column=operator.value" with eq, neq, gt, gte, lt, lte, like / ilike (\`*\` is the wildcard), in.(a,b), is.null, not.is.null, cs.{a} for arrays; several filters are ANDed, and "or=(a.eq.1,b.eq.2)" is one filter. Rows come back with \`total\` = how many match in all. For "how many" pass count_only; to count or add up by a column pass group_by and / or sum (they read every matching row and return one line per group). Never select "*". Tables: ${TABLE_NAMES.join(", ")}.`,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", enum: TABLE_NAMES },
        select: { type: "string", description: "Columns to return, e.g. \"sku,model_name,upc:attributes->>upc\". Required unless count_only." },
        filters: { type: "array", items: { type: "string" }, description: "e.g. [\"brand=eq.Stylish\", \"map_cad=gte.500\", \"attributes->>upc=is.null\", \"or=(sku.ilike.*K-13*,model_name.ilike.*asti*)\"]" },
        order: { type: "string", description: "e.g. \"occurred_at.desc\" or \"market.asc,available.desc\"." },
        limit: { type: "integer", description: "Rows to return. Default 50, at most 500." },
        count_only: { type: "boolean", description: "Return only how many rows match." },
        group_by: { type: "array", items: { type: "string" }, description: "Columns (or aliases given in select) to group by; returns a count per group." },
        sum: { type: "array", items: { type: "string" }, description: "Numeric columns (or aliases given in select) to add up, per group or over all rows." },
      },
      required: ["table"],
      additionalProperties: false,
    },
  },
  {
    name: "create_excel",
    description:
      `Prepare an Excel file (.xlsx) for the person to download: a card with a Download button appears in the chat. Call it when they ask for an Excel, a spreadsheet, a file or something to download, and offer it instead of writing a table longer than about 30 rows. Each sheet is one of two kinds. (1) READ FROM A TABLE — give \`table\`, \`select\`, \`filters\` and \`order\` exactly as in query_table. The app reads EVERY matching row itself when the person downloads (up to ${EXCEL_LIMITS.queryRows}), with their own permissions: you never copy the rows, and the file can be far longer than what you can read. A related table can be embedded and its fields become columns named "alias.field": from a table that has a sku to its product, \`products(model_name,brand)\` gives products.model_name and products.brand; from products to a table with several rows per product, give it an alias and filter it down to one row — \`ca:product_inventory(available,eta)\` with the filter "ca.market=eq.ca" gives ca.available and ca.eta (and \`us:product_inventory(available)\` with "us.market=eq.us" beside it). A JSON column opens the same way (warehouses.CBG.on_order, channels.Wayfair.u90). (2) TYPED BY YOU — give \`rows\`: a short table you worked out from other lookups (a summary, a comparison, what price_alignment or sales_overview returned), at most ${EXCEL_LIMITS.typedRows} rows. The result gives each sheet's row count and first rows, or says what to fix: read it before you answer. When you are not sure a query is right, try it with query_table first. Only Excel can be made: no Word, PDF or PowerPoint.`,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The file's title: shown on the card and used as the file's name, e.g. \"Azuni products — prices and stock\". Leave the date out (it is added)." },
        sheets: {
          type: "array",
          description: `The file's sheets, in order (at most ${EXCEL_LIMITS.sheets}).`,
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "The sheet's tab name, at most 31 characters." },
              table: { type: "string", enum: TABLE_NAMES, description: "A sheet read from the PIM: the table, as in query_table. Leave out for a typed sheet." },
              select: { type: "string", description: "A sheet read from the PIM: the columns, as in query_table, e.g. \"sku,model_name,upc:attributes->>upc,map_cad,ca:product_inventory(available,eta)\"." },
              filters: { type: "array", items: { type: "string" }, description: "A sheet read from the PIM: its filters, as in query_table, e.g. [\"brand=eq.Azuni\", \"ca.market=eq.ca\"]." },
              order: { type: "string", description: "A sheet read from the PIM: its order, e.g. \"category.asc,sku.asc\"." },
              columns: {
                type: "array",
                description: "The sheet's columns, in the order they appear. Read from the PIM: each has `key` — the data's name: a selected column or its alias (sku, upc), or \"alias.field\" for an embedded table or a JSON field — and `header`, its title in the file; leave `columns` out to get every selected column under a title made from its name. Typed: each has `header`, one per cell of the rows.",
                items: {
                  type: "object",
                  properties: {
                    key: { type: "string", description: "Read from the PIM only: the data's name." },
                    header: { type: "string", description: "The column's title in the file." },
                    format: { type: "string", enum: EXCEL_FORMATS, description: "text (default) · number · money · percent (the value is a fraction: 0.95 shows as 95%) · date · datetime · link (a clickable address). Dates and times are shown on Eastern time." },
                  },
                  additionalProperties: false,
                },
              },
              rows: {
                type: "array",
                description: "A typed sheet's rows: each one a list of cells in the columns' order.",
                items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
              },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "sheets"],
      additionalProperties: false,
    },
  },
];

/** A tool input against its schema (the subset the schemas above use). Returns the problem, or null. */
export function inputProblem(schema, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "The input must be an object.";
  for (const key of schema.required ?? []) if (input[key] === undefined || input[key] === null) return `"${key}" is required.`;
  for (const [key, value] of Object.entries(input)) {
    const prop = schema.properties?.[key];
    if (!prop) return `"${key}" is not a parameter of this tool.`;
    if (value === null || value === undefined) continue;
    if (prop.type === "string" && typeof value !== "string") return `"${key}" must be text.`;
    if (prop.type === "integer" && !(typeof value === "number" && Number.isInteger(value))) return `"${key}" must be a whole number.`;
    if (prop.type === "boolean" && typeof value !== "boolean") return `"${key}" must be true or false.`;
    if (prop.type === "array") {
      // a list of objects (create_excel's sheets) is checked in depth by its own tool
      if (prop.items?.type === "object") {
        if (!(Array.isArray(value) && value.every((v) => v && typeof v === "object" && !Array.isArray(v)))) return `"${key}" must be a list of objects.`;
      } else if (!(Array.isArray(value) && value.every((v) => typeof v === "string"))) return `"${key}" must be a list of text values.`;
    }
    if (prop.enum && !prop.enum.includes(value)) return `"${key}" must be one of: ${prop.enum.join(", ")}.`;
  }
  return null;
}

/** What the page shows while a lookup runs. */
export function toolLabel(name, input) {
  if (name === "search_guide") return `Reading the guide: ${String(input?.query ?? "").slice(0, 60)}`;
  if (name === "read_guide") return "Reading the guide";
  if (name === "find_products") return `Searching products: ${String(input?.text ?? "").slice(0, 60)}`;
  if (name === "product_details") return `Reading ${String(input?.sku ?? "a product").slice(0, 40)}`;
  if (name === "sales_overview") return "Reading sales";
  if (name === "promotions_overview") return "Reading promotions";
  if (name === "listing_health") return input?.sku ? `Checking what ${String(input.sku).slice(0, 40)} is missing` : "Reading Listing Health";
  if (name === "price_alignment") return `Reading Price Alignment${input?.store ? `: ${String(input.store).slice(0, 40)}` : ""}`;
  if (name === "propose_action") return "Preparing a change to confirm";
  if (name === "query_table") return `Reading ${String(input?.table ?? "data").replace(/_/g, " ")}`;
  if (name === "create_excel") return `Preparing an Excel file${input?.title ? `: ${String(input.title).slice(0, 50)}` : ""}`;
  return name;
}

// ── Reading the database as the person asking ───────────────────────────────
const headersOf = (ctx, extra = {}) => ({ apikey: ctx.apikey, Authorization: `Bearer ${ctx.token}`, ...extra });
const totalOf = (res) => {
  const range = res.headers.get("content-range") ?? "";
  return /\/(\d+)$/.test(range) ? Number(range.split("/")[1]) : null;
};

export async function rest(ctx, path, { count = false } = {}) {
  const res = await fetch(`${ctx.url}/rest/v1/${path}`, { headers: headersOf(ctx, count ? { Prefer: "count=exact" } : {}) });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const j = JSON.parse(text);
      message = [j.message, j.details, j.hint].filter(Boolean).join(" — ");
    } catch { /* raw text */ }
    throw new ToolError(`The database refused this read (${res.status}): ${message.slice(0, 400)}`);
  }
  return { rows: JSON.parse(text), total: totalOf(res) };
}

/** How many rows match (no row is read). A refused count is asked again as a read, for the database's reason. */
async function restCount(ctx, path) {
  const res = await fetch(`${ctx.url}/rest/v1/${path}`, { method: "HEAD", headers: headersOf(ctx, { Prefer: "count=exact" }) });
  if (!res.ok) {
    await rest(ctx, `${path}${path.endsWith("?") ? "" : "&"}limit=1`);
    throw new ToolError(`The database refused this count (${res.status}).`);
  }
  return totalOf(res);
}

/** Every matching row, 1,000 at a time (the API's page size), up to `cap`. */
export async function restAll(ctx, path, cap = 20000) {
  const out = [];
  for (let from = 0; from < cap; from += 1000) {
    const { rows } = await rest(ctx, `${path}&limit=1000&offset=${from}`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const q = (v) => encodeURIComponent(v);
/** A value inside in.(…) or a logic tree — quoted so a comma, a dot or a parenthesis in it is data. (A plain "column=eq.value" takes its value as it is.) */
const lit = (v) => `"${String(v).replace(/[\\"]/g, "")}"`;

// Long cells are cut so one row cannot flood the answer.
function trimCell(value) {
  if (typeof value === "string") return value.length > 1500 ? `${value.slice(0, 1500)}… (+${value.length - 1500} characters)` : value;
  if (value && typeof value === "object") {
    const s = JSON.stringify(value);
    return s.length > 3000 ? `${s.slice(0, 3000)}… (+${s.length - 3000} characters of JSON)` : value;
  }
  return value;
}
const trimRow = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, trimCell(v)]));

/** Rows that fit the answer's budget, and whether some were left out. */
function fitRows(rows, budget = 40000) {
  const out = [];
  let used = 0;
  for (const row of rows) {
    const r = trimRow(row);
    used += JSON.stringify(r).length;
    if (used > budget && out.length) return { rows: out, cut: true };
    out.push(r);
  }
  return { rows: out, cut: false };
}

const stripHtml = (html) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// ── query_table ─────────────────────────────────────────────────────────────
// What a read may ask for (the readable tables, no "*", no hidden column) is
// tableRead() in assistantExcel.js: the same rules for this lookup and for an
// Excel sheet read from a table.
async function queryTable(ctx, input) {
  const table = input.table;
  if (!(table in ASSISTANT_TABLES)) throw new ToolError(`"${table}" is not one of the readable tables.`);
  const countOnly = input.count_only === true;
  const groupBy = input.group_by ?? [];
  const sum = input.sum ?? [];
  const grouped = groupBy.length > 0 || sum.length > 0;

  let select = String(input.select ?? "").trim();
  if (!select && grouped) select = [...new Set([...groupBy, ...sum])].join(",");
  if (!select && !countOnly) throw new ToolError("Give `select`: the columns you need.");
  const { params, base } = tableRead({ table, select, filters: input.filters ?? [], order: input.order ?? "" });

  if (countOnly) return { table, count: await restCount(ctx, `${table}?${params.join("&")}`) };

  if (grouped) {
    const rows = await restAll(ctx, base);
    for (const key of [...groupBy, ...sum]) {
      if (rows.length && !(key in rows[0])) throw new ToolError(`"${key}" is not among the selected columns (${Object.keys(rows[0]).join(", ")}). Select it, or use its alias.`);
    }
    const groups = new Map();
    for (const row of rows) {
      const id = JSON.stringify(groupBy.map((k) => row[k]));
      let g = groups.get(id);
      if (!g) {
        g = { ...Object.fromEntries(groupBy.map((k) => [k, row[k]])), count: 0, ...Object.fromEntries(sum.map((s) => [`sum_${s}`, 0])) };
        groups.set(id, g);
      }
      g.count += 1;
      for (const s of sum) {
        const n = Number(row[s]);
        if (Number.isFinite(n)) g[`sum_${s}`] += n;
      }
    }
    const by = sum.length ? `sum_${sum[0]}` : "count";
    const list = [...groups.values()].sort((a, b) => b[by] - a[by]);
    for (const g of list) for (const s of sum) g[`sum_${s}`] = Math.round(g[`sum_${s}`] * 100) / 100;
    return { table, rows_read: rows.length, groups: list.slice(0, 300), ...(list.length > 300 ? { note: `${list.length} groups in all; the first 300 are shown.` } : {}) };
  }

  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 500);
  const { rows, total } = await rest(ctx, `${base}&limit=${limit}`, { count: true });
  const fit = fitRows(rows);
  return {
    table,
    total,
    returned: fit.rows.length,
    ...(fit.cut ? { note: "The rows were too long to show all of them: select fewer columns or filter more." } : total !== null && total > fit.rows.length ? { note: `Showing ${fit.rows.length} of ${total}.` } : {}),
    rows: fit.rows,
  };
}

// ── find_products ───────────────────────────────────────────────────────────
const SEARCH_COLUMNS = ["sku", "model_name", "series", "product_type", "material", "finish", "color", "attributes->>general_title_en"];
const PRODUCT_LINE = "sku,model_name,brand,category,product_type,finish,color,workflow_status,is_obsolete,map_cad,map_usd,title:attributes->>general_title_en";

async function findProducts(ctx, input) {
  const words = String(input.text ?? "").split(/\s+/).map((w) => w.replace(/[\\"(),*%]/g, "")).filter(Boolean).slice(0, 6);
  if (!words.length) throw new ToolError("Give at least one word to look for.");
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
  const every = words.map((w) => `or(${SEARCH_COLUMNS.map((c) => `${c}.ilike."*${w}*"`).join(",")})`).join(",");
  const params = [`select=${q(PRODUCT_LINE)}`, `and=${q(`(${every})`)}`, "order=sku", `limit=${limit}`];
  if (input.brand) params.push(`brand=eq.${q(input.brand)}`);
  if (input.category) params.push(`category=eq.${q(input.category)}`);
  if (input.include_obsolete === false) params.push("is_obsolete=is.false");
  const { rows, total } = await rest(ctx, `products?${params.join("&")}`, { count: true });
  // an exact SKU goes first
  const exact = words.join(" ").toLowerCase();
  rows.sort((a, b) => Number(b.sku.toLowerCase() === exact) - Number(a.sku.toLowerCase() === exact));
  return { total, returned: rows.length, products: rows };
}

// ── promotions ──────────────────────────────────────────────────────────────
const PROMO_COLUMNS = `id,name,kind,period,status,marketplaces,created_at,ended_at,stylish_discount,${PROMO_DATE_COLUMNS}`;

/** A promotion's dates per market and whether it runs today (by its dates; only "ended" is over early). */
function promoState(promo, today) {
  const markets = {};
  for (const market of ["ca", "us"]) {
    const w = promoWindow(promo, market);
    const state = promo.status === "ended" ? "ended" : today < w.start ? "upcoming" : today > w.end ? "ended" : "running";
    markets[market] = { start: w.start, end: w.end, state, ...(w.custom ? { own_dates: true } : {}) };
  }
  const states = Object.values(markets).map((m) => m.state);
  const state = states.includes("running") ? "running" : states.includes("upcoming") ? "upcoming" : "ended";
  return { state, markets };
}

// A monthly promotion has its own dates and its own list per country; a deal
// (flash, MK event, Peak Season) has one pair of dates and runs on its portals.
function promoLine(promo, today) {
  const { state, markets } = promoState(promo, today);
  const monthly = (promo.kind ?? "monthly") === "monthly";
  return {
    id: promo.id,
    name: promo.name,
    kind: promo.kind,
    status_in_pim: promo.status,
    state_today: state,
    ...(monthly
      ? { month: String(promo.period).slice(0, 7), canada: markets.ca, usa: markets.us }
      : { starts: markets.ca.start, ends: markets.ca.end, portals: promo.marketplaces ?? [] }),
    ...(promo.ended_at ? { marked_ended_at: promo.ended_at } : {}),
    ...(promo.stylish_discount ? { stylish_discount: trimCell(promo.stylish_discount) } : {}),
  };
}
const promoStart = (line) => line.canada?.start ?? line.starts ?? "";

/** A product's place in a promotion: its list per country (monthly) and its promotion prices. */
function promoMember(line, row) {
  return {
    ...(line.kind === "monthly" ? { on_canada_list: row.in_ca, on_usa_list: row.in_us } : {}),
    promo_price_cad: row.promo_price_cad,
    promo_price_usd: row.promo_price_usd,
  };
}

export async function promotionsOverview(ctx, input) {
  const today = ctx.today;
  const { rows: all } = await rest(ctx, `promotions?select=${q(PROMO_COLUMNS)}&order=period.desc,id.desc`);
  let lines = all.map((p) => promoLine(p, today));
  if (input.kind) lines = lines.filter((p) => p.kind === input.kind);

  if (input.sku) {
    const sku = String(input.sku).trim();
    const rows = await restAll(ctx, `promotion_prices?select=promotion_id,in_ca,in_us,promo_price_cad,promo_price_usd&sku=eq.${q(sku)}`);
    const mine = new Map(rows.map((r) => [r.promotion_id, r]));
    lines = lines.filter((p) => mine.has(p.id)).map((p) => {
      return { ...p, product: { sku, ...promoMember(p, mine.get(p.id)) } };
    });
    if (!input.promotion_id && !input.when) return { today, sku, promotions: lines.slice(0, 40), ...(lines.length ? {} : { note: "This product is in no promotion." }) };
  }

  if (input.promotion_id) {
    const promo = lines.find((p) => p.id === input.promotion_id);
    if (!promo) return { today, note: `No promotion with id ${input.promotion_id}${input.sku ? " that includes this product" : ""}.` };
    const members = await restAll(ctx, `promotion_prices?select=sku,in_ca,in_us,promo_price_cad,promo_price_usd&promotion_id=eq.${input.promotion_id}&order=sku`);
    // one compact line per product
    if (promo.kind !== "monthly") {
      return {
        today,
        promotion: promo,
        products: members.length,
        columns: "sku | promo_price_cad | promo_price_usd (the price that applies is the one of each portal's country)",
        product_lines: members.map((m) => `${m.sku} | ${m.promo_price_cad ?? "no price"} | ${m.promo_price_usd ?? "no price"}`),
      };
    }
    return {
      today,
      promotion: promo,
      products_on_canada_list: members.filter((m) => m.in_ca).length,
      products_on_usa_list: members.filter((m) => m.in_us).length,
      without_canada_price: members.filter((m) => m.in_ca && m.promo_price_cad == null).map((m) => m.sku),
      without_usa_price: members.filter((m) => m.in_us && m.promo_price_usd == null).map((m) => m.sku),
      columns: "sku | promo_price_cad (\"-\" = not on Canada's list) | promo_price_usd (\"-\" = not on the USA's list)",
      product_lines: members.map((m) => `${m.sku} | ${m.in_ca ? m.promo_price_cad ?? "no price" : "-"} | ${m.in_us ? m.promo_price_usd ?? "no price" : "-"}`),
    };
  }

  const when = input.when ?? "current";
  if (when !== "all") lines = lines.filter((p) => (when === "current" ? p.state_today !== "ended" : p.state_today === when));
  lines = lines.slice(0, 40);
  if (lines.length && !input.sku) {
    const counts = await restAll(ctx, `promotion_prices?select=promotion_id,in_ca,in_us&promotion_id=in.(${lines.map((p) => p.id).join(",")})`);
    for (const p of lines) {
      const mine = counts.filter((c) => c.promotion_id === p.id);
      if (p.kind === "monthly") {
        p.products_on_canada_list = mine.filter((c) => c.in_ca).length;
        p.products_on_usa_list = mine.filter((c) => c.in_us).length;
      } else {
        p.products = mine.length;
      }
    }
  }
  return { today, showing: when, promotions: lines, ...(lines.length ? {} : { note: "No promotion matches." }) };
}

// ── sales ───────────────────────────────────────────────────────────────────
const MARKET_NAME = { ca: "Canada", us: "USA" };

/** How long the stock lasts at the 90-day pace, in days (null when nothing sold or not tracked). */
const stockLasts = (available, units90) => (available == null || !(units90 > 0) ? null : Math.round(available / (units90 / 90)));

async function salesOverview(ctx, input) {
  const skus = (input.skus ?? []).map((s) => s.trim()).filter(Boolean);
  const days = input.days === 30 ? 30 : 90;
  const field = days === 30 ? "units_30" : "units_90";
  const top = Math.min(Math.max(Number(input.top) || 10, 1), 50);
  const filters = [input.market ? `&market=eq.${input.market}` : "", skus.length ? `&sku=in.(${q(skus.map(lit).join(","))})` : ""].join("");
  const rows = await restAll(ctx, `product_sales?select=market,sku,units_30,units_90,channels,synced_at${filters}`);
  const markets = input.market ? [input.market] : ["ca", "us"];
  const out = { window: "last 30 and 90 days, from Odoo", as_of: rows.map((r) => r.synced_at).sort().at(-1) ?? null, markets: {} };

  const listed = new Set();
  const perMarket = {};
  for (const market of markets) {
    const mine = rows.filter((r) => r.market === market);
    const channels = {};
    for (const r of mine) {
      for (const [name, c] of Object.entries(r.channels ?? {})) {
        const t = (channels[name] ??= { units_30: 0, units_90: 0 });
        t.units_30 += Number(c?.u30) || 0;
        t.units_90 += Number(c?.u90) || 0;
      }
    }
    const ranked = [...mine].sort((a, b) => (input.sort === "least" ? a[field] - b[field] : b[field] - a[field]));
    perMarket[market] = skus.length ? mine : ranked.slice(0, top);
    for (const r of perMarket[market]) listed.add(r.sku);
    out.markets[market] = {
      market: MARKET_NAME[market],
      products_that_sold: mine.length,
      units_30: mine.reduce((s, r) => s + Number(r.units_30 || 0), 0),
      units_90: mine.reduce((s, r) => s + Number(r.units_90 || 0), 0),
      by_marketplace: Object.entries(channels).sort((a, b) => b[1].units_90 - a[1].units_90).map(([marketplace, t]) => ({ marketplace, ...t })),
    };
  }

  // names and stock of the products listed
  const names = new Map();
  const stock = new Map();
  const wanted = [...new Set([...listed, ...skus])];
  for (let i = 0; i < wanted.length; i += 150) {
    const part = q(wanted.slice(i, i + 150).map(lit).join(","));
    const [p, inv] = await Promise.all([
      rest(ctx, `products?select=sku,model_name&sku=in.(${part})`),
      rest(ctx, `product_inventory?select=market,sku,available,eta&sku=in.(${part})`),
    ]);
    for (const r of p.rows) names.set(r.sku, r.model_name);
    for (const r of inv.rows) stock.set(`${r.market}|${r.sku}`, r);
  }
  for (const market of markets) {
    out.markets[market][skus.length ? "products" : `${input.sort === "least" ? "slowest" : "top"}_${top}_by_${days}_days`] = perMarket[market].map((r) => {
      const inv = stock.get(`${market}|${r.sku}`);
      return {
        sku: r.sku,
        model: names.get(r.sku) ?? null,
        units_30: Number(r.units_30),
        units_90: Number(r.units_90),
        stock_available: inv ? inv.available : "not tracked",
        stock_lasts_days: stockLasts(inv?.available, Number(r.units_90)),
        ...(inv?.eta ? { next_arrival: inv.eta } : {}),
        ...(skus.length ? { by_marketplace: r.channels } : {}),
      };
    });
    if (skus.length) {
      const sold = new Set(perMarket[market].map((r) => r.sku));
      const none = skus.filter((s) => !sold.has(s));
      if (none.length) out.markets[market].sold_nothing_in_90_days = none;
    }
  }
  if (skus.length) {
    const unknown = skus.filter((s) => !names.has(s));
    if (unknown.length) out.not_in_the_pim = unknown;
  }
  return out;
}

// ── product_details ─────────────────────────────────────────────────────────
// Columns nothing reads any more (their values live in attributes) and raw copies.
const PRODUCT_DROP = ["wix_raw", "additional_info_sections", "upc", "hs_code", "country_of_origin", "manufacturer", "warranty", "wix_collection_ids"];

async function productDetails(ctx, input) {
  const asked = String(input.sku ?? "").trim();
  if (!asked) throw new ToolError("Give the SKU.");
  let { rows } = await rest(ctx, `products?select=*&sku=eq.${q(asked)}`);
  if (!rows.length) ({ rows } = await rest(ctx, `products?select=*&sku=ilike.${q(asked.replace(/[*%_]/g, ""))}&limit=2`));
  if (rows.length !== 1) {
    const near = await findProducts(ctx, { text: asked, limit: 8 }).catch(() => ({ products: [] }));
    return { found: false, note: `No product with the SKU "${asked}".`, similar: near.products };
  }
  const product = rows[0];
  const sku = product.sku;
  const eq = `sku=eq.${q(sku)}`;

  const [media, aliases, amazon, wix, inventory, sales, ownLinks, checks, promos, family] = await Promise.all([
    rest(ctx, `product_media?select=media_type,document_type,language,is_primary,image_role,file_name&${eq}&order=display_order`),
    rest(ctx, `product_aliases?select=marketplace,alias,kind&${eq}&order=marketplace`),
    rest(ctx, `amazon_links?select=marketplace,seller_sku,asin,status&${eq}`),
    rest(ctx, `wix_links?select=site,wix_product_id&${eq}`),
    rest(ctx, `product_inventory?select=market,available,on_hand,eta,warehouses,synced_at&${eq}`),
    rest(ctx, `product_sales?select=market,units_30,units_90,channels,synced_at&${eq}`),
    rest(ctx, `product_where_to_buy?select=retailer,url&${eq}&order=retailer`),
    rest(ctx, `where_to_buy_links?select=site,retailer,verdict,sku_check,in_stock,price,currency,checked_at&${eq}&order=retailer`),
    rest(ctx, `promotion_prices?select=promotion_id,in_ca,in_us,promo_price_cad,promo_price_usd,promotions(${PROMO_COLUMNS})&${eq}`),
    product.family_number != null
      ? rest(ctx, `products?select=sku,model_name,finish,color,is_obsolete&family_number=eq.${product.family_number}&sku=neq.${q(sku)}&order=sku`)
      : Promise.resolve({ rows: [], total: 0 }),
  ]);

  for (const col of PRODUCT_DROP) delete product[col];
  // The long texts travel only when asked for: otherwise their lengths, so
  // the model knows they are filled.
  const longTexts = {};
  const keep = (key, value) => {
    const text = typeof value === "string" && /<[a-z][^>]*>/i.test(value) ? stripHtml(value) : value;
    const size = typeof text === "string" ? text.length : text && typeof text === "object" ? JSON.stringify(text).length : 0;
    if (size <= 300 || input.include_content === true) return trimCell(text);
    longTexts[key] = Array.isArray(text) ? `${text.length} items, ${size} characters` : `${size} characters`;
    return undefined;
  };
  for (const key of ["description", "quickbooks_description", "bullet_points", "notes"]) {
    const kept = keep(key, product[key]);
    if (kept === undefined) delete product[key];
    else product[key] = kept;
  }
  const attributes = {};
  for (const [k, v] of Object.entries(product.attributes ?? {})) {
    const kept = keep(`attributes.${k}`, v);
    if (kept !== undefined) attributes[k] = kept;
  }
  product.attributes = attributes;

  const images = media.rows.filter((m) => m.media_type === "image");
  const byLanguage = {};
  for (const m of images) byLanguage[m.language ?? "universal"] = (byLanguage[m.language ?? "universal"] ?? 0) + 1;

  // One line per store: the link's newest check (the Canada and USA pages carry the same link).
  const checkOf = new Map();
  for (const c of checks.rows) {
    const seen = checkOf.get(c.retailer);
    if (!seen || String(c.checked_at ?? "") > String(seen.checked_at ?? "")) checkOf.set(c.retailer, c);
  }
  const linkLine = (link) => {
    const c = checkOf.get(link.retailer);
    if (!c) return { ...link, last_check: "not checked yet" };
    return {
      ...link,
      verdict: c.verdict,
      ...(c.sku_check && c.sku_check !== "match" ? { sku_check: c.sku_check } : {}),
      ...(c.in_stock === false ? { page_says: "sold out" } : {}),
      ...(c.price != null ? { page_price: `${c.price} ${c.currency ?? ""}`.trim() } : {}),
      checked: c.checked_at ? String(c.checked_at).slice(0, 10) : null,
    };
  };

  const today = ctx.today;
  const promotions = promos.rows
    .filter((r) => r.promotions)
    .map((r) => {
      const line = promoLine(r.promotions, today);
      return { ...line, ...promoMember(line, r) };
    })
    .sort((a, b) => (promoStart(a) < promoStart(b) ? 1 : -1));

  return {
    found: true,
    product: Object.fromEntries(Object.entries(product).map(([k, v]) => [k, k === "attributes" ? v : trimCell(v)])),
    ...(Object.keys(longTexts).length ? { long_texts_left_out: longTexts } : {}),
    family_variants: family.rows,
    media: {
      images: images.length,
      images_by_language: byLanguage,
      main_image: images.find((m) => m.is_primary)?.file_name ?? null,
      videos: media.rows.filter((m) => m.media_type === "video").length,
      documents: media.rows.filter((m) => m.media_type === "document").map((m) => ({ type: m.document_type, language: m.language ?? "universal", file: m.file_name })),
    },
    marketplace_ids: { aliases: aliases.rows, amazon: amazon.rows, wix_stores: wix.rows },
    stock: inventory.rows.length ? inventory.rows.map((r) => ({ ...r, market: MARKET_NAME[r.market] ?? r.market })) : "not tracked (Odoo has no active product with this SKU)",
    sales: sales.rows.length
      ? sales.rows.map((r) => ({
        ...r,
        market: MARKET_NAME[r.market] ?? r.market,
        stock_lasts_days: stockLasts(inventory.rows.find((i) => i.market === r.market)?.available, Number(r.units_90)),
      }))
      : "sold nothing in the last 90 days",
    where_to_buy: ownLinks.rows.map(linkLine),
    promotions_running_or_upcoming: promotions.filter((p) => p.state_today !== "ended"),
    past_promotions: promotions.filter((p) => p.state_today === "ended").slice(0, 6).map((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !["status_in_pim", "state_today", "stylish_discount"].includes(k)))),
  };
}

// ── the guide ───────────────────────────────────────────────────────────────
// ctx.guide = the guide's pieces [{ id, section, lead, text }] (assistant_knowledge 'guide').
const STOP_WORDS = new Set("the a an of to in on for and or is are was how what why when where which who does do did it its with by that this these from at as be can not if then than into about el la los las de del que en y o como cómo qué un una se es por para con cuando donde dónde".split(" "));
const occurrences = (text, word) => text.split(word).length - 1;

/** The pieces this person may read: one marked `only` is for the people of that group. */
const readablePieces = (ctx) => (ctx.guide ?? []).filter((p) => !p.only || (ctx.groups ?? []).includes(p.only));

function searchGuide(ctx, input) {
  const words = [...new Set((String(input.query ?? "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}&/-]*/gu) ?? []).filter((w) => w.length >= 2 && !STOP_WORDS.has(w)))].slice(0, 12);
  if (!words.length) throw new ToolError("Give a few words that name the topic.");
  const pieces = readablePieces(ctx).map((piece) => ({ piece, head: piece.lead.toLowerCase(), body: piece.text.toLowerCase() }));
  const pairs = words.slice(1).map((word, i) => [words[i], word]);
  // A word found in few pieces says more than one found everywhere.
  const weight = Object.fromEntries(words.map((word) => {
    const found = pieces.filter((p) => p.body.includes(word)).length;
    return [word, found ? Math.log(1 + pieces.length / found) : 0];
  }));
  const scored = [];
  for (const { piece, head, body } of pieces) {
    let score = 0;
    for (const word of words) {
      const n = occurrences(body, word);
      if (n) score += weight[word] * ((head.includes(word) ? 2 : 0) + 1 + Math.min(n, 5) / 5);
    }
    // two words of the question side by side are a stronger sign than each alone
    for (const [a, b] of pairs) if (body.includes(`${a} ${b}`)) score += (weight[a] + weight[b]) * 1.5;
    // a long piece holds every word more easily: it counts a little less
    if (score) scored.push({ piece, score: score / Math.sqrt(1 + piece.text.length / 10000) });
  }
  scored.sort((a, b) => b.score - a.score);
  const limit = Math.min(Math.max(Number(input.max_pieces) || 3, 1), 6);
  const full = [];
  let used = 0;
  for (const { piece, score } of scored) {
    // in full: the best piece, and those nearly as good
    if (full.length >= limit || (full.length && (score < scored[0].score * 0.55 || used + piece.text.length > 16000))) break;
    full.push(piece);
    used += piece.text.length;
  }
  return {
    words,
    pieces: full.map(({ id, section, text }) => ({ id, section, text })),
    other_matches: scored.slice(full.length, full.length + 8).map(({ piece }) => `${piece.id} — ${piece.lead}`),
    ...(scored.length ? {} : { note: "Nothing in the guide has those words. Try other English words, or pick pieces from <guide_index> with read_guide." }),
  };
}

function readGuide(ctx, input) {
  const ids = [...new Set((input.ids ?? []).map((id) => String(id).trim()))].slice(0, 8);
  if (!ids.length) throw new ToolError("Give the ids of the pieces to read, from <guide_index>.");
  const byId = new Map(readablePieces(ctx).map((p) => [p.id, p]));
  const pieces = [];
  let used = 0;
  let cut = 0;
  for (const id of ids) {
    const piece = byId.get(id);
    if (!piece) continue;
    if (pieces.length && used + piece.text.length > 30000) {
      cut += 1;
      continue;
    }
    pieces.push({ id: piece.id, section: piece.section, text: piece.text });
    used += piece.text.length;
  }
  const unknown = ids.filter((id) => !byId.has(id));
  return {
    pieces,
    ...(unknown.length ? { no_such_id: unknown } : {}),
    ...(cut ? { note: `${cut} of the pieces asked for did not fit: read them in another call.` } : {}),
  };
}

// ── listing_health ──────────────────────────────────────────────────────────
// The latest snapshot's own item of one product, per channel (a GET to a
// read-only database function).
const HEALTH_ITEM_CHANNELS = ["wayfair", "wayfair_usa", "bestbuy", "walmart_us", "walmart_ca", "wix_sinksdirect_us", "wix_stylish_ca", "wix_stylish_us", "wix_azuni_ca"];

async function restJson(ctx, path) {
  const res = await fetch(`${ctx.url}/rest/v1/${path}`, { headers: headersOf(ctx) });
  const text = await res.text();
  if (!res.ok) throw new ToolError(`The database refused this read (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function listingHealth(ctx, input) {
  const asked = String(input.sku ?? "").trim();
  if (!asked) {
    const { rows } = await rest(ctx, "channel_health?select=channel,target,run_at,total,in_sync,with_diffs,errors&order=run_at.desc&limit=200");
    const latest = new Map();
    for (const r of rows) if (!latest.has(r.channel)) latest.set(r.channel, r);
    return { note: "The latest snapshot per channel. total = products looked at; in_sync = with nothing to fix; with_diffs = with differences. For one product's details, call this with its SKU.", channels: [...latest.values()] };
  }
  const { rows } = await rest(ctx, `products?select=*&sku=eq.${q(asked)}`);
  if (rows.length !== 1) return { found: false, note: `No product with the SKU "${asked}". Use find_products for the exact one.` };
  const product = rows[0];
  const sku = product.sku;
  const [media, upcs, ...items] = await Promise.all([
    rest(ctx, `product_media?select=*&sku=eq.${q(sku)}&order=display_order`),
    restAll(ctx, "products?select=sku,upc:attributes->>upc&workflow_status=neq.archived"),
    ...HEALTH_ITEM_CHANNELS.map((channel) => restJson(ctx, `rpc/channel_health_item?p_channel=${channel}&p_sku=${q(sku)}`).catch(() => null)),
  ]);
  const item = Object.fromEntries(HEALTH_ITEM_CHANNELS.map((channel, i) => [channel, items[i]]));
  const only = (value) => new Map(value ? [[sku, value]] : []);

  const pim = scoreCompleteness(product, media.rows, completenessContext(upcs.map((p) => ({ sku: p.sku, attributes: { upc: p.upc } }))));
  const { perMarketplaceData } = buildListingHealthData([{ ...product, product_media: media.rows }], {
    wayfairMap: only(item.wayfair),
    wayfairUsaMap: only(item.wayfair_usa),
    bestbuyMap: only(item.bestbuy),
    walmartMaps: { walmart_us: only(item.walmart_us), walmart_ca: only(item.walmart_ca) },
    wixSiteMaps: Object.fromEntries(["wix_sinksdirect_us", "wix_stylish_ca", "wix_stylish_us", "wix_azuni_ca"].map((k) => [k, only(item[k])])),
  });
  const stores = [];
  const notSold = [];
  for (const [key, data] of Object.entries(perMarketplaceData)) {
    const scored = data.products[0];
    if (!scored) {
      notSold.push(MARKETPLACES[key].label); // the store does not carry this brand
      continue;
    }
    stores.push({
      store: MARKETPLACES[key].label,
      score: scored.result.score,
      listed: scored.source !== "not_linked",
      failing: scored.result.issues.map((i) => `${i.label} (${i.severity})`),
      ...(scored.wayfair_audit?.fields?.length ? { wayfair_specs_that_differ: scored.wayfair_audit.fields } : {}),
    });
  }
  return {
    found: true,
    sku,
    model: product.model_name,
    pim_completeness: {
      ...(inCompleteness(product) ? {} : { note: "Obsolete and archived products are left out of the PIM completeness score; this is what it would be." }),
      score: pim.score,
      checks: pim.passed.length + pim.missing.length,
      missing: pim.missing.map((m) => ({ field: m.label, where: `${m.tab} tab › ${m.section}`, ...(m.note ? { problem: m.note } : {}) })),
    },
    stores,
    ...(notSold.length ? { not_sold_on: notSold } : {}),
  };
}

// ── price_alignment ─────────────────────────────────────────────────────────
// The Pricing page's own report (priceAlignmentReport.js), read through the
// person's session. Its reads are shared for the length of one question.
function alignmentOf(ctx) {
  if (!ctx.db) throw new ToolError("Price Alignment cannot be read here.");
  if (!ctx.alignment) {
    const shared = new Map();
    const sharedLoad = (key, loader) => {
      if (!shared.has(key)) shared.set(key, loader());
      return shared.get(key);
    };
    ctx.alignment = { targets: alignTargets(WIX_SITES), ...createPriceAlignment({ db: ctx.db, sharedLoad }) };
  }
  return ctx.alignment;
}

function storeLine(key, cfg, report) {
  if (!report) return { store: cfg.label, key, market: MARKET_NAME[cfg.market] ?? cfg.market, note: "No report yet." };
  const s = alignmentSummary(report);
  return {
    store: cfg.label,
    key,
    market: MARKET_NAME[cfg.market] ?? cfg.market,
    compares_with: cfg.priceShort,
    read: cfg.kind === "page" ? "from the store's pages" : "from the store's API",
    as_of: report.ranAt ?? null,
    aligned_pct: s.pct,
    comparable: s.comparable,
    aligned: s.aligned,
    promo_missing: report.counts?.promo_missing ?? 0,
    misaligned: (report.counts?.misaligned ?? 0) + (report.counts?.missing ?? 0),
    no_price_in_pim: report.counts?.no_map ?? 0,
    not_on_store: report.notOnStore ?? 0,
  };
}

const priceRow = (r, status) => ({
  sku: r.sku,
  status,
  live: r.live ?? null,
  expected: r.expected ?? null,
  expected_from: r.source === "promo" ? r.promo_kind ?? "promotion" : r.source === "map" ? "regular price" : null,
  ...(r.read_at ? { page_read: String(r.read_at).slice(0, 10) } : {}),
  ...(r.unconfirmed ? { sku_not_confirmed_on_page: true } : {}),
  ...(r.in_stock === false ? { page_says: "sold out" } : {}),
});

async function priceAlignment(ctx, input) {
  const { targets, latestReport } = alignmentOf(ctx);
  const sku = String(input.sku ?? "").trim();
  let entries = Object.entries(targets);
  if (input.store) {
    const wanted = String(input.store).trim().toLowerCase();
    const flat = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const hit = entries.filter(([key, cfg]) => key === wanted || [key, cfg.label, cfg.short].some((v) => flat(v) === flat(wanted)));
    const near = hit.length ? hit : entries.filter(([key, cfg]) => [key, cfg.label, cfg.short].some((v) => flat(v).includes(flat(wanted))));
    if (near.length !== 1) throw new ToolError(`"${input.store}" is ${near.length ? "more than one store" : "not a store of Price Alignment"}. Stores: ${entries.map(([key, cfg]) => `${key} (${cfg.label})`).join(", ")}.`);
    entries = near;
  }
  const reports = await Promise.all(entries.map(async ([key, cfg]) => {
    try {
      return { key, cfg, report: await latestReport(cfg) };
    } catch (err) {
      return { key, cfg, report: null, error: String(err?.message ?? err).slice(0, 200) };
    }
  }));

  if (sku) {
    const found = [];
    const absent = [];
    for (const { cfg, report } of reports) {
      const problem = report?.problems?.find((p) => p.sku === sku);
      const fine = problem ? null : report?.aligned?.find((p) => p.sku === sku);
      if (problem) found.push({ store: cfg.label, currency: cfg.market === "us" ? "USD" : "CAD", ...priceRow(problem, problem.status) });
      else if (fine) found.push({ store: cfg.label, currency: cfg.market === "us" ? "USD" : "CAD", ...priceRow(fine, "aligned") });
      else absent.push(cfg.label);
    }
    return { sku, stores: found, no_comparable_price_on: absent, note: "A store in no_comparable_price_on does not carry the product, has no reading yet, or its page could not be compared (sold out, another option, read before a price change)." };
  }

  if (input.store) {
    const { key, cfg, report, error } = reports[0];
    if (error) throw new ToolError(`The report of ${cfg.label} could not be read: ${error}`);
    const problems = report?.problems ?? [];
    return {
      ...storeLine(key, cfg, report),
      problems: problems.slice(0, 80).map((p) => priceRow(p, p.status)),
      ...(problems.length > 80 ? { note: `${problems.length} problems in all; the first 80 are shown.` } : {}),
    };
  }
  return { stores: reports.map(({ key, cfg, report, error }) => (error ? { store: cfg.label, key, error } : storeLine(key, cfg, report))) };
}

// ── propose_action ──────────────────────────────────────────────────────────
// Only a proposal is kept: the person confirms it on the page, and the page
// makes the change through the app's own save (its checks, its Activity Log).
const PRICE_FIELDS = {
  map_cad: "MAP Blue CAD", map_usd: "MAP Blue USD",
  map_orange_cad: "MAP Orange CAD", map_orange_usd: "MAP Orange USD",
  map_purple_cad: "MAP Purple CAD", map_purple_usd: "MAP Purple USD",
  msrp_cad: "MSRP CAD", msrp_usd: "MSRP USD",
};
const MAX_ACTION_ITEMS = 50;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function proposeAction(ctx, input) {
  if (!["admin", "editor"].includes(ctx.role)) throw new ToolError("This person's role only reads the PIM: no change can be prepared for them.");
  if (!ctx.saveAction) throw new ToolError("Changes cannot be prepared here.");

  let summary;
  let payload;
  if (input.kind === "set_obsolete") {
    const skus = [...new Set((input.skus ?? []).map((s) => s.trim()).filter(Boolean))];
    if (!skus.length) throw new ToolError("Give the SKUs to mark.");
    if (skus.length > MAX_ACTION_ITEMS) throw new ToolError(`At most ${MAX_ACTION_ITEMS} products per change.`);
    if (typeof input.obsolete !== "boolean") throw new ToolError("Say obsolete: true (mark) or false (take the mark off).");
    const { rows } = await rest(ctx, `products?select=sku,model_name,is_obsolete&sku=in.(${q(skus.map(lit).join(","))})`);
    const unknown = skus.filter((s) => !rows.some((r) => r.sku === s));
    if (unknown.length) throw new ToolError(`Not in the PIM: ${unknown.join(", ")}. Find the exact SKUs with find_products.`);
    const items = rows.filter((r) => Boolean(r.is_obsolete) !== input.obsolete).map((r) => ({ sku: r.sku, model: r.model_name }));
    if (!items.length) return { prepared: false, note: `Nothing to change: ${skus.length === 1 ? "it already is" : "they already are"} ${input.obsolete ? "obsolete" : "not obsolete"}.` };
    summary = input.obsolete ? `Mark ${plural(items.length, "product")} obsolete` : `Take the obsolete mark off ${plural(items.length, "product")}`;
    payload = { obsolete: input.obsolete, items, unchanged: rows.filter((r) => Boolean(r.is_obsolete) === input.obsolete).map((r) => r.sku) };
  } else {
    const asked = (input.prices ?? []).map((line) => {
      const [sku, field, value] = String(line).split("|").map((part) => part.trim());
      const price = Math.round(Number(String(value ?? "").replace(/[$,\s]/g, "")) * 100) / 100;
      if (!sku || !(field in PRICE_FIELDS) || !(price > 0)) throw new ToolError(`"${line}" is not "SKU | field | new price" with a field of: ${Object.keys(PRICE_FIELDS).join(", ")} and a price above 0.`);
      return { sku, field, to: price };
    });
    if (!asked.length) throw new ToolError("Give the prices to change.");
    if (asked.length > MAX_ACTION_ITEMS) throw new ToolError(`At most ${MAX_ACTION_ITEMS} prices per change.`);
    const skus = [...new Set(asked.map((a) => a.sku))];
    const { rows } = await rest(ctx, `products?select=sku,model_name,${Object.keys(PRICE_FIELDS).join(",")}&sku=in.(${q(skus.map(lit).join(","))})`);
    const unknown = skus.filter((s) => !rows.some((r) => r.sku === s));
    if (unknown.length) throw new ToolError(`Not in the PIM: ${unknown.join(", ")}. Find the exact SKUs with find_products.`);
    const items = [];
    for (const a of asked) {
      const row = rows.find((r) => r.sku === a.sku);
      const from = row[a.field] == null ? null : Number(row[a.field]);
      if (from !== a.to) items.push({ sku: a.sku, model: row.model_name, field: a.field, label: PRICE_FIELDS[a.field], from, to: a.to });
    }
    if (!items.length) return { prepared: false, note: "Nothing to change: the PIM already has those prices." };
    summary = items.length === 1
      ? `${items[0].label} of ${items[0].sku}: ${items[0].from ?? "empty"} → ${items[0].to}`
      : `Change ${plural(items.length, "price")} on ${plural(new Set(items.map((i) => i.sku)).size, "product")}`;
    payload = { items };
  }

  const id = await ctx.saveAction({ kind: input.kind, summary, payload });
  return {
    prepared: true,
    action_id: id,
    summary,
    items: payload.items,
    note: "The person now sees a card with this change. It has NOT been made: it happens only if they press Confirm, and the PIM's own rules are checked then (a price a rule refuses is reported on the card).",
  };
}

// ── create_excel ────────────────────────────────────────────────────────────
// Only the file's DESCRIPTION is kept: each sheet read from a table is tried
// here (its first page, with the person's session) so a wrong query comes back
// to the model instead of reaching the person, and the rows themselves are
// read by the page when the person downloads (assistantExcel.js).
const sampleCell = (cell) => (typeof cell === "string" && cell.length > 80 ? `${cell.slice(0, 80)}…` : cell);

async function createExcel(ctx, input) {
  if (!ctx.saveFile) throw new ToolError("Files cannot be prepared here.");
  const spec = checkExcelSpec(input);
  const read = (path, wantCount) => rest(ctx, path, { count: wantCount });
  const tried = await Promise.all(spec.sheets.map((sheet) => loadExcelSheet(sheet, read, { maxRows: 1000, strict: true })));

  const empty = spec.sheets.filter((_, i) => !tried[i].rows.length).map((sheet) => `"${sheet.name}"`);
  if (empty.length) {
    throw new ToolError(`No row matches the sheet ${empty.join(", ")}, so it would be empty. Check its filters (try them with query_table), or leave the sheet out and tell the person there is nothing to list.`);
  }

  // The columns are settled now, so the download shows exactly what was tried.
  const sheets = spec.sheets.map((sheet, i) => (sheet.rows ? sheet : { ...sheet, columns: tried[i].columns }));
  const summary = { sheets: sheets.map((sheet, i) => ({ name: sheet.name, rows: tried[i].total, columns: tried[i].headers.length, source: sheet.rows ? "typed" : sheet.table })) };
  const id = await ctx.saveFile({ kind: "excel", title: spec.title, spec: { title: spec.title, sheets }, summary });
  return {
    prepared: true,
    file_id: id,
    title: spec.title,
    sheets: sheets.map((sheet, i) => ({
      name: sheet.name,
      rows: tried[i].total,
      columns: tried[i].headers,
      first_rows: tried[i].rows.slice(0, 2).map((row) => row.map(sampleCell)),
      ...(tried[i].notes.length ? { notes: tried[i].notes } : {}),
    })),
    note: "The person now sees a card with a Download button for this file. A sheet read from a table is filled when they press it, from the PIM as it is then and with their own permissions. Tell them in a line or two what the file holds (its sheets, how many rows, the filter used) — do not repeat its rows.",
  };
}

const RUNNERS = {
  create_excel: createExcel,
  listing_health: listingHealth,
  price_alignment: priceAlignment,
  propose_action: proposeAction,
  search_guide: searchGuide,
  read_guide: readGuide,
  find_products: findProducts,
  product_details: productDetails,
  sales_overview: salesOverview,
  promotions_overview: promotionsOverview,
  query_table: queryTable,
};

/** Runs one lookup. The input must have passed inputProblem(). */
export async function runAssistantTool(ctx, name, input) {
  const run = RUNNERS[name];
  if (!run) throw new ToolError(`There is no tool named "${name}".`);
  try {
    return await run(ctx, input);
  } catch (err) {
    // what assistantExcel.js refuses (a read, a file's description) is said to the model like any refusal
    throw err instanceof SpecError ? new ToolError(err.message) : err;
  }
}
