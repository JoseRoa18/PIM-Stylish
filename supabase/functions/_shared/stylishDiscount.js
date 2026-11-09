// The discount of a special event on the Stylish stores (user, 2026-11-09),
// shared by the app (re-exported by src/features/pricing/lib/stylishDiscount.js)
// and the edge function stylish-event-discounts.
//
// The customer buys at 70% off the store price. An event lowers what the
// customer pays, and the store has to show the price that gives it:
//   MSRP 100 → the customer pays 30 → 10% off = 27 → 27 / 0.3 = 90 on the store.
// By percentage that is the same % off the MSRP. By price the person gives what
// the customer pays per product and the store price is that amount / 0.3.
//
// It goes as a Wix discount, so the base price stays at the MSRP (Price
// Alignment and Listing Health keep comparing the MSRP) and no other push
// touches it.

export const STYLISH_SITE_OF = { wix_stylish_ca: 'stylish_ca', wix_stylish_us: 'stylish_us' };
export const STYLISH_CHANNELS = Object.keys(STYLISH_SITE_OF);
// The coupon approved customers use at checkout (DEAL70%): Wix's own
// configuration, not the PIM's (user).
export const CUSTOMER_OFF = 70;

const cents = (n) => Math.round(n * 100) / 100;

/** The store price that makes the customer pay `customerPrice` (27 → 90). */
export function storePriceFor(customerPrice) {
  return cents(Number(customerPrice) / (1 - CUSTOMER_OFF / 100));
}

/**
 * The Wix discount of one product: { type, value, storePrice }, or
 * { skip: reason } when it cannot have one. `market` is 'ca' | 'us'.
 */
export function discountFor(config, msrp, market, sku) {
  const base = Number(msrp);
  if (!(base > 0)) return { skip: 'no MSRP in the PIM' };
  if (config?.mode === 'percent') {
    const percent = Number(config.percent);
    if (!(percent > 0 && percent < 100)) return { skip: 'the percentage is not valid' };
    return { type: 'PERCENT', value: percent, storePrice: cents(base * (1 - percent / 100)) };
  }
  if (config?.mode === 'price') {
    const customer = Number(config.prices?.[market]?.[sku]);
    if (!(customer > 0)) return { skip: 'no price given' };
    const storePrice = storePriceFor(customer);
    if (storePrice >= base) return { skip: `store price ${storePrice} is not under the MSRP ${base}` };
    return { type: 'AMOUNT', value: cents(base - storePrice), storePrice };
  }
  return { skip: 'the event has no discount' };
}
