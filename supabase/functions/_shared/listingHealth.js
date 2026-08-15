/**
 * Listing Health — multi-marketplace readiness scoring.
 *
 * CANONICAL implementation, shared by two runtimes:
 *   - the browser app (src/features/dashboard/lib/listingHealth.js re-exports
 *     this file — do NOT fork the scoring logic there)
 *   - the `health-refresh` edge function (scheduled twice a day)
 * Keep this file pure JS with no imports so both environments can load it.
 *
 * Each marketplace has:
 *   - its own list of checks with weights & severities
 *   - its own data source (live Wix cache, PIM, etc.)
 *
 * Score = (sum of passed weights / total weight) × 100.
 *
 * Severities:
 *   - critical: blocks a usable listing
 *   - major: required for a complete listing
 *   - minor: recommended for quality
 */

// ===================== Field checkers =====================

const hasText = (v) => typeof v === 'string' && v.trim().length > 0;
const hasNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const hasArray = (v, min = 1) => Array.isArray(v) && v.length >= min;
const hasDims = (v) => v && typeof v === 'object' &&
  Object.values(v).some((x) => hasNumber(x));

function attr(product, key) {
  return product?.attributes?.[key] ?? null;
}

function countImages(media) {
  if (!Array.isArray(media)) return 0;
  return media.filter((m) => m.media_type === 'image').length;
}

function hasPrimaryImage(media) {
  if (!Array.isArray(media)) return false;
  return media.some((m) => m.is_primary && m.media_type === 'image');
}

// Wix-site section check against the snapshot's section-title fingerprint.
// Unknown (no snapshot / pre-fingerprint snapshot / unlinked) ≠ fail.
function wsSection(product, pattern) {
  const s = product._wixSite;
  if (!s || !Array.isArray(s.section_titles)) return true;
  return s.section_titles.some((t) => pattern.test(t));
}

function hasInfoSection(product, pattern) {
  const sections = product.additional_info_sections;
  if (!Array.isArray(sections) || sections.length === 0) return false;
  return sections.some((s) => {
    if (!s) return false;
    const title = (s.title ?? '').toString();
    const desc = (s.description ?? '').toString();
    return pattern.test(title) || (pattern.test(desc) && hasText(desc));
  });
}

// ===================== Shared field library =====================

