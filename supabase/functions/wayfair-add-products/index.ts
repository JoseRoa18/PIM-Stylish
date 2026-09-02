// Stylish PIM → Wayfair Product Addition (API V2): create NEW listings for
// products that are not yet in the supplier's Wayfair catalog.
//
// How it works:
//   1. Caller must be an authenticated admin/editor (this creates listings).
//   2. Reads the products (+ media) from the PIM and refuses SKUs that already
//      exist in the supplier's Wayfair catalog (use the push functions for those).
//   3. Resolves the Wayfair class per PIM category, pulls that class's
//      Product Addition QUESTIONS (ids, importance, valid answers) and fills
//      them from the PIM: core identity, copy + bullets, images/documents,
//      cost, shipping/cartons, compliance defaults and the same spec rules the
//      attribute push uses (_shared/wayfairAttributes.ts). Choice answers are
//      snapped to Wayfair's valid values; anything that can't be mapped is
//      reported back instead of guessed.
//   4. Submits with productAddition.submitV2. validateOnly=true (default)
//      only validates — nothing is created. validateOnly=false creates the
//      listing request; track it with { status: productAdditionRequestId }.
//
// Request body: {
//   skus: string[],                // up to 30 per call
//   supplier?: "USA" | "CAN" = "USA",
//   validateOnly?: boolean = true,
//   sandbox?: boolean = false,     // hit the sandbox with the *_SANDBOX_* app
//   force?: boolean = false,       // also submit SKUs already in the catalog
//   classId?: string,              // override the class for every SKU
//   includeDocuments?: boolean = true,
//   status?: string,               // poll mode: productAdditionRequestId
// }
//
// Secrets: WAYFAIR_USA_CLIENT_ID/SECRET/SUPPLIER_ID (+ WAYFAIR_USA_SANDBOX_CLIENT_ID/SECRET),
//          WAYFAIR_CLIENT_ID/SECRET/SUPPLIER_ID for CAN, WAYFAIR_ENV.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { attr, FINISH_ALIAS, num, type Product, ruleContext, ruleForTitle } from "../_shared/wayfairAttributes.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

type Market = { locale: string; country: string; brand: string };
const SUPPLIERS: Record<string, { market: Market; prefix: string; costKey: string; region: string }> = {
  USA: {
    market: { locale: "en-US", country: "UNITED_STATES", brand: "WAYFAIR" },
    prefix: "WAYFAIR_USA",
    costKey: "cost_usd_wayfair",
    region: "US",
  },
  CAN: {
    market: { locale: "en-CA", country: "CANADA", brand: "WAYFAIR" },
    prefix: "WAYFAIR",
    costKey: "cost_cad_wayfair_sod",
    region: "CA",
  },
};

// Wayfair class per PIM category (USA catalog ids, verified 2026-09-02).
const CLASS_BY_CATEGORY: Record<string, { classId: string; className: string }> = {
  kitchen_sink: { classId: "628", className: "Kitchen Sinks" },
  bar_prep_sink: { classId: "628", className: "Kitchen Sinks" },
  laundry_sink: { classId: "875", className: "Utility Sinks" },
  outdoor_sink: { classId: "875", className: "Utility Sinks" },
  kitchen_faucet: { classId: "653", className: "Kitchen Faucets" },
  bathroom_faucet: { classId: "655", className: "Bathroom Sink Faucets" },
  bathroom_sink: { classId: "588", className: "Bathroom Sinks" },
  colander_drying_rack: { classId: "831", className: "Strainers & Colanders" },
};
const ACCESSORY_CLASSES: Array<{ re: RegExp; classId: string; className: string }> = [
  { re: /cutting board/i, classId: "187", className: "Cutting Boards" },
  { re: /colander/i, classId: "831", className: "Strainers & Colanders" },
  { re: /drain|strainer|flange|disposal/i, classId: "626", className: "Drains" },
  { re: /caddy|organizer|storage|holder/i, classId: "7454", className: "Kitchen Sink Storage" },
  { re: /cartridge|aerator|hose|spray|part/i, classId: "613", className: "Fixture Parts" },
];
function classFor(p: Product): { classId: string; className: string } | null {
  const cat = String(p.category ?? "");
  if (cat === "accessory") {
    // Stylish D-/ST- part numbers are drains and basket strainers.
    if (/^(D|ST)-/i.test(String(p.sku ?? ""))) return { classId: "626", className: "Drains" };
    const text = `${p.product_type ?? ""} ${p.model_name ?? ""} ${attr(p).general_title_en ?? ""}`;
    return ACCESSORY_CLASSES.find((c) => c.re.test(text)) ?? { classId: "633", className: "Kitchen Sink Accessories" };
  }
  return CLASS_BY_CATEGORY[cat] ?? null;
}

