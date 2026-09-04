// PIM data completeness — "is this product 100% filled in?" scored from PIM
// (CANONICAL copy: src/features/products/lib/completeness.js re-exports this file.)
// data ONLY (no channel state: nothing about links, stock or channel prices).
// Computed live from the catalog on every load, so any edit shows at once.
//
// Every check declares which categories it applies to; a product is COMPLETE
// when every applicable check passes. Groups map to the product tab where
// the gap gets fixed.
// Shared with the health-refresh edge function (daily KPI snapshots), so it
// stays pure JS with no imports. Category labels mirror
// src/features/products/lib/categories.js; keep both in step.
export const CATEGORY_LABEL = {
  kitchen_sink: 'Kitchen Sink',
  bathroom_sink: 'Bathroom Sink',
  kitchen_faucet: 'Kitchen Faucet',
  bathroom_faucet: 'Bathroom Faucet',
  pot_filler: 'Pot Filler',
  bar_prep_sink: 'Bar/Prep Sink',
  laundry_sink: 'Laundry Sink',
  outdoor_sink: 'Outdoor Sink & Ice Chest',
  colander_drying_rack: 'Colanders & Drying Racks',
  accessory: 'Accessory',
};

const SINKS = ['kitchen_sink', 'bar_prep_sink', 'laundry_sink', 'outdoor_sink', 'bathroom_sink'];
const KITCHEN_SINKS = ['kitchen_sink', 'bar_prep_sink', 'laundry_sink', 'outdoor_sink'];
const FAUCETS = ['kitchen_faucet', 'bathroom_faucet', 'pot_filler'];
const ALL = null; // applies to every category
// Faucets describe size by spout height/reach, not by an overall L×W×H.
const NOT_FAUCETS = ['kitchen_sink', 'bar_prep_sink', 'laundry_sink', 'outdoor_sink', 'bathroom_sink', 'colander_drying_rack', 'accessory'];

const text = (v) => typeof v === 'string' && v.trim().length > 0;
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const list = (v, min = 1) => Array.isArray(v) && v.filter((x) => text(String(x ?? ''))).length >= min;
const dims = (v) => !!v && typeof v === 'object' && Object.values(v).filter((x) => num(x)).length >= 2;
const attr = (p, k) => p?.attributes?.[k] ?? null;
// Some fields live both as a product column and inside attributes; an empty
// column ('' / [] / null) must not hide a filled attribute.
const empty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
const field = (p, k) => (empty(p?.[k]) ? attr(p, k) : p[k]);
const stainless = (p) => /stainless/i.test(String(p.material ?? ''));
const PLACEHOLDER_UPC = /^(0+|840994000000)$/;

const images = (media) => (media ?? []).filter((m) => m.media_type === 'image');
const docs = (media) => (media ?? []).filter((m) => m.media_type === 'document');

// group → product tab (deep link) and display order
export const GROUPS = {
  Identity: { tab: 'overview', order: 1 },
  Content: { tab: 'content', order: 2 },
  Pricing: { tab: 'pricing', order: 3 },
  Specs: { tab: 'specs', order: 4 },
  Shipping: { tab: 'specs', order: 5 },
  Images: { tab: 'media', order: 6 },
  Documents: { tab: 'media', order: 7 },
};

