// Best Buy Canada product pages: bestbuy.ca/en-ca/product/<slug>/<id>, /en-ca/product/<id>, /fr-ca/produit/…, /p/<id>.
// Where a page keeps its MAIN product (Bright Data and ScraperAPI renders, 2026-10-19/20):
//   1. window.__INITIAL_STATE__.product.product (every render): modelNumber, sku (= Best Buy's "Web Code"),
//      priceWithoutEhf (the price shown), regularPrice, isOnSale / saving, productVariants (the colour options —
//      each one its own Best Buy item, its name ending with the model). Its sibling .availability holds
//      shipping / pickup. ScraperAPI renders have no JSON-LD and only a skeleton where the price goes.
//   2. <script id="product-json-ld"> Product: model, sku (the Web Code again), offers.price / priceCurrency.
//   3. Visible: data-automation="MODEL_NUMBER_ID" ("Model: S-831WH" / "Modèle : …"), "SKU_ID" ("Web Code: …"),
//      and, in the offer section, "product-price" (screen-reader text "$637") and "product-saving" ("SAVE $31").
// Never read: whatsIncluded and the specs (they name the included accessories: "Basket Strainers (ST-01)"),
// recommendations / sponsored boxes, the other sellers' offers (loaded in the browser).
import { decode, textOf, normSku, money, jsonLdOffer, uniq } from './common.js';

// The object literal assigned to window.<name> in an inline script (braces counted outside strings).
function windowJson(html, name) {
  const m = new RegExp(`window\\.${name}\\s*=\\s*\\{`).exec(html);
  if (!m) return null;
  const from = m.index + m[0].length - 1;
  let depth = 0, inString = false;
  for (let i = from; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (inString) { if (c === 92) i++; else if (c === 34) inString = false; }
    else if (c === 34) inString = true;
    else if (c === 123) depth++;
    else if (c === 125 && --depth === 0) {
      try { return JSON.parse(html.slice(from, i + 1)); } catch { return null; }
    }
  }
  return null;
}

