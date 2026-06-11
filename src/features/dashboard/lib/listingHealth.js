/**
 * Listing Health — multi-marketplace readiness scoring.
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
  dealer_cost: { label: 'Dealer Cost', check: (p) => hasNumber(p.dealer_cost_cad) && p.dealer_cost_cad > 0 },
  shipping_weight: { label: 'Shipping Weight', check: (p) => hasNumber(p.shipping_weight_lb) && p.shipping_weight_lb > 0 },
  material: { label: 'Material', check: (p) => hasText(p.material) },
  finish: { label: 'Finish', check: (p) => hasText(p.finish) },
  upc: { label: 'UPC', check: (p) => hasText(attr(p, 'upc')) },
  manufacturer: { label: 'Manufacturer', check: (p) => hasText(attr(p, 'manufacturer')) },
  warranty: { label: 'Warranty', check: (p) => hasText(attr(p, 'warranty')) },
  country_of_origin: { label: 'Country of Origin', check: (p) => hasText(attr(p, 'country_of_origin')) },
  hs_code: { label: 'HS Code', check: (p) => hasText(attr(p, 'hs_code')) },
  installation_type: { label: 'Installation Type', check: (p) => hasText(attr(p, 'installation_type')) || hasArray(attr(p, 'installation_type')) },
  gauge: { label: 'Gauge', check: (p) => hasText(attr(p, 'gauge')) || hasNumber(attr(p, 'gauge')) },
  number_of_bowls: { label: 'Number of Bowls', check: (p) => hasNumber(attr(p, 'number_of_bowls')) },
  external_dimensions: { label: 'External Dimensions', check: (p) => hasDims(attr(p, 'external_dimensions_in')) },
  shipping_dimensions: { label: 'Shipping Dimensions', check: (p) => hasDims(attr(p, 'shipping_dimensions_in')) },
  bullet_points: { label: 'Bullet Points', check: (p) => hasArray(attr(p, 'bullet_points'), 4) },
  primary_image: { label: 'Primary Image', check: (p) => hasPrimaryImage(p._media) },
  multiple_images: { label: '5+ Images', check: (p) => countImages(p._media) >= 5 },
  linked_to_wix: { label: 'Linked to Wix', check: (p) => hasText(p.wix_product_id) },
  visible_online: { label: 'Visible Online', check: (p) => p.visible_online === true },
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
