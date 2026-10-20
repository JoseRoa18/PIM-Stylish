// The stores whose prices come from their own product pages (user,
// 2026-10-20: "traer el precio para el price alignment"): none has an API the
// PIM reads, so the Where to Buy check reads the price each page shows when
// it opens the link — every 3 days, at no extra cost (_shared/pageProduct.js
// writes it on where_to_buy_links). Analysis only: the store sets its own
// price. Expected = MAP of the market, or the promotion running there — the
// market's monthly promo for its members (the dealers, with no promo channel
// of their own, follow it too) and a flash deal / special event on that
// marketplace; BB&B and Overstock take flash deals at Purple (levelByKind,
// as their promo files). Sinks Direct, Best Buy and Walmart keep their API
// reads. A plain list (no imports) so the product page can tell which
// readings Price Alignment uses without loading the alignment code.
export const PAGE_STORES = [
  { key: 'wayfair_ca', label: 'Wayfair Canada', short: 'Wayfair CA', market: 'ca', promoChannel: 'wayfair_ca' },
  { key: 'amazon_ca', label: 'Amazon Canada', short: 'Amazon CA', market: 'ca', promoChannel: 'amazon_ca' },
  // Home Depot Canada's NLP workbook leaves out a kitchen sink whose promo is
  // under its 5% minimum (homeDepotCaNlp.js): that sink stays at MAP there.
  { key: 'homedepot_ca', label: 'Home Depot Canada', short: 'Home Depot CA', market: 'ca', promoChannel: 'homedepot_ca', nlpMinimum: true },
  { key: 'rona', label: 'Rona', short: 'Rona', market: 'ca', promoChannel: 'rona' },
  { key: 'cabinet_depot', label: 'Cabinet Depot', short: 'Cabinet Depot', market: 'ca', promoChannel: null },
  // Build with Rise sits under Canada on the Stylish pages, but its store
  // sells in USD only (every price = the USD MAP, 2026-10-20): compared in USD.
  { key: 'build_with_rise', label: 'Build with Rise', short: 'Build with Rise', market: 'us', promoChannel: null },
  { key: 'wayfair_us', label: 'Wayfair USA', short: 'Wayfair US', market: 'us', promoChannel: 'wayfair_us' },
  { key: 'amazon_us', label: 'Amazon USA', short: 'Amazon US', market: 'us', promoChannel: 'amazon_us' },
  { key: 'homedepot_us', label: 'Home Depot USA', short: 'Home Depot US', market: 'us', promoChannel: 'homedepot_us' },
  { key: 'lowes_us', label: "Lowe's USA", short: "Lowe's", market: 'us', promoChannel: 'lowes_us' },
  { key: 'menards', label: 'Menards', short: 'Menards', market: 'us', promoChannel: 'menards' },
  { key: 'bbb_us', label: 'Bed Bath & Beyond', short: 'BB&B', market: 'us', promoChannel: 'bbb', levelByKind: { flash: 'purple' } },
  { key: 'overstock_us', label: 'Overstock', short: 'Overstock', market: 'us', promoChannel: 'overstock', levelByKind: { flash: 'purple' } },
  { key: 'kbauthority', label: 'Kitchen & Bath Authority', short: 'KBA', market: 'us', promoChannel: null },
  { key: 'warehouse_usa', label: 'Warehouse-USA', short: 'Warehouse USA', market: 'us', promoChannel: null },
  // Dealers that sell Stylish but are NOT on the Stylish pages' Where to Buy
  // (user, 2026-10-20: cover what Price2Spy watched before it is cancelled).
  // Their links are kept apart (where_to_buy_links site "dealers", section
  // "price_watch" — scripts/import-dealer-links.mjs) and only read for price.
  // From Price2Spy's Canada report of 2026-06-22; Aqualuxe and Amati Canada
  // no longer carry Stylish (every link 404, nothing Stylish in their search)
  // and Houzz's shop is closed (user: discontinued).
  { key: 'aquarina', label: 'Aquarina', short: 'Aquarina', market: 'ca', promoChannel: null, dealer: true, host: /(^|\.)aquarina\.ca$/ },
  { key: 'plumbing_market', label: 'Plumbing Market', short: 'Plumbing Market', market: 'ca', promoChannel: null, dealer: true, host: /(^|\.)plumbingmarket\.ca$/ },
  { key: 'vatero', label: 'Vatero', short: 'Vatero', market: 'ca', promoChannel: null, dealer: true, host: /(^|\.)vatero\.com$/ },
];

// The dealers watched for price only (not on the Stylish pages).
export const DEALER_STORES = PAGE_STORES.filter((s) => s.dealer);

export const PAGE_STORE_KEYS = new Set(PAGE_STORES.map((s) => s.key));

// Is this reading of a store page compared by Price Alignment? Only a page on
// this very product (or one that names no model at all), with a price.
export const readingCounts = (row) => row?.price != null
  && (row.sku_check === 'match' || (row.sku_check === 'unknown' && !row.page_model));
