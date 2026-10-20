// Page readers for Lowe's USA and Rona (Where to Buy audit + Price Alignment).
// Plain JavaScript, regex / JSON parsing only: runs unchanged in Node and Deno.
import { meta, money, uniq, jsonLdProducts, jsonLdOffer } from './common.js';

// ── Lowe's USA ── lowes.com/pd/<slug>/<product id>
// The server writes the whole page state as window['__PRELOADED_STATE__'] = {…}. The MAIN product is
// productDetails[productId]:
//   product.modelId      "Model #" as Lowe's shows it. The sink listings with product ids 5015750xxx
//                        (Item #66008xx) carry a trailing "1" in Lowe's own record: S-310G1, S-501XG1,
//                        S-611W1 are S-310G, S-501XG, S-611W (Lowe's was-price = the PIM's MAP USD)
//   product.itemNumber   "Item #" (Lowe's own id; the URL ends with the other one, omniItemId)
//   product.barcode      the UPC (page data only)
//   product.status / isArchived / isOOS   a removed listing keeps its page ("This item is no longer sold
//                                         on Lowes.com") without a price
//   mfePrice.price       the price block the page draws: additionalData.sellingPrice = now,
//                        wasPrice (displayType "WAS") = the struck-through price of a promotion
// Not read: associatedServices (protection plans with their own item #s), LACOfferPromotion /
// financePromotions (the 5% Lowe's card price), the carousels, and productVariantsV3 (the size / finish
// selector names the other options only by Lowe's product id, never by model).
// A dead product answers "404 File Not Found - Lowe's" with no state → null.
function lowesState(html) {
  for (const m of html.matchAll(/__PRELOADED_STATE__['"]?\]?\s*=\s*/g)) {
    const start = m.index + m[0].length;
    const end = html.indexOf('</script>', start);
    try {
      const state = JSON.parse(html.slice(start, end).trim().replace(/;$/, ''));
      if (state?.productDetails) return state;
    } catch { /* not this one */ }
  }
  return null;
}

function readLowes(page, url) {
  const html = String(page ?? '');
  const state = lowesState(html);
  const details = state?.productDetails ?? {};
  const urlId = String(url ?? '').match(/\/(\d{6,})(?:[?#]|$)/)?.[1];
  const d = details[state?.productId] ?? details[urlId] ?? Object.values(details)[0];
  const p = d?.product;
  if (!p?.modelId && !p?.itemNumber) return null;

  // A removed / archived listing: the page shows the product but sells nothing and draws no price.
  const gone = p.status === 'REMOVED' || p.isArchived === true;

  // Price block: what the page draws, then the pricing row behind it.
  const ui = d.mfePrice?.price;
  const add = ui?.additionalData ?? {};
  const rows = ui?.pricingDataList ?? d.location?.price?.pricingDataList ?? [];
  const row = rows.find((r) => r?.usageType === 'SELLING') ?? rows[0] ?? {};
  let price = money(add.sellingPrice ?? row.finalPrice);
  let wasPrice = money(add.wasPrice ?? (row.displayType === 'WAS' ? row.basePrice : null));
  if (wasPrice !== null && price !== null && wasPrice <= price) wasPrice = null;

  // JSON-LD Product (when present) repeats the price and gives the currency.
  const ld = jsonLdOffer(jsonLdProducts(html).find((x) => String(x?.sku ?? '') === String(p.omniItemId ?? '')));
  if (price === null && !gone) price = ld?.price ?? null;
  if (gone) { price = null; wasPrice = null; }

  return {
    ids: uniq([p.modelId, p.sellableModelNumber, p.barcode]),
    options: [],
    price,
    wasPrice,
    currency: ld?.currency ?? 'USD', // lowes.com sells in USD only
    inStock: gone ? false : typeof p.isOOS === 'boolean' ? !p.isOOS : (ld?.inStock ?? null),
    itemId: p.itemNumber ? String(p.itemNumber) : null,
    source: 'preloaded-state',
    // The audit calls such a link Broken: the page is there, but Lowe's no longer sells the product.
    ...(gone ? { gone: true, note: 'Lowe\'s no longer sells it ("This item is no longer sold on Lowes.com")' } : {}),
  };
}

// ── Rona ── rona.ca/en/product/<slug>-<article #> (French: rona.ca/fr/produit/…)
// <script type="application/json" id="js-product-ddo"> is the MAIN product's own record:
//   partNumber              the Rona article # ("Article #332101795"; also the end of the URL)
//   manufacturerPartNumber  "Model #" (our SKU)
//   effectivePrice          what a shopper pays now; regularPrice = the struck-through price of a promotion
//                           ("Save $37 until Oct 21st, 2026"; rebateAmout = the difference)
// The microdata of the same product (itemprop mpn / sku / price / priceCurrency) repeats it, the main price
// snippet (<!-- BEGIN RonaProdDetailPriceSnippet.jsp -->) draws it, and the data layer gives the online
// stock: ddo_productOnlineAvail_obj_<id>["availabilityStatus"] = 'yes' | 'no' (hidden input
// inventoryi-parcel = the units). The sentence "This item is not currently available for immediate
// purchase…" is a hidden infobox on EVERY page, not a status.
// The carousels ("customers also viewed", "similar products") draw their own article #s and price-box
// prices outside that record — never read. The wishlist's "unitPrice" is the REGULAR price: not read.
// A dead product answers HTTP 404 "RONA - Erreur générique" / "Oupelay! Erreur 404" without a record → null.
function readRona(page) {
  const html = String(page ?? '');
  const m = html.match(/<script[^>]*id=["']js-product-ddo["'][^>]*>([\s\S]*?)<\/script>/i);
  let ddo = null;
  try { ddo = m ? JSON.parse(m[1]) : null; } catch { /* broken record: fall back on the microdata */ }
  const model = ddo?.manufacturerPartNumber ?? meta(html, 'mpn') ?? html.match(/\["manufacturerNumber"\]\s*=\s*"([^"]*)"/)?.[1];
  const article = ddo?.partNumber ?? meta(html, 'sku') ?? html.match(/\["articleNumber"\]\s*=\s*"([^"]*)"/)?.[1];
  if (!model && !article) return null;

  const snippet = html.match(/BEGIN RonaProdDetailPriceSnippet\.jsp([\s\S]*?)END RonaProdDetailPriceSnippet\.jsp/)?.[1] ?? '';
  const price = money(ddo?.effectivePrice ?? meta(html, 'price'));
  const regular = money(ddo?.regularPrice ?? snippet.match(/price-box__regularPrice[^>]*>\s*([^<]+)</)?.[1]);
  const online = html.match(/ddo_productOnlineAvail_obj_\d+\["availabilityStatus"\]\s*=\s*'([^']*)'/)?.[1];
  const units = html.match(/<input id="inventoryi-parcel" type="hidden" value="(\d+)"/)?.[1];

  return {
    ids: uniq([model]),
    options: [],
    price,
    wasPrice: regular !== null && price !== null && regular > price ? regular : null,
    currency: (meta(html, 'priceCurrency') ?? 'CAD').toUpperCase(), // rona.ca sells in CAD only
    inStock: online === 'yes' ? true : online === 'no' ? false : units !== undefined ? Number(units) > 0 : null,
    itemId: article ? String(article) : null,
    source: ddo ? 'product-ddo' : 'microdata',
  };
}

export const readers = {
  lowes_us: readLowes,
  rona: readRona,
};
