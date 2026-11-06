// A new offer on Best Buy Canada, from the PIM (user, 2026-11-06: "crear productos
// desde 0"). Only two things are filled (user, the same day: "el que dice Price
// sería el MAP Blue; Warranty parts and labor es siempre 0; solo se llenan esas dos
// cosas"): Price = MAP Blue CAD, Warranty - Parts & Labour ("manufacturer-warranty",
// required by Best Buy) = 0. The rest stays empty, so the offer starts at 0 units
// and Stock sync gives it its stock with the next Canada file. Used by
// bestbuy-new-listing and, through src/features/syndication/lib/bestbuyOffer.js,
// by the product's card.

const NEW_STATE = '11'; // Best Buy's only state: New
const WARRANTY_DAYS = 0;

export function upcType(upc) {
  const n = String(upc ?? '').length;
  return n === 12 ? 'UPC-A' : n === 13 ? 'EAN' : null;
}

/** The offer a product would get. `problems` = what it lacks to get one. */
export function offerPlan(product) {
  const upc = product.attributes?.upc ? String(product.attributes.upc).trim() : null;
  const type = upcType(upc);
  const price = product.map_cad == null ? null : Number(product.map_cad);
  const problems = [];
  if (!upc) problems.push('no UPC in the PIM');
  else if (!type) problems.push(`the UPC ${upc} is not 12 or 13 digits`);
  if (!(price > 0)) problems.push('no MAP Blue CAD in the PIM');
  return { upc, upcType: type, price, warrantyDays: WARRANTY_DAYS, problems };
}

/** Mirakl's OF24 line: who it is, the price and the warranty; nothing else is filled. */
export function offerLine(sku, plan) {
  return {
    shop_sku: sku,
    product_id: plan.upc,
    product_id_type: plan.upcType,
    state_code: NEW_STATE,
    price: plan.price,
    update_delete: 'update',
    offer_additional_fields: [{ code: 'manufacturer-warranty', value: String(WARRANTY_DAYS) }],
  };
}

// What a page of this product must name. A UPC Best Buy already has can belong
// to another product: D-701N2 (a drain in the PIM) is a kitchen faucet combo
// there, and an offer on that UPC would sell a drain on a faucet's page.
const ACCESSORY_WORDS = [
  [/drain/i, /drain/i], [/strainer/i, /strainer/i], [/plate|escutcheon/i, /plate|cover|escutcheon/i], [/board/i, /board/i], [/rack|organi[sz]er/i, /rack|organi[sz]er/i],
  [/\bmat\b/i, /\bmat\b|trivet/i], [/colander/i, /colander/i], [/hose/i, /hose/i], [/dispenser/i, /dispenser/i], [/basket/i, /basket/i], [/remover/i, /remover/i], [/ring/i, /ring/i], [/\bcover\b/i, /cover/i],
];
function expectedWords(product) {
  const c = String(product.category ?? '');
  if (/faucet|tap|filler/.test(c)) return /faucet|tap\b|filler/i;
  if (/sink/.test(c)) return /sink/i;
  const name = `${product.model_name ?? ''} ${product.attributes?.general_title_en ?? ''}`;
  return ACCESSORY_WORDS.find(([is]) => is.test(name))?.[1] ?? null;
}

/** True when the listing Best Buy has for this UPC plainly is another kind of product. */
export function catalogMismatch(product, title) {
  const words = expectedWords(product);
  return Boolean(words && title && !words.test(title));
}
