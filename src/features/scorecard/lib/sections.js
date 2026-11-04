// The themes an EOS ScoreCard tab is grouped by (user's layout choice,
// 2026-11-04), in the order they show. A measurable's `section` names one;
// without it the theme is read from its name.
export const SECTIONS = [
  { key: 'pricing', label: 'Pricing & promotions' },
  { key: 'sales', label: 'Sales & ads' },
  { key: 'catalog', label: 'Catalog, stock & reviews' },
  { key: 'operations', label: 'Shipping & service' },
  { key: 'returns', label: 'Returns & refunds' },
  { key: 'notes', label: 'Actions & notes' },
];
const KEYS = new Set(SECTIONS.map((s) => s.key));

export function sectionOf(metric) {
  if (metric.section && KEYS.has(metric.section)) return metric.section;
  const n = metric.name.toLowerCase();
  if (metric.unit === 'text' || /actio?n?s? taken|actiosn taken/.test(n)) return 'notes';
  if (/return|refund|reimburs|shipping que/.test(n)) return 'returns';
  if (/not sales/.test(n)) return 'catalog';
  if (/map %|promo|flash|event|coupon/.test(n)) return 'pricing';
  if (/cancel|on-time|late ship|tracking|deliver|defect|unresponsive|response time|csat|replacement parts/.test(n)) return 'operations';
  if (/sales|units sold|ads|cpc|keyword|acos|spent|profitab|loss due/.test(n)) return 'sales';
  return 'catalog';
}