const DOC_TYPES: Record<string, string> = {
  spec_sheet: "Specifications",
  installation_undermount: "Installation & Assembly",
  installation_drop_in: "Installation & Assembly",
  installation_dual_mount: "Installation & Assembly",
  installation_manual: "Installation & Assembly",
  cut_out_template: "Installation & Assembly",
  warranty_file: "Warranty Information",
};

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
async function getToken(clientId: string, clientSecret: string): Promise<string> {
  const hit = tokenCache.get(clientId);
  if (hit && Date.now() < hit.expiresAt) return hit.token;
  const res = await fetch("https://sso.auth.wayfair.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, audience: "https://api.wayfair.io" }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Wayfair auth failed: ${JSON.stringify(data).slice(0, 200)}`);
  tokenCache.set(clientId, { token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000 });
  return data.access_token;
}

// ---- PIM value helpers (product-addition specific; spec rules are shared) ----
const text = (v: unknown) => String(v ?? "").trim();
const stripHtml = (html: unknown) =>
  text(html).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
// Several fields live both as product columns and inside attributes JSONB.
// An empty column value ("" / []) counts as missing so the JSONB copy wins.
const field = (p: Product, key: string): unknown => {
  const v = p[key];
  return v == null || v === "" || (Array.isArray(v) && !v.length) ? attr(p)[key] : v;
};
const material = (p: Product) => text(p.material);
// Wayfair's "Granite" means natural stone; our composite sinks (80% quartz)
// are listed as Quartz, matching the copy and the validated test listings.
const materialAnswer = (p: Product) => (/quartz|composite/i.test(material(p)) ? "Quartz" : material(p));
const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(text).filter(Boolean) : text(v) ? text(v).split(/[;,/]|\band\b/i).map((s) => s.trim()).filter(Boolean) : [];
const isSink = (p: Product) => /sink/.test(String(p.category ?? ""));
const finishValue = (p: Product) => text(p.finish);
const safetyListings = (p: Product) => listOf(attr(p).safety_listings).join(" ");

function shapeNoun(p: Product): string {
  const s = text(p.shape ?? attr(p).sink_shape).toLowerCase();
  if (!s) return "";
  if (/rect/.test(s)) return "Rectangle";
  if (/squar/.test(s)) return "Square";
  if (/round|circ/.test(s)) return "Round";
  if (/oval/.test(s)) return "Oval";
  if (/d-?shap/.test(s)) return "D-Shape";
  return s;
}
function mounting(p: Product): string[] {
  const s = text(field(p, "installation_type")).toLowerCase();
  if (!s) return [];
  if (/dual/.test(s)) return ["Dual Mount"];
  const out: string[] = [];
  if (/under/.test(s)) out.push("Undermount");
  if (/drop|top ?mount/.test(s)) out.push("Drop-In");
  if (/farm|apron/.test(s)) out.push("Farmhouse / Apron");
  if (/wall/.test(s)) out.push("Wall");
  if (/vessel/.test(s)) out.push("Vessel");
  return out.length ? out : [text(field(p, "installation_type"))];
}
function drainPlacement(p: Product): string {
  const s = text(attr(p).drain_hole_location).toLowerCase();
  if (!s) return "";
  if (/revers/.test(s)) return "Reversible";
  if (/rear|back/.test(s)) return "Back";
  if (/front/.test(s)) return "Front";
  if (/left/.test(s)) return "Left";
  if (/right/.test(s)) return "Right";
  if (/cent/.test(s)) return "Centre";
  return s;
}
function piecesIncluded(p: Product): string[] {
  const acc = listOf(attr(p).accessories_included ?? p.included_components).join(" | ").toLowerCase();
  const out = new Set<string>();
  if (/cutting board/.test(acc)) out.add("Cutting Board");
  if (/colander/.test(acc)) out.add("Colander");
  if (/strainer|drain/.test(acc)) out.add("Basket Strainer");
  if (/bottom grid/.test(acc)) out.add("Bottom Grid");
  else if (/grid/.test(acc)) out.add("Sink Grid");
  if (/faucet/.test(acc)) out.add("Faucet");
  if (/soap/.test(acc)) out.add("Soap / Lotion Dispenser");
  if (/template/.test(acc)) out.add("Cut Out Template");
  if (/hardware|clip/.test(acc)) out.add("Mounting Hardware");
  // Drying racks have no Wayfair option in "Pieces Included" — they only
  // count toward the workstation flag.
  return [...out];
}
function productType(p: Product): string {
  if (/workstation/i.test(String(p.product_type ?? "")) || piecesIncluded(p).some((x) => /Cutting Board|Colander|Rack/.test(x))) {
    return "Kitchen Sink Workstation";
  }
  if (/bar|prep/i.test(`${p.category ?? ""} ${p.product_type ?? ""}`)) return "Prep Sink";
  return "Standard Kitchen Sink";
}

// Product Addition questions that need a different answer than the spec push
// (compliance defaults, choice vocabularies, "Does Not Apply" fallbacks).
// Multi-choice answers return string[]; "" or [] = no value.
type Val = string | string[];
const SPECIAL: Array<{ re: RegExp; value: (p: Product) => Val }> = [
  { re: /^supplier intended and approved use$/i, value: () => "Residential Use" },
  { re: /^commercial warranty$/i, value: () => "No" },
  { re: /compliance vetting program/i, value: () => "No" },
  { re: /uniform packaging and labeling/i, value: () => "Yes" },
  { re: /^canada product restriction$/i, value: () => "No" },
  { re: /^nsf\/ansi 61/i, value: (p) => /nsf/i.test(safetyListings(p)) ? "Yes" : "Does Not Apply" },
  { re: /^plumbing material performance/i, value: (p) => /stainless/i.test(material(p)) ? "ASME A112.19.3" : "Does Not Apply" },
  {
    re: /^warranty$/i,
    value: (p) => {
      const w = `${field(p, "warranty") ?? ""} ${attr(p).warranty_length ?? ""}`;
      return /full/i.test(w) ? "Full Warranty" : /limited|lifetime|year/i.test(w) ? "Limited Warranty" : "";
    },
  },
  { re: /^faucet finish$/i, value: (p) => piecesIncluded(p).includes("Faucet") ? finishValue(p) : "Does Not Apply" },
  { re: /^stainless steel gauge$/i, value: (p) => /stainless/i.test(material(p)) ? num(p.gauge ?? attr(p).gauge) : "Does Not Apply" },
  { re: /number of (faucet |installation |mounting )?holes/i, value: (p) => num(attr(p).number_of_installation_holes) || (isSink(p) ? "0" : "") },
  { re: /^pieces included$/i, value: (p) => piecesIncluded(p) },
  {
    re: /^durability$/i,
    value: (p) =>
      /stainless/i.test(material(p))
        ? ["Rust Resistant", "Stain Resistant", "Heat Resistant"]
        : /quartz|granite|composite/i.test(material(p))
        ? ["Scratch Resistant", "Stain Resistant", "Heat Resistant"]
        : ["Stain Resistant"],
  },
  { re: /^mounting \/ installation$/i, value: (p) => mounting(p) },
  { re: /^drain placement$/i, value: (p) => drainPlacement(p) },
  { re: /^overall shape$/i, value: (p) => shapeNoun(p) },
  { re: /^minimum base cabinet width/i, value: (p) => num(attr(p).min_external_cabinet_size_in) },
  { re: /^product type$/i, value: (p) => isSink(p) ? productType(p) : "" },
  { re: /^material$/i, value: (p) => materialAnswer(p) },
  { re: /^finish$/i, value: (p) => finishValue(p) },
  { re: /^country of origin$/i, value: (p) => text(field(p, "country_of_origin")) },
  { re: /^number of basins$/i, value: (p) => num(p.number_of_bowls ?? attr(p).number_of_bowls) },
];

type Question = {
  id: string;
  displayName: string;
  answerType: string | null;
  isMultiValue: boolean;
  importanceType: string | null;
  possibleAnswers?: { key: string; value: string }[];
  childQuestions?: Question[];
};

// Snap a PIM value to one of Wayfair's valid answers; null = no acceptable match.
function snap(q: Question, raw: string): string | null {
  const opts = (q.possibleAnswers ?? []).map((a) => a.value);
  const value = raw.trim();
  if (!opts.length) return value;
  const v = value.toLowerCase();
  const exact = opts.find((o) => o.toLowerCase() === v);
  if (exact) return exact;
  const alias = FINISH_ALIAS[v];
  if (alias) {
    const hit = opts.find((o) => o.toLowerCase() === alias.toLowerCase());
    if (hit) return hit;
  }
  // Longest option contained in the value ("Quartz Composite" → "Quartz"),
  // else the shortest option that contains the value ("ASME A112.19.3" → full label).
  const inValue = opts.filter((o) => v.includes(o.toLowerCase())).sort((a, b) => b.length - a.length);
  if (inValue.length) return inValue[0];
  const hasValue = opts.filter((o) => o.toLowerCase().includes(v)).sort((a, b) => a.length - b.length);
  if (hasValue.length) return hasValue[0];
  return null;
}
function formatByType(q: Question, value: string): string {
  if (q.answerType === "DECIMAL") return num(value);
  if (q.answerType === "INTEGER") {
    const n = parseInt(num(value), 10);
    return Number.isNaN(n) ? "" : String(n);
  }
  if (q.answerType === "BOOLEAN") {
    const s = value.toLowerCase();
    return /^(yes|true|1)$/.test(s) ? "Yes" : /^(no|false|0)$/.test(s) ? "No" : value;
  }
  return value;
}

type Attr = { attributeId: string; value: string; rank: number; parentRank: number; attributeInstance?: number };
type MediaRow = {
  storage_path: string;
  media_type: string;
  is_primary: boolean;
  display_order: number | null;
  image_role: string | null;
  document_type: string | null;
  language: string | null;
};

function buildProduct(
  p: Product,
  media: MediaRow[],
  questions: Question[],
  opts: { manufacturerId: string; costKey: string; region: string; includeDocuments: boolean },
) {
  const a = attr(p);
  const attrs: Attr[] = [];
  const answered = new Set<string>();
  const missingRequired: string[] = [];
  const unmapped: { title: string; value: string; options?: string[] }[] = [];
  const notes: string[] = [];
  const add = (id: string, value: string, rank = 1, parentRank = 1, instance?: number) => {
    if (value === "" || value == null) return;
    const row: Attr = { attributeId: id, value: String(value), rank, parentRank };
    if (instance != null) row.attributeInstance = instance;
    attrs.push(row);
    answered.add(id);
  };

  // Core identity
  const sku = String(p.sku);
  const productName = text(a.general_title_en) || text(p.quickbooks_description);
  if (productName) add("core::productName", productName);
  else missingRequired.push("Product Name (general_title_en)");
  add("core::supplierPartNumber", sku);
  add("core::manufacturerPartNumber", sku);
  add("core::manufacturerId", opts.manufacturerId);
  const upc = text(field(p, "upc"));
  if (!upc || /^0+$/.test(upc) || upc === "840994000000") notes.push(upc ? "UPC is a placeholder — not sent" : "no UPC in the PIM");
  else add("core::universalProductCode", upc);
  add("core::collectionName", text(p.model_name));
  add("variantGrouping::variantType", "Not Variant");

  // Copy + bullets (deduped, Wayfair caps at 8)
  add("featureDescription::romanceCopy", stripHtml(p.description));
  const seen = new Set<string>();
  const bullets = listOf(field(p, "bullet_points")).filter((b) => {
    const k = b.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (bullets.length > 8) notes.push(`${bullets.length} bullets in the PIM — only the first 8 are sent`);
  bullets.slice(0, 8).forEach((b, i) => add("featureDescription::genericFeatures", b, i + 1));
  if (!bullets.length) notes.push("no bullet points");

  // Media: white-background images (gray SinksDirect hero stays off Wayfair),
  // primary first; documents (EN/universal PDFs) by type.
  const images = media
    .filter((m) => m.media_type === "image" && /^https?:\/\//i.test(m.storage_path ?? "") && m.image_role !== "sinksdirect_main")
    .sort((x, y) => Number(y.is_primary) - Number(x.is_primary) || (x.display_order ?? 0) - (y.display_order ?? 0))
    .slice(0, 16);
  images.forEach((m, i) => add("media::imageValue", m.storage_path, i + 1));
  if (!images.length) notes.push("no images");
  let documents = 0;
  if (opts.includeDocuments) {
    for (const m of media) {
      const type = DOC_TYPES[m.document_type ?? ""];
      if (m.media_type !== "document" || !type || m.language === "fr" || !/\.pdf(\?|$)/i.test(m.storage_path ?? "")) continue;
      documents += 1;
      add("media::documentValue", m.storage_path, documents, 1, documents);
      add("media::documentType", type, documents, 1, documents);
      add("media::regionType", opts.region, documents, 1, documents);
    }
  }

  // Cost, prices, shipping and cartons
  const cost = num(p[opts.costKey]);
  if (cost) add("price::wholesalePrice", cost);
  else missingRequired.push("Base Cost (Wayfair cost)");
  const msrp = num(opts.region === "US" ? p.msrp_usd : p.msrp_cad);
  const map = num(opts.region === "US" ? p.map_usd : p.map_cad);
  add("price::manufacturerSuggestedRetailPrice", msrp);
  add("price::minimumAdvertizedPrice", map);
  add("shippingAndFulfillment::minimumOrderQuantity", "1");
  add("shippingAndFulfillment::forceQuantityMultiplier", "1");
  add("shippingAndFulfillment::displaySetQuantity", "1");
  const shipWeight = num(p.shipping_weight_lb) || num(a.shipping_weight_lb) || num(a.product_weight_lb);
  if (shipWeight) add("shippingAndFulfillment::productWeight", shipWeight);
  else missingRequired.push("Product Weight (shipping weight)");
  add("shippingAndFulfillment::shipType", Number(shipWeight) > 150 ? "LTL" : "Small Parcel");
  add("shippingAndFulfillment::leadTime", "48");
  add("shippingAndFulfillment::replacementLeadTime", "48");
  const box = (a.shipping_dimensions_in ?? {}) as Record<string, unknown>;
  if (shipWeight && num(box.length) && num(box.width) && num(box.height)) {
    add("shippingAndFulfillment::weight", shipWeight, 1, 1, 1);
    add("shippingAndFulfillment::height", num(box.height), 1, 1, 1);
    add("shippingAndFulfillment::width", num(box.width), 1, 1, 1);
    add("shippingAndFulfillment::depth", num(box.length), 1, 1, 1);
  } else {
    missingRequired.push("Carton dimensions (shipping box L×W×H + weight)");
  }
  add("propSixtyFive::warningRequired", /yes|true/i.test(text(a.prop65_warning ?? a.prop_65)) ? "Yes" : "No");

  // Class questions → PIM values (special product-addition answers first,
  // then the shared spec rules). Choice answers are snapped to valid values.
  const ctx = ruleContext(questions.map((q) => q.displayName));
  for (const q of questions) {
    if (!q.answerType || answered.has(q.id)) continue; // group / already set by id
    if (!["REQUIRED", "RECOMMENDED"].includes(q.importanceType ?? "")) continue;
    let raw: Val = "";
    const special = SPECIAL.find((s) => s.re.test(q.displayName));
    if (special) raw = special.value(p);
    else {
      const rule = ruleForTitle(q.displayName);
      if (rule) {
        try { raw = rule(p, ctx); } catch { raw = ""; }
      }
    }
    const values = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v ?? "").trim()).filter(Boolean);
    if (!values.length) {
      if (q.importanceType === "REQUIRED") missingRequired.push(q.displayName);
      continue;
    }
    const accepted: string[] = [];
    for (const v of values) {
      const snapped = snap(q, formatByType(q, v));
      if (snapped == null || snapped === "") {
        unmapped.push({ title: q.displayName, value: v, options: (q.possibleAnswers ?? []).slice(0, 12).map((o) => o.value) });
      } else if (!accepted.includes(snapped)) accepted.push(snapped);
    }
    if (!accepted.length) {
      if (q.importanceType === "REQUIRED") missingRequired.push(q.displayName);
      continue;
    }
    accepted.forEach((v, i) => add(q.id, v, i + 1));
  }

  return { attrs, images: images.length, documents, missingRequired, unmapped, notes };
}

const QUESTIONS_Q = `query questions($request: GetProductAdditionQuestionsRequest!) {
  productAddition {
    questions(request: $request) {
      id displayName answerType isMultiValue importanceType
      possibleAnswers { key value }
      childQuestions { id displayName answerType isMultiValue importanceType possibleAnswers { key value } }
    }
  }
}`;
const BRANDS_Q = `query brandAssociations($request: GetSupplierBrandsAssociationsRequest!) {
  supplierBrand {
    brandAssociations(request: $request) {
      brands { manufacturer { id name } }
      pageInfo { hasNextPage totalPages }
    }
  }
}`;
const CATALOG_Q = `query supplierCatalogItems($input: SupplierCatalogItemsInput!) {
  supplierCatalogItems(input: $input) {
    ... on SupplierCatalogItems { catalogItems { supplierPartNumber } }
  }
}`;
const SUBMIT_M = `mutation submitV2($request: SubmitProductAdditionsRequestV2!) {
  productAddition {
    submitV2(request: $request) {
      productAdditionRequestId batchId status processedProducts
      productResults { productId status validationFlaws { attributeId rank parentRank flawType flaw } }
    }
  }
}`;
const STATUS_Q = `query submissionsV2($request: GetSubmissionStatusRequestV2!) {
  productAddition {
    submissionsV2(request: $request) {
      productAdditionStatus {
        requestId supplierPartNumber classId validationStatus submissionStatus
        validationFlaws { attributeId flawType flaw }
      }
      pagination { totalRecords currentPage totalPages }
    }
  }
}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // --- caller must be an authenticated admin or editor --------------------
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return json({ error: "Missing Authorization header." }, 401);
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) return json({ error: "Invalid or expired session." }, 401);
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", caller.id).maybeSingle();
    if (!["admin", "editor"].includes(profile?.role ?? "")) {
      return json({ error: "Only admins and editors can create Wayfair listings." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const supplier = String(body.supplier ?? "USA");
    const cfg = SUPPLIERS[supplier];
    if (!cfg) return json({ error: `unknown supplier "${supplier}" (use USA or CAN)` }, 400);
    const sandbox = body.sandbox === true || (Deno.env.get("WAYFAIR_ENV") ?? "sandbox") !== "production";
    const validateOnly = body.validateOnly !== false;
    const includeDocuments = body.includeDocuments !== false;

    const CLIENT_ID = Deno.env.get(sandbox ? `${cfg.prefix}_SANDBOX_CLIENT_ID` : `${cfg.prefix}_CLIENT_ID`);
    const CLIENT_SECRET = Deno.env.get(sandbox ? `${cfg.prefix}_SANDBOX_CLIENT_SECRET` : `${cfg.prefix}_CLIENT_SECRET`);
    const SUPPLIER_ID = Deno.env.get(`${cfg.prefix}_SUPPLIER_ID`);
    if (!CLIENT_ID || !CLIENT_SECRET || !SUPPLIER_ID) {
      return json({ error: `Missing ${cfg.prefix}_* ${sandbox ? "sandbox " : ""}secrets for supplier ${supplier}` }, 500);
    }
    const endpoint = sandbox
      ? "https://api.wayfair.io/sandbox/v1/product-catalog-api/graphql"
      : "https://api.wayfair.io/v1/product-catalog-api/graphql";
    const token = await getToken(CLIENT_ID, CLIENT_SECRET);
    const call = async (query: string, variables: unknown, operationName: string) => {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-SELECTED-SUPPLIER-ID": String(SUPPLIER_ID),
          "X-SELECTED-SUPPLIER": String(SUPPLIER_ID),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables, operationName }),
      });
      // Wayfair answers some rejections (bad operation name, gateway limits)
      // with plain text — surface it as a GraphQL-shaped error.
      const raw = await r.text();
      try {
        return JSON.parse(raw);
      } catch {
        return { errors: [{ message: `${operationName}: HTTP ${r.status} ${raw.slice(0, 200)}` }] };
      }
    };
    const env = sandbox ? "sandbox" : "production";

    // --- poll mode ------------------------------------------------------------
    if (body.status) {
      const r = await call(STATUS_Q, {
        request: { productAdditionRequestId: String(body.status), paginationOptions: { page: 1, pageSize: 50 } },
      }, "submissionsV2");
      if (r.errors) return json({ error: r.errors[0]?.message, details: r.errors }, 502);
      const st = r.data?.productAddition?.submissionsV2;
      return json({
        ok: true,
        env,
        supplier,
        requestId: body.status,
        products: (st?.productAdditionStatus ?? []).map((s: Record<string, unknown>) => ({
          sku: s.supplierPartNumber,
          classId: s.classId,
          validationStatus: s.validationStatus,
          submissionStatus: s.submissionStatus,
          errors: ((s.validationFlaws as { attributeId: string; flawType: string; flaw: string }[]) ?? []).filter((f) => f.flawType === "ERROR"),
          warnings: ((s.validationFlaws as { attributeId: string; flawType: string; flaw: string }[]) ?? []).filter((f) => f.flawType !== "ERROR"),
        })),
        total: st?.pagination?.totalRecords ?? 0,
      });
    }

    // --- build + submit ------------------------------------------------------
    const skus: string[] = Array.isArray(body.skus) ? body.skus.map(String) : body.sku ? [String(body.sku)] : [];
    if (!skus.length) return json({ error: "skus[] is required" }, 400);
    if (skus.length > 30) return json({ error: "max 30 SKUs per call" }, 400);

    const { data: products, error: pErr } = await supabase.from("products").select("*").in("sku", skus);
    if (pErr) return json({ error: `PIM read failed: ${pErr.message}` }, 500);
    const { data: mediaRows } = await supabase
      .from("product_media")
      .select("sku, storage_path, media_type, is_primary, display_order, image_role, document_type, language")
      .in("sku", skus);
    const mediaBySku = new Map<string, MediaRow[]>();
    for (const m of (mediaRows ?? []) as (MediaRow & { sku: string })[]) {
      mediaBySku.set(m.sku, [...(mediaBySku.get(m.sku) ?? []), m]);
    }

    const skipped: { sku: string; reason: string }[] = [];
    for (const s of skus) if (!(products ?? []).some((p) => p.sku === s)) skipped.push({ sku: s, reason: "not in the PIM" });

    // Already listed? Product Addition would create a duplicate — refuse unless forced.
    const existing = new Set<string>();
    const cat = await call(CATALOG_Q, {
      input: { filter: { supplierPartNumbers: skus }, paginationOptions: { page: 1, pageSize: 30 } },
    }, "supplierCatalogItems");
    if (!cat.errors) for (const it of cat.data?.supplierCatalogItems?.catalogItems ?? []) existing.add(it.supplierPartNumber);

    // Manufacturer (brand) id — Wayfair only accepts its own id via core::manufacturerId
    const brandsR = await call(BRANDS_Q, {
      request: { supplierId: Number(SUPPLIER_ID), marketContext: cfg.market, page: 1, pageSize: 50 },
    }, "brandAssociations");
    if (brandsR.errors) return json({ error: `brandAssociations: ${brandsR.errors[0]?.message}`, details: brandsR.errors }, 502);
    const brands: { id: string; name: string }[] = (brandsR.data?.supplierBrand?.brandAssociations?.brands ?? [])
      .map((b: { manufacturer: { id: string; name: string } }) => b.manufacturer).filter(Boolean);
    const manufacturerFor = (p: Product) => {
      const want = text(p.brand).toLowerCase();
      return brands.find((b) => b.name.toLowerCase() === want) ??
        brands.find((b) => b.name.toLowerCase().includes(want) || want.includes(b.name.toLowerCase())) ??
        (brands.length === 1 ? brands[0] : undefined);
    };

    const questionsByClass = new Map<string, Question[]>();
    const proposed: { productId: string; classId: string; attributes: Attr[] }[] = [];
    const report: Record<string, unknown>[] = [];
    for (const p of (products ?? []) as Product[]) {
      const sku = String(p.sku);
      if (existing.has(sku) && !body.force) {
        skipped.push({ sku, reason: `already in the Wayfair ${supplier} catalog — use Push, not Product Addition` });
        continue;
      }
      const cls = body.classId ? { classId: String(body.classId), className: "override" } : classFor(p);
      if (!cls) { skipped.push({ sku, reason: `no Wayfair class for category "${p.category}"` }); continue; }
      const manufacturer = manufacturerFor(p);
      if (!manufacturer) {
        skipped.push({ sku, reason: `brand "${p.brand}" is not associated to supplier ${SUPPLIER_ID} on Wayfair (${brands.map((b) => b.name).join(", ") || "no brands"})` });
        continue;
      }
      let questions = questionsByClass.get(cls.classId);
      if (!questions) {
        const qr = await call(QUESTIONS_Q, { request: { classId: Number(cls.classId), marketContext: cfg.market } }, "questions");
        if (qr.errors) {
          return json({
            error: `questions for class ${cls.classId}: ${qr.errors[0]?.message} (the app needs read:product_addition_questions)`,
            details: qr.errors,
          }, 502);
        }
        questions = (qr.data?.productAddition?.questions ?? []) as Question[];
        questionsByClass.set(cls.classId, questions);
      }
      const built = buildProduct(p, mediaBySku.get(sku) ?? [], questions, {
        manufacturerId: String(manufacturer.id),
        costKey: cfg.costKey,
        region: cfg.region,
        includeDocuments,
      });
      proposed.push({ productId: sku, classId: cls.classId, attributes: built.attrs });
      report.push({
        sku,
        classId: cls.classId,
        className: cls.className,
        manufacturer: manufacturer.name,
        attributes: built.attrs.length,
        images: built.images,
        documents: built.documents,
        missingRequired: built.missingRequired,
        unmapped: built.unmapped,
        notes: built.notes,
      });
    }

    if (!proposed.length) return json({ ok: false, env, supplier, error: "nothing to submit", skipped }, 400);

    // Wayfair validates a V2 request against ONE class: a mixed batch gets
    // every product judged by the first product's class (seen 2026-09-02).
    // One submitV2 per class.
    const byClass = new Map<string, typeof proposed>();
    for (const pp of proposed) byClass.set(pp.classId, [...(byClass.get(pp.classId) ?? []), pp]);
    type Flaw = { attributeId: string; flawType: string; flaw: string };
    const requests: Record<string, unknown>[] = [];
    const resultBySku = new Map<string, { status: string; validationFlaws: Flaw[] }>();
    const requestBySku = new Map<string, string>();
    const payloads: unknown[] = [];
    for (const [classId, items] of byClass) {
      const request = {
        marketContext: cfg.market,
        jobContext: { productAdditionRequestId: null, hasMoreProducts: false },
        options: { validateOnly, ignoreWarnings: true, rejectAllOnErrors: false },
        proposedProductAdditions: items,
      };
      if (body.debug) payloads.push(request);
      const r = await call(SUBMIT_M, { request }, "submitV2");
      if (r.errors) {
        requests.push({ classId, error: r.errors[0]?.message, details: r.errors });
        continue;
      }
      const res = r.data?.productAddition?.submitV2;
      requests.push({
        classId,
        requestId: res?.productAdditionRequestId ?? null,
        batchId: res?.batchId ?? null,
        status: res?.status ?? null,
        processed: res?.processedProducts ?? 0,
      });
      for (const pr of res?.productResults ?? []) {
        resultBySku.set(pr.productId, pr);
        if (res?.productAdditionRequestId) requestBySku.set(pr.productId, res.productAdditionRequestId);
      }
    }
    const products_ = report.map((row) => {
      const sku = String(row.sku);
      const pr = resultBySku.get(sku);
      const flaws = pr?.validationFlaws ?? [];
      const failed = requests.find((q) => q.classId === row.classId && q.error);
      return {
        ...row,
        requestId: requestBySku.get(sku) ?? null,
        status: pr?.status ?? (failed ? "REJECTED" : null),
        errors: [
          ...(failed ? [{ attributeId: "request", flaw: String(failed.error) }] : []),
          ...flaws.filter((f) => f.flawType === "ERROR").map((f) => ({ attributeId: f.attributeId, flaw: f.flaw })),
        ],
        warnings: flaws.filter((f) => f.flawType !== "ERROR").map((f) => ({ attributeId: f.attributeId, flaw: f.flaw })),
      };
    });

    return json({
      ok: true,
      env,
      supplier,
      market: cfg.market.country,
      validateOnly,
      requestId: requests.length === 1 ? requests[0].requestId ?? null : null,
      requests,
      products: products_,
      skipped,
      payload: body.debug ? payloads : undefined,
    });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
