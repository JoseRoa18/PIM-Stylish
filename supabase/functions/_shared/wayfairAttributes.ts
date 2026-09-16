// Wayfair taxonomy attribute mapping — PIM product → value for a Wayfair
// attribute TITLE. Shared by wayfair-push-attributes (spec updates on live
// items) and wayfair-add-products (Product Addition v2), so a listing is
// created with exactly the values a later audit would push.
//
// Rules are keyed by attribute title (the API exposes titles per class);
// exact titles first, then axis patterns. A rule returning "" means "no PIM
// value; skip".

export type Product = Record<string, unknown> & { attributes?: Record<string, unknown> };
export const attr = (p: Product) => (p.attributes ?? {}) as Record<string, unknown>;

export const num = (v: unknown): string => {
  if (v == null || v === "") return "";
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? m[0] : "";
};
export const yesNo = (v: unknown): string => {
  if (v == null || v === "") return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  const s = String(v).toLowerCase();
  if (s.includes("yes") || s === "true" || s === "1") return "Yes";
  if (s.includes("no") || s === "false" || s === "0") return "No";
  return "";
};
export const dim = (p: Product, group: string, axis: string): string => {
  const g = attr(p)[group] as Record<string, unknown> | undefined;
  return num(g?.[axis]);
};

// PIM finish → Wayfair "Finish" valid values (mirrors the Excel export aliases)
export const FINISH_ALIAS: Record<string, string> = {
  "brushed stainless steel": "Stainless Steel",
  "grey": "Matte Grey",
  "gray": "Matte Grey",
  "black": "Matte Black",
  "white": "Matte White",
  "graphite black": "Gunmetal Black",
  "nano graphite black dura-tek": "Gunmetal Black",
  // Bare "Dura-Tek" (outdoor/utility sinks) is a protective coating on
  // STAINLESS sinks — the visible finish Wayfair's list can express is
  // Stainless Steel.
  "dura-tek": "Stainless Steel",
  // Validated against the templates' Valid Values sheets 2026-08-19.
  "glossy black": "Gloss Black",
  "gunmetal": "Gun Metal",
  "matte black with brushed gold": "Matte Black; Brushed Gold",
  "dark grey": "Matte Grey",
  "dark gray": "Matte Grey",
};
// Raw PIM finish; the alias to Wayfair's canonical option is applied by the
// caller only when the literal value isn't already accepted.
export const finish = (v: unknown): string => (v ? String(v) : "");

// ---- Category / accessory helpers (rules below) ----
export type RuleValue = string | string[];
const cat = (p: Product) => String(p.category ?? "");
export const isSinkCat = (p: Product) => /sink/.test(cat(p));
export const isFaucetCat = (p: Product) => /faucet/.test(cat(p));
const isKitchenLike = (p: Product) => /kitchen_sink|bar_prep_sink/.test(cat(p));
const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean)
    : String(v ?? "").trim() ? String(v).split(/[;,/]|\band\b/i).map((x) => x.trim()).filter(Boolean) : [];
const accessories = (p: Product): string[] => listOf(attr(p).accessories_included);
const bullets = (p: Product): string => listOf(attr(p).bullet_points).join(" ");
// "ST-03 Strainer (x2)" → 2; "A-04 Colander" → 1
const countIn = (items: string[], re: RegExp): number =>
  items.filter((a) => re.test(a)).reduce((n, a) => n + (Number(a.match(/\(x\s*(\d+)\)/i)?.[1]) || 1), 0);
// Model codes in accessory lines ("ST-05 Strainer (x2)" → ST-05; "ST03 Strainer" → ST-03)
const codesIn = (items: string[], re: RegExp): string[] =>
  [...new Set(items.filter((a) => re.test(a)).map((a) => a.match(/\b([A-Z]{1,2})-?(\d{2,4}[A-Z]{0,3})\b/)?.slice(1).join("-") ?? "").filter(Boolean))];
