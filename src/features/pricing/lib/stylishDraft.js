// The Stylish discount of a special event as the form holds it, and what is
// saved from it (promotions.stylish_discount; see lib/stylishDiscount.js).
import { parsePriceList } from '../api/promotions';

const MARKET_OF = { wix_stylish_ca: 'ca', wix_stylish_us: 'us' };
const MARKET_LABEL = { ca: 'Stylish Canada', us: 'Stylish USA' };

/** The markets of the Stylish stores among an event's portals. */
export const stylishMarkets = (portals) => (portals ?? []).map((k) => MARKET_OF[k]).filter(Boolean);

export const emptyStylishDraft = () => ({ mode: 'percent', percent: '', ca: '', us: '' });

export function draftFromDiscount(discount) {
  if (!discount) return emptyStylishDraft();
  const lines = (list) => Object.entries(list ?? {}).map(([sku, price]) => `${sku} ${price}`).join('\n');
  return {
    mode: discount.mode ?? 'percent',
    percent: discount.percent != null ? String(discount.percent) : '',
    ca: lines(discount.prices?.ca),
    us: lines(discount.prices?.us),
  };
}

/** Is there anything typed for a price-mode event yet? */
export const draftHasPrices = (draft, markets) => draft.mode === 'price' && markets.some((m) => draft[m].trim());

/** { discount } to save, or { error } in words for the person. */
export function buildStylishDiscount(draft, markets) {
  if (draft.mode === 'percent') {
    const percent = Number(draft.percent);
    if (!(percent > 0 && percent < 100)) return { error: 'Stylish stores: type the discount, a percentage between 0 and 100.' };
    return { discount: { mode: 'percent', percent } };
  }
  const prices = {};
  for (const m of markets) {
    const { rows, skipped } = parsePriceList(draft[m]);
    if (skipped.length) return { error: `${MARKET_LABEL[m]}: these lines need a SKU and a price: ${skipped.slice(0, 5).join(' · ')}` };
    if (!rows.length) return { error: `${MARKET_LABEL[m]}: add what the customer pays, one SKU and price per line.` };
    prices[m] = Object.fromEntries(rows.map((r) => [r.sku.toUpperCase(), r.price]));
  }
  return { discount: { mode: 'price', prices } };
}