// { key, label, group, cats: null | string[], check(product, media) }
export const CHECKS = [
  // ---- Identity ----
  { key: 'title_en', label: 'Title (EN)', group: 'Identity', cats: ALL, check: (p) => text(attr(p, 'general_title_en')) },
  { key: 'title_fr', label: 'Title (FR)', group: 'Identity', cats: ALL, check: (p) => text(attr(p, 'general_title_fr')) },
  { key: 'collection', label: 'Collection name', group: 'Identity', cats: ALL, check: (p) => text(p.model_name) },
  { key: 'brand', label: 'Brand', group: 'Identity', cats: ALL, check: (p) => text(p.brand) },
  { key: 'upc', label: 'UPC (real, not placeholder)', group: 'Identity', cats: ALL, check: (p) => text(String(field(p, 'upc') ?? '')) && !PLACEHOLDER_UPC.test(String(field(p, 'upc')).trim()) },
  { key: 'hs_code', label: 'HS code', group: 'Identity', cats: SINKS, check: (p) => text(String(field(p, 'hs_code') ?? '')) },
  { key: 'country', label: 'Country of origin', group: 'Identity', cats: ALL, check: (p) => text(String(field(p, 'country_of_origin') ?? '')) },

  // ---- Content ----
  { key: 'description_en', label: 'Description (EN)', group: 'Content', cats: ALL, check: (p) => text(p.description) && p.description.replace(/<[^>]*>/g, '').trim().length >= 100 },
  { key: 'description_fr', label: 'Description (FR)', group: 'Content', cats: ALL, check: (p) => text(attr(p, 'description_fr')) },
  { key: 'bullets_en', label: '4+ bullet points (EN)', group: 'Content', cats: ALL, check: (p) => list(field(p, 'bullet_points'), 4) },
  { key: 'bullets_fr', label: '4+ bullet points (FR)', group: 'Content', cats: ALL, check: (p) => list(attr(p, 'bullet_points_fr'), 4) },
  { key: 'keywords', label: 'Keywords (EN)', group: 'Content', cats: ALL, check: (p) => list(attr(p, 'keywords_en')) || text(attr(p, 'keywords_en')) },
  { key: 'warranty', label: 'Warranty', group: 'Content', cats: ALL, check: (p) => text(String(field(p, 'warranty') ?? '')) || text(String(attr(p, 'warranty_length') ?? '')) },
  { key: 'care', label: 'Care instructions', group: 'Content', cats: SINKS, check: (p) => text(String(attr(p, 'product_care') ?? '')) },

  // ---- Pricing (both markets) ----
  { key: 'msrp_cad', label: 'MSRP CAD', group: 'Pricing', cats: ALL, check: (p) => num(p.msrp_cad) },
  { key: 'map_cad', label: 'MAP CAD', group: 'Pricing', cats: ALL, check: (p) => num(p.map_cad) },
  { key: 'cost_cad', label: 'Costs CAD (Rona/HD + Wayfair/SOD)', group: 'Pricing', cats: ALL, check: (p) => num(p.cost_cad_rona_hd) && num(p.cost_cad_wayfair_sod) },
  { key: 'msrp_usd', label: 'MSRP USD', group: 'Pricing', cats: ALL, check: (p) => num(p.msrp_usd) },
  { key: 'map_usd', label: 'MAP USD', group: 'Pricing', cats: ALL, check: (p) => num(p.map_usd) },
  { key: 'cost_usd', label: 'Costs USD (Wayfair + Lowe\'s/SOD/BB&B)', group: 'Pricing', cats: ALL, check: (p) => num(p.cost_usd_wayfair) && num(p.cost_usd_lowes_sod_bbb) },

  // ---- Specs ----
  { key: 'material', label: 'Material', group: 'Specs', cats: ALL, check: (p) => text(p.material) },
  { key: 'finish', label: 'Finish', group: 'Specs', cats: ALL, check: (p) => text(p.finish) },
  { key: 'external_dims', label: 'External dimensions', group: 'Specs', cats: NOT_FAUCETS, check: (p) => dims(attr(p, 'external_dimensions_in')) },
  { key: 'installation', label: 'Installation type', group: 'Specs', cats: SINKS, check: (p) => text(String(field(p, 'installation_type') ?? '')) || list(field(p, 'installation_type')) },
  { key: 'bowls', label: 'Number of bowls', group: 'Specs', cats: SINKS, check: (p) => num(Number(field(p, 'number_of_bowls'))) },
  { key: 'internal_dims', label: 'Bowl (internal) dimensions', group: 'Specs', cats: SINKS, check: (p) => dims(attr(p, 'internal_dimensions_in')) },
  { key: 'drain', label: 'Drain diameter', group: 'Specs', cats: SINKS, check: (p) => num(Number(field(p, 'drain_diameter_in'))) },
  { key: 'shape', label: 'Sink shape', group: 'Specs', cats: SINKS, check: (p) => text(String(field(p, 'sink_shape') ?? p.shape ?? '')) },
  { key: 'cabinet', label: 'Minimum cabinet size', group: 'Specs', cats: KITCHEN_SINKS, check: (p) => num(Number(attr(p, 'min_external_cabinet_size_in'))) },
  { key: 'drain_location', label: 'Drain location', group: 'Specs', cats: KITCHEN_SINKS, check: (p) => text(String(attr(p, 'drain_hole_location') ?? '')) },
  { key: 'gauge', label: 'Gauge (stainless steel)', group: 'Specs', cats: SINKS, applies: (p) => stainless(p), check: (p) => num(Number(field(p, 'gauge'))) },
  { key: 'spout_height', label: 'Spout height', group: 'Specs', cats: FAUCETS, check: (p) => num(Number(attr(p, 'spout_height_in'))) },
  { key: 'spout_reach', label: 'Spout reach', group: 'Specs', cats: FAUCETS, check: (p) => num(Number(attr(p, 'spout_reach_in'))) },
  { key: 'flow_rate', label: 'Max flow rate', group: 'Specs', cats: FAUCETS, check: (p) => num(Number(attr(p, 'max_flow_rate'))) },
  { key: 'handles', label: 'Number of handles', group: 'Specs', cats: FAUCETS, check: (p) => Number.isFinite(Number(attr(p, 'number_of_handles'))) && attr(p, 'number_of_handles') !== null },
  { key: 'holes', label: 'Installation holes', group: 'Specs', cats: FAUCETS, check: (p) => Number.isFinite(Number(attr(p, 'number_of_installation_holes'))) && attr(p, 'number_of_installation_holes') !== null },
  { key: 'deck', label: 'Max deck thickness', group: 'Specs', cats: FAUCETS, check: (p) => num(Number(attr(p, 'max_deck_thickness_in'))) },

  // ---- Shipping ----
  { key: 'ship_dims', label: 'Shipping box dimensions', group: 'Shipping', cats: ALL, check: (p) => dims(attr(p, 'shipping_dimensions_in')) },
  { key: 'ship_weight', label: 'Shipping weight', group: 'Shipping', cats: ALL, check: (p) => num(p.shipping_weight_lb) },
  { key: 'product_weight', label: 'Product weight', group: 'Shipping', cats: ALL, check: (p) => num(Number(field(p, 'product_weight_lb') ?? p.weight_lb)) },

  // ---- Images ----
  { key: 'hero', label: 'Gray hero (SinksDirect main)', group: 'Images', cats: ALL, check: (p, m) => images(m).some((x) => x.image_role === 'sinksdirect_main') },
  { key: 'main', label: 'White main (primary)', group: 'Images', cats: ALL, check: (p, m) => images(m).some((x) => x.is_primary) },
  { key: 'five_images', label: '5+ images', group: 'Images', cats: ALL, check: (p, m) => images(m).length >= 5 },
  { key: 'set_en_fr', label: 'EN-FR image set (3+)', group: 'Images', cats: ALL, check: (p, m) => images(m).filter((x) => x.language === 'en_fr').length >= 3 },

  // ---- Documents ----
  { key: 'spec_sheet', label: 'Spec sheet', group: 'Documents', cats: ALL, check: (p, m) => docs(m).some((d) => d.document_type === 'spec_sheet') },
  { key: 'installation_doc', label: 'Installation guide', group: 'Documents', cats: [...SINKS, ...FAUCETS], check: (p, m) => docs(m).some((d) => /^installation_/.test(d.document_type ?? '')) },
  { key: 'warranty_doc', label: 'Warranty document', group: 'Documents', cats: ALL, check: (p, m) => docs(m).some((d) => d.document_type === 'warranty_file') },
];