const partList = (v: unknown): string => {
  const parts = listOf(v).map((x) => x.trim()).filter((x) => x && !/does not app/i.test(x));
  return parts.length ? parts.join(", ") : /does not app/i.test(String(v ?? "")) ? "Does Not Apply" : "";
};
const installText = (p: Product) =>
  `${attr(p).installation_type ?? ""} ${listOf(attr(p).installation_types).join(" ")} ${p.product_type ?? ""}`.toLowerCase();
const isFarmhouse = (p: Product) => /farm|apron/.test(installText(p));
const soundDampened = (p: Product) => /sound|noise|quiet|dampen/i.test(bullets(p)) || /sound|noise|quiet/i.test(String(p.description ?? ""));
const hasWarranty = (p: Product) => Boolean(attr(p).warranty || attr(p).warranty_length);
const holes = (p: Product) => Number(num(attr(p).number_of_installation_holes)) || 0;
const handleCount = (p: Product) => Number(num(attr(p).number_of_handles)) || 0;

// Sinks: "Rectangle" nouns (Wayfair's Overall Shape); faucets: from the PIM's
// Overall Shape field, else the spout type.
export const overallShape = (p: Product): string => {
  if (isFaucetCat(p)) {
    const explicit = String(attr(p).overall_shape ?? "").trim();
    if (explicit) return explicit;
    const spout = String(attr(p).spout_type ?? "").toLowerCase();
    if (/gooseneck|high arc/.test(spout)) return "Gooseneck / High Arc";
    if (/rigid|straight|fixed/.test(spout)) return "Straight";
    if (/low arc|curved/.test(spout)) return "Curved";
    return "";
  }
  const sh = String(p.shape ?? attr(p).sink_shape ?? "").toLowerCase();
  if (!sh) return "";
  if (/rect/.test(sh)) return "Rectangle";
  if (/squar/.test(sh)) return "Square";
  if (/round|circ/.test(sh)) return "Round";
  if (/oval/.test(sh)) return "Oval";
  if (/d-?shap/.test(sh)) return "D-Shape";
  return "";
};
// Wayfair's "Mounting / Installation" (multi). "Mounting / Installation
// Required" rides along on every item Wayfair holds for us.
export const mountingInstallation = (p: Product): string[] => {
  if (isFaucetCat(p)) {
    const m = `${attr(p).mounting_type ?? ""} ${attr(p).installation_type ?? ""}`.toLowerCase();
    const out: string[] = [];
    if (/wall/.test(m)) out.push("Wall");
    else if (/vessel/.test(m)) out.push("Vessel");
    else if (/single|one hole|1 hole/.test(m) || holes(p) === 1) out.push("Single-Hole");
    else if (/widespread/.test(m) || Number(num(attr(p).faucet_centers)) >= 8) out.push("Widespread");
    else if (/centerset/.test(m) || Number(num(attr(p).faucet_centers)) === 4) out.push("Centerset");
    return out.length ? [...out, "Mounting / Installation Required"] : [];
  }
  const t = installText(p);
  if (!t.trim()) return [];
  const out = new Set<string>();
  if (/dual/.test(t)) { out.add("Drop-In"); out.add("Dual Mount"); out.add("Undermount"); }
  if (/under/.test(t)) out.add("Undermount");
  if (/drop|top ?mount/.test(t)) out.add("Drop-In");
  if (/farm|apron/.test(t)) out.add("Farmhouse / Apron");
  if (/wall/.test(t)) out.add("Wall");
  if (/vessel/.test(t)) out.add("Vessel");
  return out.size ? [...out, "Mounting / Installation Required"] : [];
};
export const drainPlacement = (p: Product): string => {
  const d = String(attr(p).drain_hole_location ?? attr(p).drain_position ?? "").toLowerCase();
  if (!d) return "";
  // Wayfair's list: Front, Back, Centre, Left, Right, Reversible, Centre-Back, Centre-Front.
  if (/revers/.test(d)) return "Reversible";
  if (/(rear|back).*cent|cent.*(rear|back)/.test(d)) return "Centre-Back";
  if (/front.*cent|cent.*front/.test(d)) return "Centre-Front";
  if (/rear|back/.test(d)) return "Back";
  if (/front/.test(d)) return "Front";
  if (/left/.test(d)) return "Left";
  if (/right/.test(d)) return "Right";
  if (/cent/.test(d)) return "Centre";
  return "";
};
export const piecesIncluded = (p: Product): string[] => {
  const out = new Set<string>();
  if (isFaucetCat(p)) {
    const a = attr(p);
    if (yesNo(a.supply_line_included) === "Yes") out.add("Supply Line");
    if (yesNo(a.aerator_included) === "Yes") out.add("Aerator");
    if (yesNo(a.valve_included) === "Yes") out.add("Valve");
    if (yesNo(a.handles_included) === "Yes") out.add("Handle(s)");
    if (yesNo(a.deck_plate_included) === "Yes") out.add("Deck Plate");
    if (/drain/i.test(accessories(p).join(" "))) out.add("Drain Assembly");
    return [...out];
  }
  const acc = accessories(p).join(" | ").toLowerCase();
  if (/cutting board|bamboo board/.test(acc)) out.add("Cutting Board");
  if (/colander/.test(acc)) out.add("Colander");
  if (/strainer/.test(acc) || attr(p).strainer_model) { out.add("Basket Strainer"); out.add("Drain Assembly"); }
  if (/grid/.test(acc) || attr(p).includes_grids === true) out.add("Sink Grid");
  if (/faucet/.test(acc)) out.add("Faucet");
  if (/soap/.test(acc)) out.add("Soap / Lotion Dispenser");
  if (/template/.test(acc)) out.add("Cut Out Template");
  if (/hardware|clip/.test(acc) || /under|dual|drop|top ?mount/.test(installText(p))) out.add("Mounting Hardware");
  return [...out];
};
const isWorkstation = (p: Product) =>
  /workstation/i.test(String(p.product_type ?? "")) || attr(p).has_workstation === true ||
  /cutting board|drying rack|colander|bamboo board/i.test(accessories(p).join(" "));
