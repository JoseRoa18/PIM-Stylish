// The four Wix sites the PIM syndicates to. Mirror of
// supabase/functions/_shared/wixSites.ts — keep both in sync.
//
// Selling-price rule (verified against the live catalogs 2026-08-14):
// SinksDirect sites are the outlet and sell at MAP; Stylish sites are the
// brand stores and sell at MSRP. Currency follows the market.

export const WIX_SITES = {
  sinksdirect_ca: {
    key: 'sinksdirect_ca',
    label: 'Sinks Direct Canada',
    short: 'SinksDirect CA',
    url: 'https://www.sinksdirect.ca',
    currency: 'CAD',
    symbol: 'C$',
    priceField: 'map_cad',
    priceLabel: 'Price (CAD) — MAP',
    priceHint: 'SinksDirect sells at the Canadian MAP.',
    market: 'ca',
    hasSale: true,
    hasCollections: true,
  },
  sinksdirect_us: {
    key: 'sinksdirect_us',
    label: 'Sinks Direct USA',
    short: 'SinksDirect USA',
    url: 'https://www.sinksdirectusa.com',
    currency: 'USD',
    symbol: '$',
    priceField: 'map_usd',
    priceLabel: 'Price (USD) — MAP',
    priceHint: 'SinksDirect USA sells at the US MAP.',
    market: 'us',
    hasSale: false,
    hasCollections: false,
  },
  stylish_ca: {
    key: 'stylish_ca',
    label: 'Stylish Canada',
    short: 'Stylish CA',
    url: 'https://www.stylishkb.com',
    currency: 'CAD',
    symbol: 'C$',
    priceField: 'msrp_cad',
    priceLabel: 'Price (CAD) — MSRP',
    priceHint: 'The Stylish brand store sells at the Canadian MSRP.',
    market: 'ca',
    hasSale: false,
    hasCollections: false,
  },
  stylish_us: {
    key: 'stylish_us',
    label: 'Stylish USA',
    short: 'Stylish USA',
    url: 'https://www.stylishkbusa.com',
    currency: 'USD',
    symbol: '$',
    priceField: 'msrp_usd',
    priceLabel: 'Price (USD) — MSRP',
    priceHint: 'The Stylish brand store sells at the US MSRP.',
    market: 'us',
    hasSale: false,
    hasCollections: false,
  },
};

export const WIX_SITE_KEYS = Object.keys(WIX_SITES);
export const DEFAULT_WIX_SITE = 'sinksdirect_ca';