export function applicableChecks(product) {
  const cat = product?.category ?? '';
  return CHECKS.filter((c) => (c.cats === ALL || c.cats.includes(cat)) && (!c.applies || c.applies(product)));
}

/** @returns {{ score: number, complete: boolean, passed: object[], missing: object[] }} */
export function scoreCompleteness(product, media) {
  const checks = applicableChecks(product);
  const passed = [];
  const missing = [];
  for (const c of checks) {
    let ok;
    try { ok = !!c.check(product, media); } catch { ok = false; }
    (ok ? passed : missing).push({ key: c.key, label: c.label, group: c.group, tab: GROUPS[c.group].tab });
  }
  const score = checks.length ? Math.round((passed.length / checks.length) * 100) : 100;
  return { score, complete: missing.length === 0, passed, missing };
}

/** Group scored products by category: totals, complete count, average, top gaps. */
export function summarizeByCategory(rows) {
  const by = new Map();
  for (const r of rows) {
    const cat = r.category ?? 'uncategorized';
    if (!by.has(cat)) by.set(cat, { category: cat, label: CATEGORY_LABEL[cat] ?? cat, total: 0, complete: 0, scoreSum: 0, gaps: new Map(), products: [] });
    const g = by.get(cat);
    g.total += 1;
    g.scoreSum += r.result.score;
    if (r.result.complete) g.complete += 1;
    for (const m of r.result.missing) {
      const cur = g.gaps.get(m.key) ?? { ...m, count: 0 };
      cur.count += 1;
      g.gaps.set(m.key, cur);
    }
    g.products.push(r);
  }
  return [...by.values()]
    .map((g) => ({
      ...g,
      pct: g.total ? Math.round((g.complete / g.total) * 100) : 0,
      avg: g.total ? Math.round(g.scoreSum / g.total) : 0,
      gaps: [...g.gaps.values()].sort((a, b) => b.count - a.count),
      products: g.products.sort((a, b) => a.result.score - b.result.score || a.sku.localeCompare(b.sku)),
    }))
    .sort((a, b) => a.pct - b.pct || b.total - a.total);
}

