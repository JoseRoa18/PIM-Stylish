// The words of a Price Alignment report, said once: the Pricing page's tiles
// and its Above / Below filter, and the Excel of the same list
// (alignmentExcel.js), read them from here.

/** "MAP" or "MSRP": the regular price a target is compared with. */
export const regularPriceName = (cfg) => (cfg.priceField.startsWith('map') ? 'MAP' : 'MSRP');

// Tiles per site: SinksDirect sites are promo-aware (5 buckets), Stylish
// brand sites compare only the base price against MSRP (3 buckets — their
// own storefront sales are not drift).
export function alignTiles(cfg) {
  const priceName = regularPriceName(cfg);
  return [
    ...(cfg.promoAware ? [{ key: 'promo_ok', label: 'At promo price', tone: 'ok' }] : []),
    { key: 'map_ok', label: `At regular ${priceName}`, tone: 'ok' },
    ...(cfg.promoAware ? [{ key: 'promo_missing', label: 'Missing promo price', tone: 'warn' }] : []),
    { key: 'misaligned', label: 'Misaligned', tone: 'error' },
    { key: 'no_map', label: `No ${priceName} in PIM`, tone: 'muted' },
  ];
}

// Which side of its expected price a problem's live price is on (user,
// 2026-11-11: "si está por debajo o por arriba, como para filtrar"). 'none' =
// nothing to compare: no promo on the store, or no price in the PIM. A problem
// with both prices is never equal to it (it would be aligned).
export const priceSide = (p) => (p.live != null && p.expected != null ? (p.live > p.expected ? 'above' : 'below') : 'none');
export const PRICE_SIDE_LABEL = { above: 'Above', below: 'Below', none: 'No price' };
