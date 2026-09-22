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
//   supplier?: "USA" | "CAN" = "USA",   // whose credentials / supplier id / cost
//   market?: "US" | "CA",             // marketContext override (CAN defaults to US, see below)
//   validateOnly?: boolean = true,
//   sandbox?: boolean = false,     // hit the sandbox with the *_SANDBOX_* app
//   force?: boolean = false,       // also submit SKUs already in the catalog
//   preview?: boolean = false,     // build only: returns every mapped attribute
//                                  // (title, value) per SKU, listed or not,
//                                  // and never calls submitV2
//   classId?: string,              // override the class for every SKU
//   includeDocuments?: boolean = true,
//   status?: string,               // poll mode: productAdditionRequestId
//   questions?: string,            // list mode: the class id whose questions to return
// }
//
// Secrets: WAYFAIR_USA_CLIENT_ID/SECRET/SUPPLIER_ID (+ WAYFAIR_USA_SANDBOX_CLIENT_ID/SECRET),
//          WAYFAIR_CLIENT_ID/SECRET/SUPPLIER_ID for CAN, WAYFAIR_ENV.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isExcluded, excludedMessage } from "../_shared/exclusions.ts";
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

// ---- Faucet answers (Bathroom Sink Faucets 655 / Kitchen Faucets 653;
// vocabularies read from the class questions 2026-09-15) ----
const isFaucet = (p: Product) => /faucet/.test(String(p.category ?? ""));
const isBathFaucet = (p: Product) => String(p.category ?? "") === "bathroom_faucet";
const handles = (p: Product) => parseInt(num(attr(p).number_of_handles), 10) || 0;
const holes = (p: Product) => parseInt(num(attr(p).number_of_installation_holes), 10) || 0;
// First option of the question that matches one of the candidate patterns.
const pick = (q: Question | undefined, ...cands: RegExp[]): string => {
  const opts = (q?.possibleAnswers ?? []).map((a) => a.value);
  for (const re of cands) {
    const hit = opts.find((o) => re.test(o));
    if (hit) return hit;
  }
  return "";
};
function faucetProductType(p: Product, q: Question): string {
  const t = `${p.product_type ?? ""} ${attr(p).spout_type ?? ""} ${attr(p).spray_type ?? ""} ${attr(p).general_title_en ?? ""}`;
  if (isBathFaucet(p)) return handles(p) <= 1 ? pick(q, /mono basin mixer/i) : "";
  if (/pot ?filler/i.test(t)) return pick(q, /pot filler/i);
  if (/\bbar\b|beverage|prep/i.test(t)) return pick(q, /bar faucet/i);
  if (/pull.?down/i.test(t)) return pick(q, /pull-?down/i);
  if (handles(p) >= 2) return pick(q, /double handle/i);
  return pick(q, /single handle kitchen/i, /^standard$/i);
}
function faucetMounting(p: Product, q: Question): string {
  const m = `${attr(p).mounting_type ?? ""} ${attr(p).installation_type ?? ""}`.toLowerCase();
  if (/wall/.test(m)) return pick(q, /^wall$/i);
  if (/vessel/.test(m)) return pick(q, /vessel/i);
  if (/single|one hole|1 hole/.test(m) || holes(p) === 1) return pick(q, /single-?hole/i);
  const centers = num(attr(p).faucet_centers);
  if (Number(centers) >= 8) return pick(q, /widespread/i);
  if (Number(centers) === 4) return pick(q, /centerset/i);
  if (/widespread/.test(m)) return pick(q, /widespread/i);
  if (/centerset/.test(m)) return pick(q, /centerset/i);
  return "";
}
// Faucet Centers is a DECIMAL: a one-hole faucet has no spread → 0.
const faucetCenters = (p: Product) => {
  const v = num(attr(p).faucet_centers);
  if (v) return v;
  return holes(p) === 1 || /single|one hole/i.test(String(attr(p).mounting_type ?? "")) ? "0" : "";
};
// Plating = the coating named by the finish. Black / gunmetal / graphite
// finishes are coatings, not platings → "Does Not Apply".
function platingMaterial(p: Product, q: Question): string {
  const explicit = text(attr(p).plating_material);
  if (explicit) return explicit;
  const f = text(p.finish).toLowerCase();
  if (!f) return "";
  if (/chrome/.test(f)) return pick(q, /^chrome$/i);
  if (/nickel/.test(f)) return pick(q, /^nickel$/i);
  if (/stainless/.test(f)) return pick(q, /stainless/i);
  if (/gold|brass/.test(f)) return pick(q, /^brass$/i);
  if (/bronze/.test(f)) return pick(q, /^bronze$/i);
  if (/copper/.test(f)) return pick(q, /^copper$/i);
  if (/black|gunmetal|graphite|white/.test(f)) return pick(q, /does not apply/i);
  return "";
}
// Title 24: only an explicit PIM answer counts ("Ask Technical Team" = unknown).
const title24 = (p: Product) => {
  const v = text(attr(p).title_24_compliant).toLowerCase();
  if (!v || /ask/.test(v)) return "";
  if (/not|non|no\b/.test(v)) return "No";
  if (/compliant|yes|true/.test(v)) return "Yes";
  return "";
};
// Faucets certified cUPC are tested to ASME A112.18.1 / CSA B125.1.
const plumbingFixtures = (p: Product, q: Question) => {
  const asme = text(attr(p).asme_csa_certified);
  if (/112\.18\.1/.test(asme)) return pick(q, /112\.18\.1/);
  const cupc = `${attr(p).cupc_certified ?? ""} ${safetyListings(p)}`;
  if (/yes|cupc|upc/i.test(cupc)) return pick(q, /112\.18\.1/);
  if (/^no$/i.test(text(attr(p).cupc_certified))) return "No";
  return "";
};
const faucetShape = (p: Product, q: Question) => {
  // The PIM's "Overall Shape" (Wayfair's own list) wins; Spout Type is the fallback.
  const explicit = text(attr(p).overall_shape ?? p.shape ?? attr(p).shape);
  if (explicit) return explicit;
  const spout = text(attr(p).spout_type).toLowerCase();
  if (/gooseneck|high arc/.test(spout)) return pick(q, /gooseneck/i);
  if (/straight|rigid/.test(spout)) return pick(q, /^straight$/i);
  if (/low arc|curved/.test(spout)) return pick(q, /^curved$/i);
  return "";
};