export const productType = (p: Product): string => {
  if (isKitchenLike(p)) {
    if (isWorkstation(p)) return "Kitchen Sink Workstation";
    if (/bar|prep/i.test(`${cat(p)} ${p.product_type ?? ""}`)) return "Prep Sink";
    return "Standard Kitchen Sink";
  }
  if (cat(p) === "bathroom_faucet") return handleCount(p) <= 1 ? "Mono Basin Mixer" : "";
  if (cat(p) === "kitchen_faucet") {
    const t = `${p.product_type ?? ""} ${attr(p).spout_type ?? ""} ${attr(p).spray_type ?? ""} ${attr(p).general_title_en ?? ""}`;
    if (/pot ?filler/i.test(t)) return "Pot Filler";
    if (/\bbar\b|beverage|prep/i.test(t)) return "Bar Faucet";
    if (/pull.?down/i.test(t)) return "Pull-Down Faucet";
    if (handleCount(p) >= 2) return "Double Handle Kitchen Facuet";
    return "Single Handle Kitchen Faucet";
  }
  return "";
};
// Durability: the PIM tags (already Wayfair wording) or the material's defaults.
const DURABILITY_OK = /^(stain|scratch|heat|rust|tarnish|corrosion|fade|dent|weather|uv) resistant$|^non-staining$|^antimicrobial$/i;
export const durability = (p: Product): string[] => {
  const tags = listOf(attr(p).durability_tags).map((t) => t.replace(/^and\s+/i, "").replace(/\bresistant$/i, "Resistant").trim());
  const ok = tags.filter((t) => DURABILITY_OK.test(t)).map((t) => t.replace(/\b\w/g, (c) => c.toUpperCase()));
  if (ok.length) return [...new Set(ok)];
  const m = String(p.material ?? "").toLowerCase();
  if (/stainless/.test(m)) return ["Rust Resistant", "Stain Resistant", "Heat Resistant"];
  if (/quartz|granite|composite/.test(m)) return ["Scratch Resistant", "Stain Resistant", "Heat Resistant"];
  if (/brass|steel|zinc/.test(m)) return ["Rust Resistant", "Tarnish Resistant", "Corrosion Resistant"];
  return [];
};
// Plating = the coating named by the finish (faucets). Black / gunmetal /
// graphite finishes are coatings, not platings → Does Not Apply.
export const platingMaterial = (p: Product): string => {
  const explicit = String(attr(p).plating_material ?? "").trim();
  if (explicit) return explicit;
  const f = String(p.finish ?? "").toLowerCase();
  if (!f) return "";
  if (/chrome/.test(f)) return "Chrome";
  if (/nickel/.test(f)) return "Nickel";
  if (/stainless/.test(f)) return "Stainless Steel";
  if (/gold|brass/.test(f)) return "Brass";
  if (/bronze/.test(f)) return "Bronze";
  if (/copper/.test(f)) return "Copper";
  if (/black|gunmetal|graphite|white/.test(f)) return "Does Not Apply";
  return "";
};
export const title24 = (p: Product): string => {
  const v = String(attr(p).title_24_compliant ?? "").toLowerCase();
  if (!v || /ask/.test(v)) return "";
  if (/not|non|\bno\b/.test(v)) return "No";
  if (/compliant|yes|true/.test(v)) return "Yes";
  return "";
};
// cUPC-certified faucets are tested to ASME A112.18.1 / CSA B125.1.
export const plumbingFixtures = (p: Product): string => {
  const asme = String(attr(p).asme_csa_certified ?? "");
  if (/112\.18\.1/.test(asme)) return "ASME A112.18.1 / CSA B125.1";
  const cupc = `${attr(p).cupc_certified ?? ""} ${listOf(attr(p).safety_listings).join(" ")}`;
  if (/yes|cupc|upc/i.test(cupc)) return "ASME A112.18.1 / CSA B125.1";
  if (/^no$/i.test(String(attr(p).cupc_certified ?? ""))) return "No";
  return "";
};
const strainerCode = (p: Product): string => {
  const m = String(attr(p).strainer_model ?? "").toUpperCase().match(/^([A-Z]{1,2})-?(\d{2,4}[A-Z]{0,3})$/);
  if (m) return `${m[1]}-${m[2]}`;
  return codesIn(accessories(p), /strainer/i)[0] ?? "";
};
const includedYesNo = (p: Product, re: RegExp, extra = false) =>
  isSinkCat(p) ? (extra || accessories(p).some((a) => re.test(a)) ? "Yes" : "No") : "";