const FIELDS = {
  sku: { label: 'SKU', check: (p) => hasText(p.sku) },
  product_name: { label: 'Product Name', check: (p) => hasText(p.model_name) && p.model_name.trim().length >= 10 },
  brand: { label: 'Brand', check: (p) => hasText(p.brand) },
  description: { label: 'Description', check: (p) => hasText(p.description) && p.description.length > 100 },
  price: { label: 'Price', check: (p) => hasNumber(p.msrp_cad) && p.msrp_cad > 0 },
  // Dealer costs are per channel group since 2026-08-12; having either
  // Canadian cost list counts as "has cost data".
  dealer_cost: { label: 'Dealer Cost', check: (p) => (hasNumber(p.cost_cad_rona_hd) && p.cost_cad_rona_hd > 0) || (hasNumber(p.cost_cad_wayfair_sod) && p.cost_cad_wayfair_sod > 0) },
  shipping_weight: { label: 'Shipping Weight', check: (p) => hasNumber(p.shipping_weight_lb) && p.shipping_weight_lb > 0 },
  material: { label: 'Material', check: (p) => hasText(p.material) },
  finish: { label: 'Finish', check: (p) => hasText(p.finish) },
  upc: { label: 'UPC', check: (p) => hasText(attr(p, 'upc')) },
  manufacturer: { label: 'Manufacturer', check: (p) => hasText(attr(p, 'manufacturer')) },
  warranty: { label: 'Warranty', check: (p) => hasText(attr(p, 'warranty')) },
  country_of_origin: { label: 'Country of Origin', check: (p) => hasText(attr(p, 'country_of_origin')) },
  hs_code: { label: 'HS Code', check: (p) => hasText(attr(p, 'hs_code')) },
  installation_type: { label: 'Installation Type', check: (p) => hasText(attr(p, 'installation_type')) || hasArray(attr(p, 'installation_type')) },
  // Sink-only specs: pass (not applicable) for faucets/accessories — an
  // accessory shouldn't lose points for having no gauge or bowls.
  gauge: {
    label: 'Gauge',
    check: (p) => !/sink/.test(p.category ?? '') || hasText(attr(p, 'gauge')) || hasNumber(attr(p, 'gauge')),
  },
  number_of_bowls: {
    label: 'Number of Bowls',
    check: (p) => !/sink/.test(p.category ?? '') || hasNumber(attr(p, 'number_of_bowls')),
  },
  // Faucets carry their dimensions as spout/height attributes, not the
  // external length×width box — accept either shape of dimensional data.
  external_dimensions: {
    label: 'External Dimensions',
    check: (p) =>
      /faucet|pot_filler/.test(p.category ?? '')
        ? hasNumber(attr(p, 'faucet_height_in')) || hasNumber(attr(p, 'spout_height_in')) || hasDims(attr(p, 'external_dimensions_in'))
        : hasDims(attr(p, 'external_dimensions_in')),
  },
  shipping_dimensions: { label: 'Shipping Dimensions', check: (p) => hasDims(attr(p, 'shipping_dimensions_in')) },
  bullet_points: { label: 'Bullet Points', check: (p) => hasArray(attr(p, 'bullet_points'), 4) },
  primary_image: { label: 'Primary Image', check: (p) => hasPrimaryImage(p._media) },
  multiple_images: { label: '5+ Images', check: (p) => countImages(p._media) >= 5 },
  linked_to_wix: { label: 'Linked to Wix', check: (p) => hasText(p.wix_product_id) },
  linked_to_wayfair: { label: 'Linked to Wayfair', check: (p) => hasText(p.wayfair_item_group_id) },
  // Channel titles come from the marketing title, not the short internal
  // model name ("Topaz") — that's what pushes/exports actually send.
  marketing_title: {
    label: 'Marketing Title',
    check: (p) => hasText(attr(p, 'general_title_en')) && attr(p, 'general_title_en').trim().length >= 10,
  },
  // Spec-attribute sync per the latest Wayfair audit snapshot (the audit
  // covers the whole catalog — every category against its own Wayfair class):
  //   _wayfairAudit === undefined → no audit has run yet (unknown ≠ fail)
  //   _wayfairAudit === null      → audited run, but this SKU wasn't audited:
  //                                 fail only if it claims a Wayfair link —
  //                                 unlinked products are already flagged by
  //                                 "Linked to Wayfair", no double penalty.
  //   { changed }                 → audited; in sync when changed === 0
  wayfair_specs_synced: {
    label: 'Spec Attributes in Sync',
    check: (p) => {
      if (p._wayfairAudit === undefined) return true;
      if (p._wayfairAudit === null) return !hasText(p.wayfair_item_group_id);
      return p._wayfairAudit.changed === 0;
    },
  },
  // Best Buy offer checks — fed by the read-only offers snapshot.
  //   _bbOffer === undefined → no snapshot yet (unknown ≠ fail)
  //   _bbOffer === null      → snapshot exists, product has no offer
  //   { price, quantity, active, msrp } → live offer data
  listed_on_bestbuy: {
    label: 'Listed on Best Buy',
    check: (p) => p._bbOffer === undefined || p._bbOffer != null,
  },
  bb_offer_active: {
    label: 'Offer Active',
    check: (p) => !p._bbOffer || p._bbOffer.active === true,
  },
  bb_in_stock: {
    label: 'In Stock',
    check: (p) => !p._bbOffer || (p._bbOffer.quantity ?? 0) > 0,
  },
  bb_price_matches: {
    label: 'Price Matches PIM MSRP',
    check: (p) => {
      const o = p._bbOffer;
      if (!o || o.price == null || o.msrp == null) return true;
      return Math.abs(o.price - o.msrp) <= 0.01;
    },
  },
  // Walmart US item checks — fed by the read-only items snapshot.
  // Same undefined/null/object semantics as _bbOffer. Prices are USD and the
  // PIM only holds CAD MSRPs, so price is informational, never scored.
  listed_on_walmart: {
    label: 'Listed on Walmart',
    check: (p) => p._wmItem === undefined || p._wmItem != null,
  },
  wm_published: {
    label: 'Published',
    check: (p) => !p._wmItem || p._wmItem.published === 'PUBLISHED',
  },
  wm_lifecycle_active: {
    label: 'Lifecycle Active',
    check: (p) => !p._wmItem || !p._wmItem.lifecycle || p._wmItem.lifecycle === 'ACTIVE',
  },
  visible_online: { label: 'Visible Online', check: (p) => p.visible_online === true },
  // Wix-site checks — fed by each site's channel_health snapshot (compact
  // content fingerprint written by wix-pull-catalog). Same semantics as
  // _bbOffer: undefined → no snapshot yet (unknown ≠ fail); null → the site
  // snapshot exists but this SKU isn't linked there; object → live listing.
  ws_listed: {
    label: 'Listed on the site',
    check: (p) => p._wixSite === undefined || p._wixSite != null,
  },
  ws_live: {
    label: 'Visible in the store',
    check: (p) => !p._wixSite || p._wixSite.state === 'live',
  },
  ws_name: {
    label: 'Product Name',
    check: (p) => !p._wixSite || (hasText(p._wixSite.name) && p._wixSite.name.trim().length >= 10),
  },
  ws_price: {
    label: 'Price Set',
    check: (p) => !p._wixSite || (hasNumber(p._wixSite.price) && p._wixSite.price > 0),
  },
  ws_price_aligned: {
    label: 'Price at Expected',
    check: (p) => !p._wixSite || p._wixSite.price_diff !== true,
  },
  ws_description: {
    label: 'Description',
    // Older snapshots predate the content fingerprint — unknown ≠ fail.
    check: (p) => !p._wixSite || p._wixSite.description_length == null || p._wixSite.description_length > 100,
  },
  ws_main_image: {
    label: 'Main Image',
    check: (p) => !p._wixSite || p._wixSite.has_main_image !== false,
  },
  ws_images: {
    label: '5+ Images',
    check: (p) => !p._wixSite || p._wixSite.image_count == null || p._wixSite.image_count >= 5,
  },
  ws_section_dimensions: {
    label: 'Dimensions Tab',
    check: (p) => wsSection(p, /dimension|size|measurement/i),
  },
  ws_section_documents: {
    label: 'Documents to Download Tab',
    check: (p) => wsSection(p, /document|download|spec sheet|manual|installation/i),
  },
  ws_section_features: {
    label: 'Features Tab',
    check: (p) => wsSection(p, /feature|highlight|benefit/i),
  },
  section_dimensions: { label: 'Dimensions Tab', check: (p) => hasInfoSection(p, /dimension|size|measurement/i) },
  section_documents: { label: 'Documents to Download Tab', check: (p) => hasInfoSection(p, /document|download|spec sheet|manual|installation/i) },
  section_features: { label: 'Features Tab', check: (p) => hasInfoSection(p, /feature|highlight|benefit/i) },
  section_accessories: { label: 'Recommended Accessories Tab', check: (p) => hasInfoSection(p, /accessor|recommend|companion|compatible/i) },
};

