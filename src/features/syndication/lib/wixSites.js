// The four Wix sites the PIM syndicates to. Mirror of
// supabase/functions/_shared/wixSites.ts — keep both in sync.
//
// Selling-price rule (verified against the live catalogs 2026-08-14):
// SinksDirect sites are the outlet and sell at MAP; Stylish sites are the
// brand stores and sell at MSRP. Currency follows the market.

export const WIX_SITES = {
  sinksdirect_ca: {
    key: 'sinksdirect_ca',
    channel: 'wix',
    promoAware: true,
    label: 'Sinks Direct Canada',
    short: 'SinksDirect CA',
    url: 'https://www.sinksdirect.ca',
    currency: 'CAD',
    symbol: 'C$',
    priceField: 'map_cad',
    priceLabel: 'Price (CAD) — MAP',
    priceShort: 'MAP (CAD)',
    priceHint: 'SinksDirect sells at the Canadian MAP.',
    excludedBrands: [],
    market: 'ca',
    hasSale: true,
    hasCollections: true,
  },
  sinksdirect_us: {
    key: 'sinksdirect_us',
    channel: 'wix_sinksdirect_us',
    promoAware: true,
    label: 'Sinks Direct USA',
    short: 'SinksDirect USA',
    url: 'https://www.sinksdirectusa.com',
    currency: 'USD',
    symbol: '$',
    priceField: 'map_usd',
    priceLabel: 'Price (USD) — MAP',
    priceShort: 'MAP (USD)',
    priceHint: 'SinksDirect USA sells at the US MAP.',
    excludedBrands: [],
    market: 'us',
    hasSale: false,
    hasCollections: false,
  },
  stylish_ca: {
    key: 'stylish_ca',
    channel: 'wix_stylish_ca',
    promoAware: false,
    label: 'Stylish Canada',
    short: 'Stylish CA',
    url: 'https://www.stylishkb.com',
    currency: 'CAD',
    symbol: 'C$',
    priceField: 'msrp_cad',
    priceLabel: 'Price (CAD) — MSRP',
    priceShort: 'MSRP (CAD)',
    priceHint: 'The Stylish brand store sells at the Canadian MSRP.',
    excludedBrands: ['azuni'],
    market: 'ca',
    hasSale: false,
    hasCollections: false,
  },
  // The Azuni brand store: only Azuni products exist for it (onlyBrands).
  azuni_ca: {
    key: 'azuni_ca',
    channel: 'wix_azuni_ca',
    promoAware: true,
    label: 'Azuni Canada',
    short: 'Azuni CA',
    url: 'https://www.azuni.ca',
    currency: 'CAD',
    symbol: 'C$',
    priceField: 'map_cad',
    priceLabel: 'Price (CAD) — MAP',
    priceShort: 'MAP (CAD)',
    priceHint: 'The Azuni store sells at the Canadian MAP.',
    excludedBrands: [],
    onlyBrands: ['azuni'],
    market: 'ca',
    hasSale: false,
    hasCollections: false,
  },
  stylish_us: {
    key: 'stylish_us',
    channel: 'wix_stylish_us',
    promoAware: false,
    label: 'Stylish USA',
    short: 'Stylish USA',
    url: 'https://www.stylishkbusa.com',
    currency: 'USD',
    symbol: '$',
    priceField: 'msrp_usd',
    priceLabel: 'Price (USD) — MSRP',
    priceShort: 'MSRP (USD)',
    priceHint: 'The Stylish brand store sells at the US MSRP.',
    excludedBrands: ['azuni'],
    market: 'us',
    hasSale: false,
    hasCollections: false,
  },
};

export const WIX_SITE_KEYS = Object.keys(WIX_SITES);
export const DEFAULT_WIX_SITE = 'sinksdirect_ca';

/**
 * Brand rule (2026-09-09): Azuni products are NEVER sold on the Stylish brand
 * stores. For those sites they don't exist — not in Listing Health, not in
 * pricing or price alignment, not in links or pushes. SinksDirect carries
 * every brand. `product` may be a product row or a brand string.
 */
export function wixSiteSells(siteOrKey, product) {
  const cfg = typeof siteOrKey === 'string' ? WIX_SITES[siteOrKey] : siteOrKey;
  const brand = (typeof product === 'string' ? product : product?.brand ?? '').toLowerCase();
  if (cfg?.onlyBrands?.length) return cfg.onlyBrands.some((b) => brand.includes(b));
  return !(cfg?.excludedBrands ?? []).some((b) => brand.includes(b));
}

/** The site keys that carry this product's brand. */
export const wixSitesFor = (product) => WIX_SITE_KEYS.filter((k) => wixSiteSells(k, product));