// Wayfair's conditionality: a count only exists when the piece is included;
// otherwise the count must be "Does Not Apply" (a "0" blocks the request).
const includedCount = (p: Product, re: RegExp, extra = 0) => {
  if (!isSinkCat(p)) return "";
  const n = countIn(accessories(p), re) || extra;
  return n > 0 ? String(n) : "Does Not Apply";
};
const includedCodes = (p: Product, re: RegExp, extra = "") =>
  isSinkCat(p) ? (extra || codesIn(accessories(p), re).join(", ") || "Does Not Apply") : "";
const sinkDNA = (p: Product, faucetValue: () => string = () => "") => (isSinkCat(p) ? "Does Not Apply" : faucetValue());

// Our stainless sinks are 18/10 steel: the PIM says "Stainless Steel", Wayfair
// carries "Stainless Steel (18/10)" — the same thing (user rule 2026-09-16).
// Sinks only: the faucet classes list plain "Stainless Steel". Wayfair's
// "Granite" means natural stone; our composite (80% quartz) sinks are listed
// as "Quartz" (the value the Product Addition validations accepted).
export const wayfairMaterial = (p: Product): string => {
  const m = String(p.material ?? "").trim();
  const sink = /sink/.test(String(p.category ?? ""));
  if (sink && /^stainless steel$/i.test(m)) return "Stainless Steel (18/10)";
  if (sink && /quartz|composite/i.test(m)) return "Quartz";
  return m;
};

