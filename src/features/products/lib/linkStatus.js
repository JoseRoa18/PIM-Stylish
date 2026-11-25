// The status a link shows on the product's Where to Buy tab, from what the
// check last found on its address. One rule for the row's chip and for what a
// "Read again" says when it ends.

export const LINK_STATUS = {
  ok: { label: 'OK', cls: 'bg-success-container text-on-success-container' },
  broken: { label: 'Broken', cls: 'bg-error-container text-on-error-container' },
  wrong: { label: 'Wrong product', cls: 'bg-warning-container text-on-warning-container' },
  // Sold out on the store (2026-10-26): off the websites until the store has it again.
  outOfStock: { label: 'Out of stock', cls: 'bg-tertiary-container text-on-tertiary-container' },
  // The right listing on its default option (Wayfair without ?piid=): shown on the websites.
  otherFinish: { label: 'Other finish', cls: 'bg-surface-container-high text-on-surface-variant' },
  pending: { label: 'Checking', cls: 'bg-surface-container-high text-on-surface-variant' },
  manual: { label: 'Check by hand', cls: 'bg-surface-container-high text-on-surface-variant' },
};

export const isWrong = (check) => check?.sku_check === 'other' || check?.sku_check === 'variant';
export const isOtherFinish = (check) => check?.sku_check === 'listing';
// The stock of an "Other finish" page is the store's default option's.
export const isSoldOut = (check) => check?.in_stock === false && !isOtherFinish(check);

/** The key of LINK_STATUS a link's check reads as (a link without a check yet: pending). */
export function linkStatusKey(check) {
  const live = check?.verdict !== 'broken';
  if (live && isWrong(check)) return 'wrong';
  if (live && isSoldOut(check)) return 'outOfStock';
  if (live && isOtherFinish(check)) return 'otherFinish';
  return LINK_STATUS[check?.verdict] ? check.verdict : 'pending';
}

export const priceText = (check) => {
  if (check?.price == null) return '';
  const symbol = check.currency === 'USD' ? '$' : check.currency === 'CAD' ? 'C$' : '';
  return `${symbol}${Number(check.price).toFixed(2)}`;
};