// The main product's JSON-LD (Best Buy gives it its own id; the breadcrumb is another block).
function productJsonLd(html) {
  const m = html.match(/<script[^>]*id=["']product-json-ld["'][^>]*>([\s\S]*?)<\/script>/i);
  try { const j = m ? JSON.parse(m[1]) : null; return /Product/.test(String(j?.['@type'])) ? j : null; } catch { return null; }
}

// A model number that ENDS a product name: "… kitchen Sink S-831WN", "… Finish K-149NG", "… Pot Filler k-145S".
const modelAtEnd = (name) => decode(name ?? '').trim().match(/[\s(]([A-Za-z]{1,3}-?\d{2,4}[A-Za-z0-9]*(?:-\d{1,2})?)\)?$/)?.[1] ?? null;

// Visible summary line "Model: K-133N" / "Web Code: 15650474" (French "Modèle : …" / "Code Web : …").
function summaryValue(html, key) {
  const m = html.match(new RegExp(`data-automation="${key}"[^>]*>([\\s\\S]*?)</div>`));
  return m ? textOf(m[1]).replace(/^[^:]*:\s*/, '').trim() || null : null;
}

// Stock from the state's availability: buyable for shipping or pickup = in stock; a sold-out shipping status = not.
// (A region restriction or a status still loading says nothing.)
function stockOf(av, sku) {
  if (!av || (av.sku && sku && String(av.sku) !== String(sku))) return null;
  if (av.shipping?.purchasable === true || av.pickup?.purchasable === true) return true;
  return /SoldOut|OutOfStock|NotAvailable|Unavailable|Discontinued/i.test(String(av.shipping?.status ?? '')) ? false : null;
}

function readBestBuy(html, url) {
  html = String(html ?? '');
  const state = windowJson(html, '__INITIAL_STATE__');
  const product = state?.product?.product?.sku ? state.product.product : null; // 404 / search / home pages have none
  const ld = productJsonLd(html);
  const offer = ld ? jsonLdOffer(ld) : null;
  const shownModel = summaryValue(html, 'MODEL_NUMBER_ID');
  if (!product && !ld && !shownModel) return null; // not found, Akamai "Access Denied", rate-limit bodies

  // The offer section's own price (the sticky bar and the mobile block repeat it further down).
  const at = html.indexOf('data-automation="layout-product-offer-details"');
  const end = at >= 0 ? html.indexOf('</section>', at) : -1;
  const offerHtml = at >= 0 ? html.slice(at, end > at ? end : at + 8000) : '';
  const shownPrice = money(offerHtml.match(/data-automation="product-price"[^>]*>\s*<span[^>]*>([^<]+)</)?.[1]);
  const shownSaving = money(offerHtml.match(/data-automation="product-saving"[^>]*>([^<]+)</)?.[1]);

  // Price now = the shown price (EHF, an eco fee, is added at checkout and is 0 for sinks and faucets).
  const selected = (product?.productVariants ?? []).flat().find((v) => v && String(v.sku) === String(product.sku));
  const price = money(product?.priceWithoutEhf) ?? money(product?.priceWithEhf) ?? money(selected?.salePrice) ?? offer?.price ?? shownPrice;
  // Was = the regular price while the page shows a saving ("SAVE $31"); none when not on sale.
  const saving = product ? money(product.saving) : shownSaving;
  const regular = money(product?.regularPrice ?? selected?.regularPrice);
  const onSale = product ? product.isOnSale === true || saving !== null : shownSaving !== null;
  const wasPrice = onSale && price !== null
    ? (regular !== null && regular > price ? regular : saving !== null ? Math.round((price + saving) * 100) / 100 : null)
    : null;

  // Identifiers: the model as the state and the JSON-LD write it (the Web Code is itemId, not an id); then the
  // visible "Model:" line; last, a model ending the product name. A value without a digit ("N/A") is no model.
  const models = (list) => uniq(list.map((x) => (x ? decode(String(x)) : ''))).filter((x) => /\d/.test(x));
  let ids = models([product?.modelNumber, ld?.model, ld?.mpn]);
  if (!ids.length) ids = models([shownModel]);
  if (!ids.length) ids = models([modelAtEnd(product?.name ?? ld?.name)]);
  // Options: the listing's other colour items, by the model that ends their name. Each is a Best Buy item
  // of its own, opened by its Web Code.
  const others = (product?.productVariants ?? []).flat().filter((v) => v?.sku && String(v.sku) !== String(product.sku));
  const options = models(others.map((v) => modelAtEnd(v.name)))
    .filter((m) => !ids.some((id) => normSku(id) === normSku(m)));
  const optionLinks = others.map((v) => ({ model: modelAtEnd(v.name), name: v.name ? decode(String(v.name)) : null, itemId: String(v.sku), url: `https://www.bestbuy.ca/en-ca/product/${v.sku}` }));

  const ldAvailability = String([].concat(ld?.offers ?? [])[0]?.availability ?? ''); // "OnlineOnly" says nothing on stock
  const inStock = stockOf(state?.product?.availability, product?.sku)
    ?? (/OutOfStock|SoldOut|Discontinued/i.test(ldAvailability) ? false : /InStock|LimitedAvailability/i.test(ldAvailability) ? true : null);

  return {
    ids,
    options,
    optionLinks,
    price,
    wasPrice,
    currency: offer?.currency ?? 'CAD', // Best Buy Canada sells in CAD only
    inStock,
    itemId: String(product?.sku ?? ld?.sku ?? summaryValue(html, 'SKU_ID') ?? String(url ?? '').match(/\/(\d{6,9})(?:[/?#]|$)/)?.[1] ?? '') || null,
    source: product ? 'state' : ld ? 'jsonld' : 'html',
  };
}

export const readers = { bestbuy_ca: readBestBuy };