// ===================== Marketplace definitions =====================

export const MARKETPLACES = {
  wix: {
    key: 'wix',
    label: 'Sinks Direct Canada',
    subtitle: 'Wix Stores',
    dataSource: 'wix_cache',
    connectionType: 'api',
    requiresLink: true,
    checks: [
      { field: 'linked_to_wix', category: 'Identity', weight: 15, severity: 'critical' },
      { field: 'product_name', category: 'Identity', weight: 10, severity: 'critical' },
      { field: 'price', category: 'Pricing', weight: 10, severity: 'critical' },
      { field: 'description', category: 'Description', weight: 12, severity: 'critical' },
      { field: 'primary_image', category: 'Images', weight: 10, severity: 'critical' },
      { field: 'multiple_images', category: 'Images', weight: 5, severity: 'minor' },
      { field: 'section_dimensions', category: 'Info Tabs', weight: 8, severity: 'major' },
      { field: 'section_documents', category: 'Info Tabs', weight: 8, severity: 'major' },
      { field: 'section_features', category: 'Info Tabs', weight: 8, severity: 'major' },
      { field: 'section_accessories', category: 'Info Tabs', weight: 6, severity: 'minor' },
    ],
  },
  // The three other Wix sites are scored from their channel_health snapshots
  // (compact content fingerprint per listing — no per-product cache needed).
  // Wording/weights mirror the SinksDirect CA card, minus the accessories tab
  // (only the CA store curates one) and plus price alignment, which the
  // snapshot already knows.
  wix_sinksdirect_us: {
    key: 'wix_sinksdirect_us',
    label: 'Sinks Direct USA',
    subtitle: 'Wix Stores',
    dataSource: 'wix_site',
    connectionType: 'api',
    requiresLink: true,
    checks: [
      { field: 'ws_listed', category: 'Identity', weight: 15, severity: 'critical' },
      { field: 'ws_live', category: 'Identity', weight: 8, severity: 'major' },
      { field: 'ws_name', category: 'Identity', weight: 8, severity: 'critical' },
      { field: 'ws_price', category: 'Pricing', weight: 10, severity: 'critical' },
      { field: 'ws_price_aligned', category: 'Pricing', weight: 8, severity: 'major' },
      { field: 'ws_description', category: 'Description', weight: 12, severity: 'critical' },
      { field: 'ws_main_image', category: 'Images', weight: 10, severity: 'critical' },
      { field: 'ws_images', category: 'Images', weight: 5, severity: 'minor' },
      { field: 'ws_section_dimensions', category: 'Info Tabs', weight: 8, severity: 'major' },
      { field: 'ws_section_documents', category: 'Info Tabs', weight: 8, severity: 'major' },
      { field: 'ws_section_features', category: 'Info Tabs', weight: 8, severity: 'major' },
    ],
  },
  wix_stylish_ca: {
    key: 'wix_stylish_ca',
    label: 'Stylish Canada',
    subtitle: 'Wix Stores',
    dataSource: 'wix_site',
    connectionType: 'api',
    requiresLink: true,
    checks: [
      { field: 'ws_listed', category: 'Identity', weight: 15, severity: 'critical' },
      { field: 'ws_live', category: 'Identity', weight: 8, severity: 'major' },
      { field: 'ws_name', category: 'Identity', weight: 8, severity: 'critical' },
      { field: 'ws_price', category: 'Pricing', weight: 10, severity: 'critical' },
      { field: 'ws_price_aligned', category: 'Pricing', weight: 8, severity: 'major' },
      { field: 'ws_description', category: 'Description', weight: 12, severity: 'critical' },
      { field: 'ws_main_image', category: 'Images', weight: 10, severity: 'critical' },
      { field: 'ws_images', category: 'Images', weight: 5, severity: 'minor' },
      { field: 'ws_section_dimensions', category: 'Info Tabs', weight: 8, severity: 'major' },
      { field: 'ws_section_documents', category: 'Info Tabs', weight: 8, severity: 'major' },
      { field: 'ws_section_features', category: 'Info Tabs', weight: 8, severity: 'major' },
    ],
  },
  wix_stylish_us: {
    key: 'wix_stylish_us',
    label: 'Stylish USA',
    subtitle: 'Wix Stores',
    dataSource: 'wix_site',
    connectionType: 'api',
    requiresLink: true,
    checks: [
      { field: 'ws_listed', category: 'Identity', weight: 15, severity: 'critical' },
      { field: 'ws_live', category: 'Identity', weight: 8, severity: 'major' },
      { field: 'ws_name', category: 'Identity', weight: 8, severity: 'critical' },
      { field: 'ws_price', category: 'Pricing', weight: 10, severity: 'critical' },
      { field: 'ws_price_aligned', category: 'Pricing', weight: 8, severity: 'major' },
      { field: 'ws_description', category: 'Description', weight: 12, severity: 'critical' },
      { field: 'ws_main_image', category: 'Images', weight: 10, severity: 'critical' },
      { field: 'ws_images', category: 'Images', weight: 5, severity: 'minor' },
      { field: 'ws_section_dimensions', category: 'Info Tabs', weight: 8, severity: 'major' },
      { field: 'ws_section_documents', category: 'Info Tabs', weight: 8, severity: 'major' },
      { field: 'ws_section_features', category: 'Info Tabs', weight: 8, severity: 'major' },
    ],
  },
  wayfair: {
    key: 'wayfair',
    label: 'Wayfair',
    subtitle: 'Product Catalog API',
    dataSource: 'wayfair',
    connectionType: 'api',
    requiresLink: true,
    checks: [
      { field: 'linked_to_wayfair', category: 'Identity', weight: 14, severity: 'critical' },
      { field: 'marketing_title', category: 'Identity', weight: 8, severity: 'critical' },
      { field: 'upc', category: 'Identity', weight: 6, severity: 'major' },
      { field: 'description', category: 'Content', weight: 10, severity: 'critical' },
      { field: 'bullet_points', category: 'Content', weight: 8, severity: 'major' },
      { field: 'warranty', category: 'Content', weight: 4, severity: 'minor' },
      { field: 'primary_image', category: 'Images', weight: 10, severity: 'critical' },
      { field: 'multiple_images', category: 'Images', weight: 5, severity: 'minor' },
      { field: 'external_dimensions', category: 'Specs', weight: 8, severity: 'critical' },
      { field: 'material', category: 'Specs', weight: 4, severity: 'major' },
      { field: 'finish', category: 'Specs', weight: 4, severity: 'major' },
      { field: 'gauge', category: 'Specs', weight: 3, severity: 'minor' },
      { field: 'number_of_bowls', category: 'Specs', weight: 3, severity: 'minor' },
      { field: 'shipping_weight', category: 'Shipping', weight: 5, severity: 'major' },
      { field: 'wayfair_specs_synced', category: 'Channel Sync', weight: 12, severity: 'major' },
    ],
  },
  bestbuy: {
    key: 'bestbuy',
    label: 'Best Buy Canada',
    subtitle: 'Mirakl marketplace (read-only)',
    dataSource: 'bestbuy',
    connectionType: 'api',
    requiresLink: true,
    checks: [
      { field: 'listed_on_bestbuy', category: 'Offer', weight: 15, severity: 'critical' },
      { field: 'bb_offer_active', category: 'Offer', weight: 8, severity: 'critical' },
      { field: 'bb_in_stock', category: 'Offer', weight: 8, severity: 'major' },
      { field: 'bb_price_matches', category: 'Offer', weight: 10, severity: 'major' },
      { field: 'marketing_title', category: 'Identity', weight: 8, severity: 'critical' },
      { field: 'upc', category: 'Identity', weight: 6, severity: 'major' },
      { field: 'description', category: 'Content', weight: 10, severity: 'critical' },
      { field: 'bullet_points', category: 'Content', weight: 6, severity: 'major' },
      { field: 'primary_image', category: 'Images', weight: 10, severity: 'critical' },
      { field: 'multiple_images', category: 'Images', weight: 4, severity: 'minor' },
      { field: 'price', category: 'Pricing', weight: 8, severity: 'critical' },
      { field: 'external_dimensions', category: 'Specs', weight: 6, severity: 'major' },
      { field: 'shipping_weight', category: 'Shipping', weight: 4, severity: 'minor' },
    ],
  },
  walmart_us: {
    key: 'walmart_us',
    label: 'Walmart US',
    subtitle: 'Marketplace API (read-only)',
    dataSource: 'walmart_us',
    connectionType: 'api',
    requiresLink: true,
    checks: [
      { field: 'listed_on_walmart', category: 'Listing', weight: 15, severity: 'critical' },
      { field: 'wm_published', category: 'Listing', weight: 12, severity: 'critical' },
      { field: 'wm_lifecycle_active', category: 'Listing', weight: 6, severity: 'major' },
      { field: 'marketing_title', category: 'Identity', weight: 8, severity: 'critical' },
      { field: 'upc', category: 'Identity', weight: 6, severity: 'major' },
      { field: 'description', category: 'Content', weight: 10, severity: 'critical' },
      { field: 'bullet_points', category: 'Content', weight: 6, severity: 'major' },
      { field: 'primary_image', category: 'Images', weight: 10, severity: 'critical' },
      { field: 'multiple_images', category: 'Images', weight: 4, severity: 'minor' },
      { field: 'external_dimensions', category: 'Specs', weight: 6, severity: 'major' },
      { field: 'shipping_weight', category: 'Shipping', weight: 4, severity: 'minor' },
    ],
  },
  walmart_ca: {
    key: 'walmart_ca',
    label: 'Walmart CA',
    subtitle: 'Presence via inventory feed (read-only)',
    dataSource: 'walmart_ca',
    connectionType: 'api',
    requiresLink: true,
    // Walmart's item APIs don't serve the CA catalog — presence comes from
    // the daily MP_INVENTORY feed, so only listed/readiness can be scored.
    checks: [
      { field: 'listed_on_walmart', category: 'Listing', weight: 18, severity: 'critical' },
      { field: 'marketing_title', category: 'Identity', weight: 8, severity: 'critical' },
      { field: 'upc', category: 'Identity', weight: 6, severity: 'major' },
      { field: 'description', category: 'Content', weight: 10, severity: 'critical' },
      { field: 'bullet_points', category: 'Content', weight: 6, severity: 'major' },
      { field: 'primary_image', category: 'Images', weight: 10, severity: 'critical' },
      { field: 'multiple_images', category: 'Images', weight: 4, severity: 'minor' },
      { field: 'price', category: 'Pricing', weight: 8, severity: 'critical' },
      { field: 'external_dimensions', category: 'Specs', weight: 6, severity: 'major' },
      { field: 'shipping_weight', category: 'Shipping', weight: 4, severity: 'minor' },
    ],
  },
  bbb: {
    key: 'bbb',
    label: 'BB&B / Overstock',
    subtitle: 'Template export readiness',
    dataSource: 'pim',
    connectionType: 'template',
    requiresLink: false,
    checks: [
      { field: 'sku', category: 'Identity', weight: 8, severity: 'critical' },
      { field: 'product_name', category: 'Identity', weight: 8, severity: 'critical' },
      { field: 'brand', category: 'Identity', weight: 5, severity: 'critical' },
      { field: 'upc', category: 'Identity', weight: 10, severity: 'critical' },
      { field: 'manufacturer', category: 'Identity', weight: 5, severity: 'major' },
      { field: 'description', category: 'Content', weight: 8, severity: 'critical' },
      { field: 'bullet_points', category: 'Content', weight: 6, severity: 'major' },
      { field: 'warranty', category: 'Content', weight: 4, severity: 'major' },
      { field: 'price', category: 'Pricing', weight: 8, severity: 'critical' },
      { field: 'dealer_cost', category: 'Pricing', weight: 4, severity: 'major' },
      { field: 'country_of_origin', category: 'Compliance', weight: 6, severity: 'critical' },
      { field: 'hs_code', category: 'Compliance', weight: 5, severity: 'major' },
      { field: 'material', category: 'Specs', weight: 4, severity: 'major' },
      { field: 'finish', category: 'Specs', weight: 4, severity: 'major' },
      { field: 'installation_type', category: 'Specs', weight: 5, severity: 'major' },
      { field: 'gauge', category: 'Specs', weight: 3, severity: 'minor' },
      { field: 'number_of_bowls', category: 'Specs', weight: 3, severity: 'minor' },
      { field: 'external_dimensions', category: 'Dimensions', weight: 8, severity: 'critical' },
      { field: 'shipping_dimensions', category: 'Shipping', weight: 6, severity: 'major' },
      { field: 'shipping_weight', category: 'Shipping', weight: 5, severity: 'critical' },
      { field: 'primary_image', category: 'Images', weight: 8, severity: 'critical' },
      { field: 'multiple_images', category: 'Images', weight: 4, severity: 'minor' },
    ],
  },
};