// ---- Exact-title rules ----
export const EXACT_RULES: Record<string, (p: Product) => RuleValue> = {
  "Overall Length from End to End": (p) => dim(p, "external_dimensions_in", "length"),
  "Overall Width from Front to Back": (p) => dim(p, "external_dimensions_in", "width"),
  "Overall Height from Top to Bottom": (p) => dim(p, "external_dimensions_in", "depth"),
  "Basin Length - Side to Side": (p) => dim(p, "internal_dimensions_in", "length"),
  "Basin Width - Front to Back": (p) => dim(p, "internal_dimensions_in", "width"),
  "Basin Depth - Top to Bottom": (p) => dim(p, "internal_dimensions_in", "depth"),
  // Double-bowl sinks: Wayfair carries one depth per bowl (Kitchen Sinks
  // class; added 2026-09-16 so the audit compares them).
  "Left Basin/Tub Depth - Top to Bottom": (p) => num(attr(p).left_bowl_depth_in),
  "Right Basin/Tub Depth - Top to Bottom": (p) => num(attr(p).right_bowl_depth_in),
  "Overall Product Weight": (p) => num(p.weight_lb ?? attr(p).product_weight_lb),
  "Drain Diameter": (p) => num(p.drain_diameter_in ?? attr(p).drain_diameter_in),
  "Stainless Steel Gauge": (p) => num(p.gauge ?? attr(p).gauge),
  "Number of Basins": (p) => num(p.number_of_bowls ?? attr(p).number_of_bowls),
  "Basin Split": (p) => String(p.basin_split ?? attr(p).basin_split ?? ""),
  // NOTE: the API's "Sink Shape" vocabulary is ADJECTIVAL ("Rectangular") —
  // distinct from "Overall Shape" nouns ("Rectangle"). Push the raw PIM value.
  "Sink Shape": (p) => String(p.shape ?? attr(p).sink_shape ?? ""),
  "Material": (p) => wayfairMaterial(p),
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
  "Kitchen Sink Workstation": (p) => (isWorkstation(p) ? "Yes" : "No"),

  // ---- Rules added 2026-09-16 (the "has PIM data, no push rule" group) ----
  "Mounting / Installation": (p) => mountingInstallation(p),
  "Mounting / Installation Required": (p) => (isSinkCat(p) || isFaucetCat(p) ? "Yes" : ""),
  "Product Type": (p) => productType(p),
  "Overall Shape": (p) => overallShape(p),
  "Drain Placement": (p) => (isSinkCat(p) ? drainPlacement(p) : ""),
  "Minimum Base Cabinet Width - Side to Side": (p) => num(attr(p).min_external_cabinet_size_in),
  "Pieces Included": (p) => piecesIncluded(p),
  "Durability": (p) => durability(p),
  "Sound Dampening": (p) => (isSinkCat(p) ? (soundDampened(p) ? "Yes" : "No") : ""),
  "General Features": (p) => (isSinkCat(p) && soundDampened(p) ? ["Sound Dampening"] : []),
  "Accessories Included": (p) => (isSinkCat(p) ? (accessories(p).length ? "Yes" : "No") : ""),
  "Basket Strainer Included": (p) => includedYesNo(p, /strainer/i, Boolean(attr(p).strainer_model)),
  "Number of Basket Strainers Included": (p) => includedCount(p, /strainer/i, attr(p).strainer_model ? 1 : 0),
  "Compatible Basket Strainer Part Number": (p) => includedCodes(p, /strainer/i, strainerCode(p)),
  "Sink Grid Included": (p) => includedYesNo(p, /grid/i, attr(p).includes_grids === true),
  "Number of Sink Grids Included": (p) =>
    includedCount(p, /grid/i, attr(p).includes_grids === true ? Number(num(attr(p).number_of_bowls)) || 1 : 0),
  "Compatible Sink Grid Part Number": (p) =>
    includedCodes(p, /grid/i, /^[A-Z]-?\d/i.test(String(attr(p).grids_model_code ?? "")) ? String(attr(p).grids_model_code) : ""),
  "Colander Included": (p) => includedYesNo(p, /colander/i),
  "Number of Colanders Included": (p) => includedCount(p, /colander/i),
  "Compatible Colander Part Number": (p) => includedCodes(p, /colander/i),
  "Cutting Board Included": (p) => includedYesNo(p, /cutting board|bamboo board/i),
  "Number of Cutting Boards Included": (p) => includedCount(p, /cutting board|bamboo board/i),
  "Compatible Cutting Board Part Number": (p) => includedCodes(p, /cutting board|bamboo board/i),
  "Soap / Lotion Dispenser Included": (p) => includedYesNo(p, /soap/i),
  "Number of Soap Dispensers Included": (p) => includedCount(p, /soap/i),
  "Overflow Hole": (p) => (isSinkCat(p) ? (attr(p).overflow_location ? "Yes" : "No") : ""),
  "Faucet Holes": (p) => (isSinkCat(p) ? (holes(p) > 0 ? "Yes" : "No") : ""),
  "Faucet Included": (p) => (isSinkCat(p) ? (/faucet/i.test(accessories(p).join(" ")) ? "Yes" : "No") : ""),
  "Number of Faucets Included": (p) => sinkDNA(p),
  "Faucet Finish": (p) => sinkDNA(p),
  "Faucet Hole Diameter": (p) => sinkDNA(p),
  "Faucet Material": (p) => sinkDNA(p),
  "Faucet Type": (p) => sinkDNA(p),
  "Faucet Features": (p) => sinkDNA(p),
  "Side Spray Included": (p) => sinkDNA(p),
  // Faucet Centers is a number on faucets (0 = one-hole), Does Not Apply on sinks.
  "Faucet Centers": (p) => sinkDNA(p, () => num(attr(p).faucet_centers) || (holes(p) === 1 ? "0" : "")),
  "Maximum Thickness - Deck": (p) => sinkDNA(p, () => num(attr(p).max_deck_thickness_in)),
  "Maximum Flow Rate": (p) => (isFaucetCat(p) ? num(attr(p).max_flow_rate) : ""),
  "Apron Included": (p) => (isSinkCat(p) ? (isFarmhouse(p) ? "Yes" : "No") : ""),
  "Mounting Hardware Included": (p) => (isSinkCat(p) ? (piecesIncluded(p).includes("Mounting Hardware") ? "Yes" : "No") : ""),
  "Drain Included": (p) => (isSinkCat(p) ? (piecesIncluded(p).includes("Basket Strainer") ? "Yes" : "No") : ""),
  "Drain Assembly Included": (p) => (piecesIncluded(p).includes("Drain Assembly") ? "Yes" : (isSinkCat(p) || isFaucetCat(p) ? "No" : "")),
  "Sink Basket Strainer - Diameter": (p) => (isSinkCat(p) ? num(attr(p).drain_diameter_in) : ""),
  "Warranty": (p) => (hasWarranty(p) ? ["Warranty Included", /full/i.test(String(attr(p).warranty ?? "")) ? "Full Warranty" : "Limited Warranty"] : []),
  "Product Warranty": (p) => (hasWarranty(p) ? "Yes" : ""),
  // Faucets
  "Handle Material": (p) => String(attr(p).handle_material ?? ""),
  "Handle Style": (p) => String(attr(p).handle_style ?? ""),
  "Spout Type": (p) => (isFaucetCat(p) ? String(attr(p).spout_type ?? "") : ""),
  "Swivel": (p) => (isFaucetCat(p) ? yesNo(attr(p).swivel_spout) : ""),
  "Aerator Included": (p) => (isFaucetCat(p) ? yesNo(attr(p).aerator_included) : ""),
  "Valve Included": (p) => (isFaucetCat(p) ? yesNo(attr(p).valve_included) : ""),
  "Supply Line Included": (p) => (isFaucetCat(p) ? yesNo(attr(p).supply_line_included) : ""),
  "Deck Plate Included": (p) => (isFaucetCat(p) ? yesNo(attr(p).deck_plate_included) : ""),
  "Handle(s) Included": (p) => (isFaucetCat(p) ? yesNo(attr(p).handles_included) : ""),
  "Compatible Deck Plate Part Number": (p) => (isFaucetCat(p) ? partList(attr(p).compatible_deck_plate) : ""),
  "Compatible Drain Assembly Part Number": (p) => (isFaucetCat(p) ? partList(attr(p).compatible_drain_assembly) : ""),
  "Laminar Flow": (p) => (isFaucetCat(p) ? yesNo(attr(p).laminar_flow) : ""),
  "Plating Material": (p) => (isFaucetCat(p) ? platingMaterial(p) : ""),
  "Plumbing Fixtures Compliant": (p) => (isFaucetCat(p) ? plumbingFixtures(p) : ""),
  "Title 24 - California Code of Regulations": (p) => title24(p),
};