// Product Addition questions that need a different answer than the spec push
// (compliance defaults, choice vocabularies, "Does Not Apply" fallbacks).
// Multi-choice answers return string[]; "" or [] = no value. Rules get the
// question too, to pick among ITS valid answers (vocabularies differ per class).
type Val = string | string[];
const SPECIAL: Array<{ re: RegExp; value: (p: Product, q: Question) => Val }> = [
  // Faucets (the shared spec rules skip "Maximum …" titles on purpose)
  { re: /^maximum flow rate$/i, value: (p) => num(attr(p).max_flow_rate) },
  { re: /^handle style$/i, value: (p, q) => (isFaucet(p) ? pick(q, new RegExp(`^${text(attr(p).handle_style)}$`, "i")) || text(attr(p).handle_style) : "") },
  { re: /^faucet centers$/i, value: (p) => (isFaucet(p) ? faucetCenters(p) : "") },
  { re: /^title 24/i, value: (p) => title24(p) },
  { re: /^plumbing fixtures compliant$/i, value: (p, q) => (isFaucet(p) ? plumbingFixtures(p, q) : "") },
  { re: /^plating material$/i, value: (p, q) => (isFaucet(p) ? platingMaterial(p, q) : "") },
  // Product weight: the PIM's product weight, else the shipping weight
  // (noted in the report).
  { re: /^overall product weight$/i, value: (p) => num(p.weight_lb ?? attr(p).product_weight_lb) || num(p.shipping_weight_lb) || num(attr(p).shipping_weight_lb) },
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
  { re: /^mounting \/ installation$/i, value: (p, q) => (isFaucet(p) ? faucetMounting(p, q) : mounting(p)) },
  { re: /^drain placement$/i, value: (p) => drainPlacement(p) },
  { re: /^overall shape$/i, value: (p, q) => (isFaucet(p) ? faucetShape(p, q) : shapeNoun(p)) },
  { re: /^minimum base cabinet width/i, value: (p) => num(attr(p).min_external_cabinet_size_in) },
  { re: /^product type$/i, value: (p, q) => (isSink(p) ? productType(p) : isFaucet(p) ? faucetProductType(p, q) : "") },
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

type Attr = { attributeId: string; value: string; rank: number; parentRank: number; attributeInstance: number };
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
  opts: {
    manufacturerId: string; costKey: string; region: string; includeDocuments: boolean;
    // Variant grouping: join an existing Wayfair item group (its id) or start
    // a new one with the family members of this batch. Finish is the axis.
    group?: { referenceId: string; primary: boolean; existing: boolean };
  },
) {
  const a = attr(p);
  const attrs: Attr[] = [];
  const answered = new Set<string>();
  const missingRequired: string[] = [];
  const unmapped: { title: string; value: string; options?: string[] }[] = [];
  const notes: string[] = [];
  // Wayfair's AttributeInput (schema descriptions, 2026-09-21):
  //   rank        = n-th VALUE of one MULTI_CHOICE answer (Durability: Rust, Stain…)
  //   parentRank  = n-th ANSWER of a multi-valued attribute (isMultiValue: each
  //                 image, each document, each feature bullet)
  //   attributeInstance = multi-instance groups such as cartons (carton 1, 2…)
  // Images sent as ranks of one answer left Wayfair with a single image (B-112B).
  const add = (id: string, value: string, rank = 1, parentRank = 1, instance = 1) => {
    if (value === "" || value == null) return;
    const row: Attr = { attributeId: id, value: String(value), rank, parentRank, attributeInstance: instance };
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
  if (opts.group) {
    add("variantGrouping::variantType", opts.group.primary ? "Primary Variant" : "Non-Primary Variant");
    add("variantGrouping::groupReferenceId", opts.group.referenceId);
    add("variantGrouping::variantGrouping", "Finish");
    add("variantGrouping::variantAttributeNameOnSite", "Finish");
    notes.push(opts.group.existing
      ? `variant of the existing Wayfair group ${opts.group.referenceId} (Finish axis)`
      : `${opts.group.primary ? "primary" : "non-primary"} variant of new group ${opts.group.referenceId} (Finish axis)`);
  } else {
    add("variantGrouping::variantType", "Not Variant");
  }
  if (!num(p.weight_lb ?? a.product_weight_lb) && (num(p.shipping_weight_lb) || num(a.shipping_weight_lb))) {
    notes.push("no product weight in the PIM — the shipping weight is sent as Overall Product Weight");
  }

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
  bullets.slice(0, 8).forEach((b, i) => add("featureDescription::genericFeatures", b, 1, i + 1));
  if (!bullets.length) notes.push("no bullet points");

  // Media: white-background images (gray SinksDirect hero stays off Wayfair),
  // primary first; documents (EN/universal PDFs) by type.
  const images = media
    .filter((m) => m.media_type === "image" && /^https?:\/\//i.test(m.storage_path ?? "") && m.image_role !== "sinksdirect_main")
    .sort((x, y) => Number(y.is_primary) - Number(x.is_primary) || (x.display_order ?? 0) - (y.display_order ?? 0))
    .slice(0, 16);
  images.forEach((m, i) => add("media::imageValue", m.storage_path, 1, i + 1));
  if (!images.length) notes.push("no images");
  let documents = 0;
  if (opts.includeDocuments) {
    for (const m of media) {
      const type = DOC_TYPES[m.document_type ?? ""];
      if (m.media_type !== "document" || !type || m.language === "fr" || !/\.pdf(\?|$)/i.test(m.storage_path ?? "")) continue;
      documents += 1;
      add("media::documentValue", m.storage_path, 1, documents);
      add("media::documentType", type, 1, documents);
      add("media::regionType", opts.region, 1, documents);
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
    if (special) raw = special.value(p, q);
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

// Every attribute row of a built product as { id, title, value, group } —
// what the PIM shows as "all mapped attributes". Values of one attribute
// (bullets, images, multi-choice) are joined; media shows the file name.
const GROUP_OF: [RegExp, string][] = [
  [/^core::|^variantGrouping::/, "Listing"],
  [/^featureDescription::/, "Copy"],
  [/^media::/, "Media"],
  [/^price::/, "Pricing"],
  [/^shippingAndFulfillment::|^propSixtyFive::/, "Shipping & compliance"],
];
function describeAttrs(attrs: Attr[], questions: Question[]) {
  const title = new Map<string, string>();
  const walk = (q: Question) => { title.set(String(q.id), q.displayName); for (const c of q.childQuestions ?? []) walk(c); };
  for (const q of questions) walk(q);
  title.set("core::manufacturerId", "Manufacturer (Wayfair id)");
  const rows = new Map<string, { id: string; title: string; value: string[]; group: string }>();
  for (const a of attrs) {
    const value = /^media::(image|document|video)Value$/.test(a.attributeId) ? a.value.split("/").pop()!.split("?")[0] : a.value;
    const row = rows.get(a.attributeId) ?? { id: a.attributeId, title: title.get(a.attributeId) ?? a.attributeId, value: [], group: GROUP_OF.find(([re]) => re.test(a.attributeId))?.[1] ?? "Specifications" };
    row.value.push(value);
    rows.set(a.attributeId, row);
  }
  return [...rows.values()].map((r) => ({ ...r, value: r.value.join(" | ") }));
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
    const base = SUPPLIERS[supplier];
    if (!base) return json({ error: `unknown supplier "${supplier}" (use USA or CAN)` }, 400);
    // marketContext override ("US" | "CA"). Wayfair's Product Addition API
    // answers brands / questions for the Canadian supplier (31948) ONLY under
    // the UNITED_STATES market context (CANADA returns no brands and
    // "problems with our internal systems", seen 2026-09-15) — so CAN
    // defaults to the US context while keeping its own credentials, supplier
    // id and CAD cost.
    const marketOverride = String(body.market ?? (supplier === "CAN" ? "US" : "")).toUpperCase();
    const cfg = marketOverride === "US" ? { ...base, market: SUPPLIERS.USA.market } : marketOverride === "CA" ? { ...base, market: SUPPLIERS.CAN.market } : base;
    const sandbox = body.sandbox === true || (Deno.env.get("WAYFAIR_ENV") ?? "sandbox") !== "production";
    const validateOnly = body.validateOnly !== false;
    const includeDocuments = body.includeDocuments !== false;
    const preview = body.preview === true;

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

    // --- brands mode: raw brand associations of the supplier (diagnostics) --
    if (body.brands) {
      const out: Record<string, unknown> = {};
      for (const [label, request] of Object.entries({
        market: { supplierId: Number(SUPPLIER_ID), marketContext: cfg.market, page: 1, pageSize: 50 },
        usMarket: { supplierId: Number(SUPPLIER_ID), marketContext: SUPPLIERS.USA.market, page: 1, pageSize: 50 },
        noMarket: { supplierId: Number(SUPPLIER_ID), page: 1, pageSize: 50 },
      })) {
        const r = await call(BRANDS_Q, { request }, "brandAssociations");
        out[label] = r.errors ? { errors: r.errors } : r.data?.supplierBrand?.brandAssociations;
      }
      return json({ ok: true, env, supplier, supplierId: SUPPLIER_ID, ...out });
    }

    // --- questions mode: the class's Product Addition questions with their
    // valid answers (to write / check mapping rules) -------------------------
    if (body.questions) {
      const classId = String(body.classId ?? body.questions);
      const qr = await call(QUESTIONS_Q, { request: { classId: Number(classId), marketContext: cfg.market } }, "questions");
      if (qr.errors) return json({ error: qr.errors[0]?.message, details: qr.errors }, 502);
      return json({ ok: true, env, supplier, classId, questions: qr.data?.productAddition?.questions ?? [] });
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

    // Family → variant grouping. Wayfair's Product Addition groups ONLY the
    // products of one submission (2+ parts, exactly one primary): a single
    // new member CANNOT be attached to an existing item group through the
    // API (rejected 2026-09-16: "Listing must contain at least 2 products").
    // So: 2+ family members in this batch start a new group (first member
    // primary); a lone member goes as Not Variant and the report says which
    // existing group Wayfair should merge it into afterwards.
    const groupCol = supplier === "CAN" ? "wayfair_item_group_id" : "wayfair_usa_item_group_id";
    const families = [...new Set((products ?? []).map((p) => p.family_number).filter((f) => f != null))];
    const groupByFamily = new Map<string, string>();
    if (families.length) {
      const { data: fam } = await supabase.from("products").select(`family_number, ${groupCol}`).in("family_number", families).not(groupCol, "is", null);
      for (const r of (fam ?? []) as Record<string, unknown>[]) {
        if (r[groupCol]) groupByFamily.set(String(r.family_number), String(r[groupCol]));
      }
    }
    const batchByFamily = new Map<string, number>();
    for (const p of (products ?? []) as Product[]) if (p.family_number != null) batchByFamily.set(String(p.family_number), (batchByFamily.get(String(p.family_number)) ?? 0) + 1);
    const primarySeen = new Set<string>();
    const groupFor = (p: Product) => {
      if (p.family_number == null) return undefined;
      const fam = String(p.family_number);
      if ((batchByFamily.get(fam) ?? 0) >= 2) {
        const primary = !primarySeen.has(fam);
        primarySeen.add(fam);
        return { referenceId: `FAM-${fam}`, primary, existing: false };
      }
      return undefined;
    };
    const existingGroupFor = (p: Product) => (p.family_number == null ? undefined : groupByFamily.get(String(p.family_number)));

    const questionsByClass = new Map<string, Question[]>();
    const proposed: { productId: string; classId: string; attributes: Attr[] }[] = [];
    const report: Record<string, unknown>[] = [];
    for (const p of (products ?? []) as Product[]) {
      const sku = String(p.sku);
      const exclusionKey = supplier === "USA" ? "wayfair_us" : "wayfair_ca";
      if (isExcluded(p, exclusionKey)) { skipped.push({ sku, reason: excludedMessage(sku, exclusionKey) }); continue; }
      if (existing.has(sku) && !body.force && !preview) {
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
      const group = groupFor(p);
      const existingGroup = group ? undefined : existingGroupFor(p);
      const built = buildProduct(p, mediaBySku.get(sku) ?? [], questions, {
        manufacturerId: String(manufacturer.id),
        costKey: cfg.costKey,
        region: cfg.region,
        includeDocuments,
        group,
      });
      proposed.push({ productId: sku, classId: cls.classId, attributes: built.attrs });
      report.push({
        sku,
        classId: cls.classId,
        className: cls.className,
        manufacturer: manufacturer.name,
        attributes: built.attrs.length,
        listed: existing.has(sku),
        mapped: describeAttrs(built.attrs, questions),
        variant: group
          ? `${group.primary ? "primary" : "non-primary"} variant, new group ${group.referenceId}`
          : existingGroup
          ? `created alone — ask Wayfair to merge it into group ${existingGroup}`
          : "not a variant",
        images: built.images,
        documents: built.documents,
        missingRequired: built.missingRequired,
        unmapped: built.unmapped,
        notes: existingGroup
          ? [...built.notes, `its family is already on Wayfair as group ${existingGroup}; the API cannot attach one new product to an existing group — after creation, ask Wayfair (Partner Home ticket) to merge it into ${existingGroup} with Finish as the variant axis`]
          : built.notes,
      });
    }

    if (!proposed.length) return json({ ok: false, env, supplier, error: "nothing to submit", skipped }, 400);

    if (preview) {
      return json({ ok: true, env, supplier, market: cfg.market.country, preview: true, validateOnly: true, requestId: null, requests: [], products: report.map((row) => ({ ...row, status: "PREVIEW", errors: [], warnings: [] })), skipped });
    }

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