export const MARKETPLACE_KEYS = Object.keys(MARKETPLACES);

// Listing Health only scores marketplaces with a live API connection.
// Template-only marketplaces (BB&B, etc.) can't be reliably scored since
// we have no way to read their actual state — they're excluded.
export const API_MARKETPLACE_KEYS = MARKETPLACE_KEYS.filter(
  (k) => MARKETPLACES[k].connectionType === 'api',
);

// ===================== Scoring API =====================

export function scoreProduct(product, media, marketplace = 'wix') {
  const def = MARKETPLACES[marketplace];
  if (!def) throw new Error(`Unknown marketplace: ${marketplace}`);

  const enriched = { ...product, _media: media ?? [] };
  let earned = 0;
  let total = 0;
  const issues = [];
  const passed = [];

  for (const c of def.checks) {
    const f = FIELDS[c.field];
    if (!f) continue;
    total += c.weight;
    const entry = {
      key: c.field,
      label: f.label,
      category: c.category,
      weight: c.weight,
      severity: c.severity,
    };
    if (f.check(enriched)) {
      earned += c.weight;
      passed.push(entry);
    } else {
      issues.push(entry);
    }
  }

  return {
    score: total > 0 ? Math.round((earned / total) * 100) : 0,
    earned,
    total,
    issues,
    passed,
  };
}