// Titles matching EXCLUDE never pattern-match: they describe a DIFFERENT
// measurement than the overall product (apron, basin, base/stand, cut-out…)
// or a field we hold no PIM value for (commercial warranty).
export const EXCLUDE = /apron|basin|interior|cut.?out|base\/stand|stand height|cabinet|drain|hole size|commercial|additional details|min(imum)?|max(imum)?/i;

// Wayfair's axis convention names the axis in the title: "End to End" /
// "Side to Side" = left-right (PIM length), "Front to Back" = PIM width,
// "Top to Bottom" = vertical (PIM height/depth). When a class carries BOTH
// "Overall Length … End to End" and "Overall Width … Side to Side", the width
// title is the SHORT axis → PIM width; when the width title is the only
// horizontal one, side-to-side IS the long axis → PIM length.
export type RuleCtx = { hasPlainLength: boolean };
export const PATTERN_RULES: Array<{ re: RegExp; value: (p: Product, ctx: RuleCtx) => RuleValue }> = [
  { re: /including handles/i, value: (p) => num(attr(p).length_with_handles_in) },
  {
    re: /^overall width .*side to side/i,
    value: (p, ctx) => dim(p, "external_dimensions_in", ctx.hasPlainLength ? "width" : "length"),
  },
  { re: /^spout(\/faucet)? height/i, value: (p) => num(attr(p).spout_height_in) },
  { re: /^spout reach/i, value: (p) => num(attr(p).spout_reach_in) },
  { re: /flow rate/i, value: (p) => num(attr(p).max_flow_rate) },
  { re: /number of (faucet )?handles/i, value: (p) => num(attr(p).number_of_handles) },
  { re: /^faucet height/i, value: (p) => num(attr(p).faucet_height_in) || dim(p, "external_dimensions_in", "height") },
  // Sinks without faucet holes answer Does Not Apply (Wayfair's "Faucet Holes"
  // = No conditionality); faucets and sinks with holes send the number.
  { re: /(number of (faucet |installation |mounting )?holes)/i, value: (p) => {
    const n = num(attr(p).number_of_installation_holes);
    return isSinkCat(p) && (n === "" || Number(n) === 0) ? (n === "" ? "" : "Does Not Apply") : n;
  } },
  { re: /(countertop|deck) thickness/i, value: (p) => num(attr(p).max_deck_thickness_in) },
  { re: /^overall .*(end to end|side to side)/i, value: (p) => dim(p, "external_dimensions_in", "length") },
  { re: /^overall .*front to back/i, value: (p) => dim(p, "external_dimensions_in", "width") },
  {
    re: /^overall .*top to bottom/i,
    value: (p) => dim(p, "external_dimensions_in", "height") || dim(p, "external_dimensions_in", "depth"),
  },
  { re: /^overall product weight$/i, value: (p) => num(p.weight_lb ?? attr(p).product_weight_lb) },
  { re: /^warranty length$/i, value: (p) => String(attr(p).warranty_length ?? "") },
  { re: /^material$/i, value: (p) => wayfairMaterial(p) },
  { re: /^finish$/i, value: (p) => finish(p.finish) },
  { re: /^country of (origin|manufacture)$/i, value: (p) => String(attr(p).country_of_origin ?? "") },
];

/** The rule for an attribute title, if the PIM maps it. */
export function ruleForTitle(title: string): ((p: Product, ctx: RuleCtx) => RuleValue) | undefined {
  return EXACT_RULES[title] ??
    (EXCLUDE.test(title) ? undefined : PATTERN_RULES.find((r) => r.re.test(title))?.value);
}

/** Context for a class from the titles it carries. */
export function ruleContext(titles: Iterable<string>): RuleCtx {
  return {
    hasPlainLength: [...titles].some((t) =>
      /^overall length\b.*end to end/i.test(t) && !/including handles/i.test(t)
    ),
  };
}
