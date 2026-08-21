// Stylish PIM → Wayfair: push spec attributes (the "Specifications" cells)
// for ANY Wayfair class via updateMarketSpecificCatalogItems.
//
// How it works:
//   1. Reads the product from the PIM (columns + attributes JSONB).
//   2. Reads the item's current attributes from Wayfair (supplierCatalogItems),
//      which yields the class, the attributeId for every attribute title, and
//      the currently chosen values.
//   3. Walks the item's OWN attribute titles and resolves each against the
//      rules below (exact titles first, then patterns) — so every class
//      (kitchen sinks, bathroom sinks, faucets, cutting boards, strainers…)
//      maps exactly the attributes it carries, and attributeIds come from the
//      live item — no hardcoded IDs, Wayfair renumbering can't break us.
//   4. Returns a diff (current vs new). Unless dryRun, runs the mutation
//      (validateOnly=true by default — Wayfair validates without changing).
//
// Request body: {
//   sku: string,
//   validateOnly?: boolean=true,  // passed to the Wayfair mutation
//   dryRun?: boolean=false,       // true = only compute the diff, no mutation
// }
//
// Required secrets: WAYFAIR_CLIENT_ID, WAYFAIR_CLIENT_SECRET,
//                   WAYFAIR_SUPPLIER_ID, WAYFAIR_ENV
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Spec attributes are language-neutral; CA (the supplier's home market) is the
// default. US remains selectable for the wayfair.com listing.
const MARKETS: Record<string, { locale: string; country: string; brand: string }> = {
  CA: { locale: "en-CA", country: "CANADA", brand: "WAYFAIR" },
  US: { locale: "en-US", country: "UNITED_STATES", brand: "WAYFAIR" },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Cached per client id for the life of the warm instance. Wayfair rate-limits
// the TOKEN endpoint hard — a 317-SKU audit fetching a fresh token per call
// is what tripped "Retry after 52s", not the catalog queries themselves.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getToken(clientId: string, clientSecret: string): Promise<string> {
  const hit = tokenCache.get(clientId);
  if (hit && Date.now() < hit.expiresAt) return hit.token;

  const res = await fetch("https://sso.auth.wayfair.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience: "https://api.wayfair.io",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Wayfair auth failed: ${JSON.stringify(data).slice(0, 200)}`);
  tokenCache.set(clientId, {
    token: data.access_token,
    // Refresh a minute early; Wayfair tokens report expires_in in seconds.
    expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
  });
  return data.access_token;
}

// ---- value helpers ----
type Product = Record<string, unknown> & { attributes?: Record<string, unknown> };
const attr = (p: Product) => (p.attributes ?? {}) as Record<string, unknown>;
const num = (v: unknown): string => {
  if (v == null || v === "") return "";
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? m[0] : "";
};
const yesNo = (v: unknown): string => {
  if (v == null || v === "") return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  const s = String(v).toLowerCase();
  if (s.includes("yes") || s === "true" || s === "1") return "Yes";
  if (s.includes("no") || s === "false" || s === "0") return "No";
  return "";
};
const dim = (p: Product, group: string, axis: string): string => {
  const g = attr(p)[group] as Record<string, unknown> | undefined;
  return num(g?.[axis]);
};
// PIM finish → Wayfair "Finish" valid values (mirrors the Excel export aliases)
const FINISH_ALIAS: Record<string, string> = {
  "brushed stainless steel": "Stainless Steel",
  "grey": "Matte Grey",
  "gray": "Matte Grey",
  "black": "Matte Black",
  "white": "Matte White",
  "graphite black": "Gunmetal Black",
  "nano graphite black dura-tek": "Gunmetal Black",
  // Bare "Dura-Tek" (outdoor/utility sinks) is a protective coating on
  // STAINLESS sinks — the visible finish Wayfair's list can express is
  // Stainless Steel (their current value was right; the raw push wasn't).
  "dura-tek": "Stainless Steel",
  // Validated against the templates' Valid Values sheets 2026-08-19.
  "glossy black": "Gloss Black",
  "gunmetal": "Gun Metal",
  "matte black with brushed gold": "Matte Black; Brushed Gold",
  "dark grey": "Matte Grey",
  "dark gray": "Matte Grey",
};
// Raw PIM finish; the alias to Wayfair's canonical option is applied later,
// only when the literal PIM value doesn't already match Wayfair's current one
// (e.g. Wayfair often already holds "Brushed stainless steel" verbatim).
const finish = (v: unknown): string => (v ? String(v) : "");

// ---- Exact-title rules: Wayfair attribute title → value from the PIM ----
// Grown from the Kitchen Sinks class; titles shared by other classes (overall
// dimensions, weight, material, finish, warranty) resolve here too. A rule
// returning "" means "no PIM value; skip".
const EXACT_RULES: Record<string, (p: Product) => string> = {
  "Overall Length from End to End": (p) => dim(p, "external_dimensions_in", "length"),
  "Overall Width from Front to Back": (p) => dim(p, "external_dimensions_in", "width"),
  "Overall Height from Top to Bottom": (p) => dim(p, "external_dimensions_in", "depth"),
  "Basin Length - Side to Side": (p) => dim(p, "internal_dimensions_in", "length"),
  "Basin Width - Front to Back": (p) => dim(p, "internal_dimensions_in", "width"),
  "Basin Depth - Top to Bottom": (p) => dim(p, "internal_dimensions_in", "depth"),
  "Overall Product Weight": (p) => num(p.weight_lb ?? attr(p).product_weight_lb),
  "Drain Diameter": (p) => num(p.drain_diameter_in ?? attr(p).drain_diameter_in),
  "Stainless Steel Gauge": (p) => num(p.gauge ?? attr(p).gauge),
  "Number of Basins": (p) => num(p.number_of_bowls ?? attr(p).number_of_bowls),
  "Basin Split": (p) => String(p.basin_split ?? attr(p).basin_split ?? ""),
  // NOTE: the API's "Sink Shape" vocabulary is ADJECTIVAL ("Rectangular") —
  // distinct from the template's "Overall Shape" nouns ("Rectangle").
  // Verified on live items 2026-08-19: S-636W carries Sink Shape=Rectangular
  // AND Overall Shape=Rectangle. Push the raw PIM value; never noun-alias it.
  "Sink Shape": (p) => String(p.shape ?? attr(p).sink_shape ?? ""),
  "Material": (p) => String(p.material ?? ""),
  "Finish": (p) => finish(p.finish),
  "Warranty Length": (p) => String(attr(p).warranty_length ?? ""),
  "Full or Limited Warranty": (p) => String(attr(p).warranty ?? ""),
  // A divider only exists on multi-basin sinks; single-bowl → Does Not Apply.
  "Short Height Divider": (p) => {
    const bowls = Number(num(p.number_of_bowls ?? attr(p).number_of_bowls));
    if (bowls > 0 && bowls <= 1) return "Does Not Apply";
    return yesNo(attr(p).low_divider);
  },
  // Workstation sinks carry over-the-sink accessories (cutting board, drying
  // rack, colander) or say so in the product type. SKU alone isn't reliable.
  "Kitchen Sink Workstation": (p) => {
    if (/workstation/i.test(String(p.product_type ?? ""))) return "Yes";
    const acc = attr(p).accessories_included;
    const list = Array.isArray(acc) ? acc.join(", ") : String(acc ?? "");
    return /cutting board|drying rack|colander/i.test(list) ? "Yes" : "No";
  },
};

// ---- Pattern rules for titles that vary by class ----
// Checked only when no exact rule matched the item's attribute title.
//
// Titles matching EXCLUDE never pattern-match: they describe a DIFFERENT
// measurement than the overall product (apron, basin, base/stand, cut-out…)
// or a field we hold no PIM value for (commercial warranty) — filling those
// with overall dims/residential values would corrupt the listing on push.
const EXCLUDE = /apron|basin|interior|cut.?out|base\/stand|stand height|cabinet|drain|hole size|commercial|additional details|min(imum)?|max(imum)?/i;

// Wayfair's axis convention names the axis in the title: "End to End" /
// "Side to Side" = left-right (PIM length), "Front to Back" = PIM width,
// "Top to Bottom" = vertical (PIM height/depth).
//
// ONE context-dependent case (same gotcha as the Excel templates): when a
// class carries BOTH "Overall Length … End to End" and "Overall Width …
// Side to Side" (e.g. Cutting Boards), the width title is the SHORT axis →
// PIM width. When the width title is the only horizontal one (e.g. Strainers
// & Colanders), side-to-side IS the long axis → PIM length. `ctx.hasPlainLength`
// carries that per-item fact into the rule.
type RuleCtx = { hasPlainLength: boolean };
const PATTERN_RULES: Array<{ re: RegExp; value: (p: Product, ctx: RuleCtx) => string }> = [
  // Class-specific measurements first
  { re: /including handles/i, value: (p) => num(attr(p).length_with_handles_in) },
  {
    re: /^overall width .*side to side/i,
    value: (p, ctx) => dim(p, "external_dimensions_in", ctx.hasPlainLength ? "width" : "length"),
  },
  { re: /^spout height/i, value: (p) => num(attr(p).spout_height_in) },
  { re: /^spout reach/i, value: (p) => num(attr(p).spout_reach_in) },
  { re: /flow rate/i, value: (p) => num(attr(p).max_flow_rate) },
  { re: /number of (faucet )?handles/i, value: (p) => num(attr(p).number_of_handles) },
  { re: /^faucet height/i, value: (p) => num(attr(p).faucet_height_in) || dim(p, "external_dimensions_in", "height") },
  { re: /(number of (faucet |installation )?holes)/i, value: (p) => num(attr(p).number_of_installation_holes) },
  { re: /(countertop|deck) thickness/i, value: (p) => num(attr(p).max_deck_thickness_in) },
  // Overall dimensions by axis phrase (bathroom sinks, accessories…)
  { re: /^overall .*(end to end|side to side)/i, value: (p) => dim(p, "external_dimensions_in", "length") },
  { re: /^overall .*front to back/i, value: (p) => dim(p, "external_dimensions_in", "width") },
  {
    re: /^overall .*top to bottom/i,
    value: (p) => dim(p, "external_dimensions_in", "height") || dim(p, "external_dimensions_in", "depth"),
  },
  { re: /^overall product weight$/i, value: (p) => num(p.weight_lb ?? attr(p).product_weight_lb) },
  { re: /^warranty length$/i, value: (p) => String(attr(p).warranty_length ?? "") },
  { re: /^material$/i, value: (p) => String(p.material ?? "") },
  { re: /^finish$/i, value: (p) => finish(p.finish) },
  { re: /^country of (origin|manufacture)$/i, value: (p) => String(attr(p).country_of_origin ?? "") },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { sku, validateOnly = true, dryRun = false, supplier = "CAN" } = body;
    if (!sku) return json({ error: "sku is required" }, 400);
    const market = body.market ?? (supplier === "USA" ? "US" : "CA");
    const MARKET = MARKETS[market];
    if (!MARKET) return json({ error: `unknown market "${market}" (use CA or US)` }, 400);

    const CLIENT_ID = supplier === "USA" ? Deno.env.get("WAYFAIR_USA_CLIENT_ID") : Deno.env.get("WAYFAIR_CLIENT_ID");
    const CLIENT_SECRET = supplier === "USA" ? Deno.env.get("WAYFAIR_USA_CLIENT_SECRET") : Deno.env.get("WAYFAIR_CLIENT_SECRET");
    const SUPPLIER_ID = supplier === "USA" ? Deno.env.get("WAYFAIR_USA_SUPPLIER_ID") : Deno.env.get("WAYFAIR_SUPPLIER_ID");
    const ENV = Deno.env.get("WAYFAIR_ENV") ?? "sandbox";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!CLIENT_ID || !CLIENT_SECRET || !SUPPLIER_ID) {
      return json({ error: `Missing WAYFAIR_* secrets for supplier ${supplier}` }, 500);
    }

    // 1. PIM product
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
    const { data: product, error: pErr } = await supabase
      .from("products")
      .select("*")
      .eq("sku", sku)
      .maybeSingle();
    if (pErr) return json({ error: `PIM read failed: ${pErr.message}` }, 500);
    if (!product) return json({ error: `Product ${sku} not found in PIM` }, 404);

    const endpoint = ENV === "production"
      ? "https://api.wayfair.io/v1/product-catalog-api/graphql"
      : "https://api.wayfair.io/sandbox/v1/product-catalog-api/graphql";
    const token = await getToken(CLIENT_ID, CLIENT_SECRET);
    const call = async (query: string, variables: unknown) => {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-SELECTED-SUPPLIER-ID": String(SUPPLIER_ID),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
      return r.json();
    };

    // 2. Current Wayfair attributes for this item
    const catQ = `query($input: SupplierCatalogItemsInput!) {
      supplierCatalogItems(input: $input) {
        ... on SupplierCatalogItems {
          catalogItems {
            supplierPartNumber
            class { classId className }
            attributes {
              attribute { attributeId title }
              chosenAttributeValues { value }
            }
          }
        }
      }
    }`;
    const cat = await call(catQ, {
      input: { filter: { supplierPartNumbers: [sku] }, paginationOptions: { page: 1, pageSize: 30 } },
    });
    if (cat.errors) return json({ error: cat.errors[0]?.message, details: cat.errors }, 502);
    const item = cat.data?.supplierCatalogItems?.catalogItems?.[0];
    if (!item) return json({ error: `${sku} not found in Wayfair catalog` }, 404);

    // title → { attributeId, current[] }
    const byTitle = new Map<string, { attributeId: string; current: string[] }>();
    for (const a of item.attributes ?? []) {
      if (!a.attribute?.title) continue;
      byTitle.set(a.attribute.title, {
        attributeId: a.attribute.attributeId,
        // AttributeValue.value is itself a list → flatten to plain strings
        current: (a.chosenAttributeValues ?? []).flatMap((v: { value: string | string[] }) =>
          Array.isArray(v.value) ? v.value : [v.value]
        ),
      });
    }

    // 3. Compute updates + diff — walk the item's own attribute titles so any
    // class maps exactly what it carries (exact rules first, then patterns).
    const updates: { attributeId: string; value: string[] }[] = [];
    const diff: Record<string, { current: string[] | null; new: string; changed: boolean }> = {};
    const skipped: Record<string, string> = {};
    const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const ctx: RuleCtx = {
      hasPlainLength: [...byTitle.keys()].some((t) =>
        /^overall length\b.*end to end/i.test(t) && !/including handles/i.test(t)
      ),
    };
    for (const [title, wf] of byTitle) {
      const rule: ((p: Product, ctx: RuleCtx) => string) | undefined = EXACT_RULES[title] ??
        (EXCLUDE.test(title) ? undefined : PATTERN_RULES.find((r) => r.re.test(title))?.value);
      if (!rule) continue; // attribute we have no PIM mapping for
      let value = "";
      try { value = rule(product as Product, ctx).trim(); } catch { value = ""; }
      if (!value) { skipped[title] = "no PIM value"; continue; }
      // Finish: keep the literal PIM value when Wayfair already holds it
      // (case-insensitive); otherwise snap to Wayfair's canonical option.
      if (title === "Finish" && !(wf.current.length === 1 && eq(wf.current[0], value))) {
        value = FINISH_ALIAS[value.toLowerCase().trim()] ?? value;
        // Bathroom Sinks + non-metal finish: the template's list is
        // metal-only, but live items show plain colors accepted ("White" on
        // P-206) — the class vocabulary can't be confirmed (sandbox's
        // attributesByFilter is down). Don't guess against a closed list:
        // leave Wayfair's Finish untouched for these.
        if (
          /bathroom sink/i.test(item.class?.className ?? "") &&
          !/stainless|chrome|nickel|brass|bronze|gold|copper|gun ?metal|silver|does not apply/i.test(value)
        ) {
          skipped[title] = "non-metal finish on Bathroom Sinks — class vocabulary unconfirmed, left as-is";
          continue;
        }
      }
      // Never downgrade a more specific Wayfair value with our generic one
      // (e.g. Material "Stainless Steel (18/0)" vs PIM "Stainless Steel").
      if (
        wf.current.length === 1 &&
        wf.current[0].toLowerCase().startsWith(value.toLowerCase()) &&
        wf.current[0].length > value.length
      ) {
        skipped[title] = `Wayfair value is more specific ("${wf.current[0]}")`;
        continue;
      }
      const changed = !(wf.current.length === 1 && eq(wf.current[0], value));
      diff[title] = { current: wf.current.length ? wf.current : null, new: value, changed };
      updates.push({ attributeId: wf.attributeId, value: [value] });
    }
    if (updates.length === 0) {
      return json({
        error: `nothing to push — no mapped PIM values for class ${item.class?.classId} (${item.class?.className ?? "?"})`,
      }, 400);
    }

    const result: Record<string, unknown> = {
      ok: true,
      env: ENV,
      sku,
      supplier,
      market,
      class: item.class,
      updates: updates.length,
      changedCount: Object.values(diff).filter((d) => d.changed).length,
      diff,
      skipped,
    };

    // 4. Mutation (unless dryRun)
    if (!dryRun) {
      const input = {
        supplierId: SUPPLIER_ID,
        validateOnly,
        marketContext: MARKET,
        catalogItemsToUpdate: [
          {
            supplierPartNumber: sku,
            attributes: {
              taxonomyCategoryId: item.class.classId,
              updates,
              enableAutofill: false,
              ignoreWarnings: false,
            },
          },
        ],
      };
      const gql = await call(
        `mutation($input: UpdateMarketSpecificCatalogItemsInput!) {
          updateCatalogEntitiesMutations {
            updateMarketSpecificCatalogItems(input: $input) { requestId }
          }
        }`,
        { input },
      );
      result.mutation = gql.errors
        ? { error: gql.errors[0]?.message, details: gql.errors }
        : {
          requestId: gql.data?.updateCatalogEntitiesMutations?.updateMarketSpecificCatalogItems?.requestId,
          validateOnly,
        };
    } else {
      result.mutation = { skipped: "dryRun" };
    }

    return json(result);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