export function categorizeScore(score) {
  if (score >= 90) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'needs_work';
  return 'critical';
}

export const SCORE_CATEGORIES = {
  excellent: { label: 'Excellent', range: '90-100%' },
  good: { label: 'Good', range: '70-89%' },
  needs_work: { label: 'Needs Work', range: '50-69%' },
  critical: { label: 'Critical', range: '0-49%' },
};

// Aggregate across all products (for a single marketplace's scores)
export function aggregateStats(productScores) {
  const stats = {
    distribution: { excellent: 0, good: 0, needs_work: 0, critical: 0 },
    avgScore: 0,
    issuesByField: {},
    topIssues: [],
  };

  let sum = 0;
  for (const { sku, result } of productScores) {
    stats.distribution[categorizeScore(result.score)]++;
    sum += result.score;

    for (const issue of result.issues) {
      if (!stats.issuesByField[issue.key]) {
        stats.issuesByField[issue.key] = {
          ...issue,
          count: 0,
          skus: [],
        };
      }
      stats.issuesByField[issue.key].count++;
      if (stats.issuesByField[issue.key].skus.length < 20) {
        stats.issuesByField[issue.key].skus.push(sku);
      }
    }
  }

  stats.avgScore = productScores.length > 0
    ? Math.round(sum / productScores.length)
    : 0;

  const severityWeight = { critical: 3, major: 2, minor: 1 };
  stats.topIssues = Object.values(stats.issuesByField)
    .sort((a, b) => (b.count * severityWeight[b.severity]) - (a.count * severityWeight[a.severity]));

  return stats;
}