/**
 * KPI snapshot rows for one day: catalog totals, per-category totals and the
 * count of products missing each check — enough to compare weeks and to say
 * which gaps closed. Same shape from the cron and from the browser.
 * @param {{ sku, category, result }[]} rows  scored products
 * @param {string} date  YYYY-MM-DD
 */
export function snapshotMetrics(rows, date) {
  const totals = (list) => {
    const missing = {};
    let scoreSum = 0;
    let complete = 0;
    for (const r of list) {
      scoreSum += r.result.score;
      if (r.result.complete) complete += 1;
      for (const m of r.result.missing) missing[m.key] = (missing[m.key] ?? 0) + 1;
    }
    const total = list.length;
    return {
      total,
      complete,
      pct: total ? Math.round((complete / total) * 100) : 0,
      avg: total ? Math.round(scoreSum / total) : 0,
      missing,
    };
  };
  // The catalog row also carries per-SKU detail: every product's score, which
  // SKUs miss each check (gap aging = how many days a SKU stays in that
  // list) and the workflow funnel. Small enough (a few KB) to keep daily.
  const all = totals(rows);
  const scores = {};
  const missingSkus = {};
  const workflow = {};
  for (const r of rows) {
    scores[r.sku] = r.result.score;
    const w = r.workflow_status ?? 'unknown';
    workflow[w] = (workflow[w] ?? 0) + 1;
    for (const m of r.result.missing) (missingSkus[m.key] ??= []).push(r.sku);
  }
  const out = [{ snapshot_date: date, scope: 'pim', key: 'all', metrics: { ...all, scores, missing_skus: missingSkus, workflow } }];
  const byCat = new Map();
  for (const r of rows) {
    const cat = r.category ?? 'uncategorized';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(r);
  }
  for (const [cat, list] of byCat) {
    out.push({ snapshot_date: date, scope: 'pim_category', key: cat, metrics: totals(list) });
  }
  return out;
}
