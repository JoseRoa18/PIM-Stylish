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

// ---- Exact-title rules ----
export const EXACT_RULES: Record<string, (p: Product) => string> = {
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
  // distinct from "Overall Shape" nouns ("Rectangle"). Push the raw PIM value.
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
export const PATTERN_RULES: Array<{ re: RegExp; value: (p: Product, ctx: RuleCtx) => string }> = [
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
  { re: /(number of (faucet |installation |mounting )?holes)/i, value: (p) => num(attr(p).number_of_installation_holes) },
  { re: /(countertop|deck) thickness/i, value: (p) => num(attr(p).max_deck_thickness_in) },
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

/** The rule for an attribute title, if the PIM maps it. */
export function ruleForTitle(title: string): ((p: Product, ctx: RuleCtx) => string) | undefined {
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