// ===================== Data assembly (pure) =====================
// Everything below takes already-fetched rows — no I/O — so the browser
// (supabase-js) and the edge function (REST fetch) share one pipeline.

export function extractWixData(wixRaw) {
  if (!wixRaw || typeof wixRaw !== 'object') return null;

  const media = [];
  const mainUrl =
    wixRaw.media?.mainMedia?.image?.url ??
    wixRaw.media?.mainMedia?.thumbnail?.url;
  if (mainUrl) {
    media.push({ media_type: 'image', storage_path: mainUrl, is_primary: true });
  }
  for (const item of wixRaw.media?.items ?? []) {
    const url = item.image?.url ?? item.thumbnail?.url;
    if (!url || url === mainUrl) continue;
    const type = (item.mediaType ?? 'image').toLowerCase();
    media.push({
      media_type: type.includes('video') ? 'video' : 'image',
      storage_path: url,
      is_primary: false,
    });
  }

  return {
    model_name: wixRaw.name ?? null,
    description: wixRaw.description ?? null,
    brand: wixRaw.brand ?? null,
    msrp_cad: typeof wixRaw.price?.price === 'number' ? wixRaw.price.price : null,
    additional_info_sections: Array.isArray(wixRaw.additionalInfoSections)
      ? wixRaw.additionalInfoSections.map((s) => ({
          title: s.title ?? '',
          description: s.description ?? '',
        }))
      : [],
    _wix_media: media,
    _wix_fetched_at: wixRaw._fetched_at ?? null,
  };
}

