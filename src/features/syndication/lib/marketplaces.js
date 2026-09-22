// Every marketplace the PIM talks to, with the key used for per-product
// exclusions (products.channel_exclusions, rule 2026-09-22): a product
// switched off for a marketplace gets NOTHING there — no content or media
// pushes, no new listings, no template exports, no promotion files or
// promo pushes. The keys match the promotion channels (promoChannels.js)
// and the Wix sites (wixSites.js, prefixed wix_).

export const MARKETPLACES = [
  { key: 'wix_sinksdirect_ca', label: 'Sinks Direct Canada', monogram: 'SD', market: 'ca', wixSite: 'sinksdirect_ca' },
  { key: 'wix_stylish_ca', label: 'Stylish Canada', monogram: 'ST', market: 'ca', wixSite: 'stylish_ca' },
  { key: 'wix_azuni_ca', label: 'Azuni Canada', monogram: 'AZ', market: 'ca', wixSite: 'azuni_ca' },
  { key: 'wayfair_ca', label: 'Wayfair Canada', monogram: 'WF', market: 'ca' },
  { key: 'bestbuy', label: 'Best Buy Canada', monogram: 'BB', market: 'ca' },
  { key: 'walmart_ca', label: 'Walmart Canada', monogram: 'WM', market: 'ca' },
  { key: 'amazon_ca', label: 'Amazon Canada', monogram: 'AM', market: 'ca' },
  { key: 'homedepot_ca', label: 'Home Depot Canada', monogram: 'HD', market: 'ca' },
  { key: 'rona', label: 'Rona', monogram: 'RO', market: 'ca' },
  { key: 'wix_sinksdirect_us', label: 'Sinks Direct USA', monogram: 'SD', market: 'us', wixSite: 'sinksdirect_us' },
  { key: 'wix_stylish_us', label: 'Stylish USA', monogram: 'ST', market: 'us', wixSite: 'stylish_us' },
  { key: 'wayfair_us', label: 'Wayfair USA', monogram: 'WF', market: 'us' },
  { key: 'walmart_us', label: 'Walmart USA', monogram: 'WM', market: 'us' },
  { key: 'amazon_us', label: 'Amazon USA', monogram: 'AM', market: 'us' },
  { key: 'homedepot_us', label: 'Home Depot USA', monogram: 'HD', market: 'us' },
  { key: 'lowes_us', label: "Lowe's USA", monogram: 'LO', market: 'us' },
  { key: 'menards', label: 'Menards', monogram: 'ME', market: 'us' },
  { key: 'bbb', label: 'BB&B / Overstock', monogram: 'BO', market: 'us' },
];

export const marketplaceLabel = (key) => MARKETPLACES.find((m) => m.key === key)?.label ?? key;

/** The exclusion key of a Wix site ('sinksdirect_ca' → 'wix_sinksdirect_ca'). */
export const wixExclusionKey = (site) => `wix_${site}`;

/** Is the product switched off for this marketplace key? */
export const isExcluded = (product, key) => Array.isArray(product?.channel_exclusions) && product.channel_exclusions.includes(key);

/** Keys the product is excluded from, in MARKETPLACES order. */
export const excludedKeys = (product) => MARKETPLACES.filter((m) => isExcluded(product, m.key)).map((m) => m.key);

/**
 * The exclusion key of a template's marketplace name ("Amazon US",
 * "BB&B / Overstock US", "Home Depot CA", "Wayfair CA"…), or null when the
 * name is not one of ours.
 */
export function templateMarketplaceKey(name) {
  const n = String(name ?? '').toLowerCase();
  const ca = /\b(ca|canada)\b/.test(n);
  if (/wayfair/.test(n)) return ca ? 'wayfair_ca' : 'wayfair_us';
  if (/amazon/.test(n)) return ca ? 'amazon_ca' : 'amazon_us';
  if (/walmart/.test(n)) return ca ? 'walmart_ca' : 'walmart_us';
  if (/home ?depot/.test(n)) return ca ? 'homedepot_ca' : 'homedepot_us';
  if (/lowe/.test(n)) return 'lowes_us';
  if (/menards/.test(n)) return 'menards';
  if (/bb&b|bbb|overstock/.test(n)) return 'bbb';
  if (/rona/.test(n)) return 'rona';
  if (/best ?buy/.test(n)) return 'bestbuy';
  return null;
}