/**
 * Score the whole catalog for every API-connected marketplace.
 *
 * @param list      products rows including a `product_media` array
 * @param snapshots per-SKU Maps from the latest channel_health snapshots:
 *                  { wayfairMap, bestbuyMap, walmartMaps: { walmart_us, walmart_ca } }
 *                  A null map = no snapshot yet (checks treat unknown as pass).
 */
export function buildListingHealthData(list, { wayfairMap = null, bestbuyMap = null, walmartMaps = { walmart_us: null, walmart_ca: null }, wixSiteMaps = {} } = {}) {
  // Enrich each product once with parsed Wix data + base fields
  const enriched = list.map((p) => {
    const wixData = extractWixData(p.wix_raw);
    return {
      sku: p.sku,
      model_name: p.model_name,
      brand: p.brand,
      category: p.category,
      workflow_status: p.workflow_status,
      wix_product_id: p.wix_product_id,
      raw: p,
      wixData,
      hasWixCache: Boolean(wixData),
      pimMedia: p.product_media ?? [],
    };
  });

  // Per-marketplace scoring — only API-connected marketplaces
  const perMarketplaceData = {};
  for (const mkt of API_MARKETPLACE_KEYS) {
    const def = MARKETPLACES[mkt];
    const scores = enriched.map((e) => {
      let product;
      let media;
      if (def.dataSource === 'wix_cache' && e.wixData) {
        product = { ...e.raw, ...e.wixData };
        media = e.wixData._wix_media;
      } else if (def.dataSource === 'wayfair') {
        product = {
          ...e.raw,
          _wayfairAudit: wayfairMap ? (wayfairMap.get(e.sku) ?? null) : undefined,
        };
        media = e.pimMedia;
      } else if (def.dataSource === 'bestbuy') {
        product = {
          ...e.raw,
          _bbOffer: bestbuyMap ? (bestbuyMap.get(e.sku) ?? null) : undefined,
        };
        media = e.pimMedia;
      } else if (def.dataSource in walmartMaps) {
        const wm = walmartMaps[def.dataSource];
        product = {
          ...e.raw,
          _wmItem: wm ? (wm.get(e.sku) ?? null) : undefined,
        };
        media = e.pimMedia;
      } else if (def.dataSource === 'wix_site') {
        const siteMap = wixSiteMaps[mkt] ?? null;
        product = {
          ...e.raw,
          _wixSite: siteMap ? (siteMap.get(e.sku) ?? null) : undefined,
        };
        media = e.pimMedia;
      } else {
        product = e.raw;
        media = e.pimMedia;
      }
      const result = scoreProduct(product, media, mkt);
      return {
        sku: e.sku,
        model_name: e.model_name,
        brand: e.brand,
        category: e.category,
        workflow_status: e.workflow_status,
        wix_product_id: e.wix_product_id,
        has_wix_cache: e.hasWixCache,
        source:
          def.dataSource === 'wix_cache'
            ? e.hasWixCache ? 'wix_cache' : (e.wix_product_id ? 'pim_fallback' : 'not_linked')
            : def.dataSource === 'wayfair'
              ? e.raw.wayfair_item_group_id ? 'pim' : 'not_linked'
              : def.dataSource === 'bestbuy'
                ? (bestbuyMap && bestbuyMap.get(e.sku) ? 'offer' : 'not_linked')
                : def.dataSource in walmartMaps
                  ? (walmartMaps[def.dataSource]?.get(e.sku) ? 'offer' : 'not_linked')
                  : def.dataSource === 'wix_site'
                    ? (wixSiteMaps[mkt]?.get(e.sku) ? 'site' : 'not_linked')
                    : 'pim',
        // The live site listing row (price/state/content fingerprint), for
        // the breakdown drawer.
        wix_site:
          def.dataSource === 'wix_site' && wixSiteMaps[mkt]
            ? wixSiteMaps[mkt].get(e.sku) ?? null
            : undefined,
        // Which spec attributes differ at Wayfair (from the audit),
        // so the breakdown can name them.
        wayfair_audit:
          def.dataSource === 'wayfair' && wayfairMap ? wayfairMap.get(e.sku) ?? null : undefined,
        // The live Best Buy offer (price/stock/msrp), for the breakdown.
        bb_offer:
          def.dataSource === 'bestbuy' && bestbuyMap ? bestbuyMap.get(e.sku) ?? null : undefined,
        // The live Walmart item (US: published/lifecycle/price USD;
        // CA: feed presence).
        wm_item:
          def.dataSource in walmartMaps && walmartMaps[def.dataSource]
            ? walmartMaps[def.dataSource].get(e.sku) ?? null
            : undefined,
        result,
      };
    });
    const stats = aggregateStats(scores);
    const cachedCount = scores.filter((s) => s.has_wix_cache).length;
    const linkedCount =
      def.dataSource === 'wayfair'
        ? enriched.filter((e) => e.raw.wayfair_item_group_id).length
        : def.dataSource === 'wix_site'
          ? scores.filter((s) => s.source === 'site').length
          : scores.filter((s) => s.wix_product_id).length;
    perMarketplaceData[mkt] = { products: scores, stats, cachedCount, linkedCount };
  }

  return { enriched, perMarketplaceData };
}

/**
 * Collapse full per-marketplace data into the light summary shape the
 * Dashboard consumes — the same shape it reads back from the persisted
 * snapshots.
 */
export function summarizeForDashboard(perMarketplaceData) {
  const runAt = new Date().toISOString();
  const summaries = {};
  for (const [mkt, data] of Object.entries(perMarketplaceData)) {
    summaries[mkt] = {
      runAt,
      total: data.products.length,
      avgScore: data.stats.avgScore,
      distribution: data.stats.distribution,
      linkedCount: data.linkedCount,
      topIssues: data.stats.topIssues.slice(0, 10).map((i) => ({
        key: i.key,
        label: i.label,
        category: i.category,
        severity: i.severity,
        count: i.count,
      })),
    };
  }
  return summaries;
}

/**
 * The `channel_health` rows (channel = 'listing_health', target = <mkt>)
 * that persist those summaries for the Dashboard to read.
 */
export function buildSummaryRows(perMarketplaceData) {
  const summaries = summarizeForDashboard(perMarketplaceData);
  return Object.entries(summaries).map(([mkt, summary]) => {
    const d = summary.distribution;
    return {
      channel: 'listing_health',
      target: mkt,
      total: summary.total,
      in_sync: d.excellent + d.good,
      with_diffs: d.needs_work,
      errors: d.critical,
      partial: false,
      top_offenders: {
        avgScore: summary.avgScore,
        distribution: d,
        linkedCount: summary.linkedCount,
        topIssues: summary.topIssues,
      },
    };
  });
}
