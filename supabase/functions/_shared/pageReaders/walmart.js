// Walmart Canada (walmart.ca/en/ip/<slug>/<id>) and Walmart USA (walmart.com/ip/<slug>/<id>).
// Both are the same Next.js site. What a product page carries (checked 2026-10-20):
//   __NEXT_DATA__ props.pageProps.initialData.data.product — the item shown and its buy-box offer:
//     model / manufacturerProductId / upc, usItemId (the store's item id), priceInfo.currentPrice
//     (+ currencyUnit), priceInfo.wasPrice (struck through), availabilityStatus, the seller, and the
//     listing's options (variantCriteria, variantsMap). Carousels live elsewhere (contentLayout).
//   walmart.ca only: a JSON-LD ProductGroup whose variant WITH offers is the item shown (its "sku" is
//     Walmart's item id, not ours); the other variants are bare { url }. walmart.com has no Product JSON-LD.
//   Both: the buy box writes the price as <span itemprop="price" data-seo-id="hero-price">.
// Only data fields are read, so a page rendered in Spanish (walmart.com) or French reads the same.
// Not the price: "$38.00 when you subscribe" (product.discounts, walmart.ca's subscribe & save).
import { pageTitle, normSku, money, jsonLdProducts, jsonLdOffer, scriptJson, uniq, currencyOfMarket, absUrl } from './common.js';

// Bot checks Walmart answers with status 200 ("Robot or human?" on .com, "Verify Your Identity" on .ca).
const BOT_TITLE = /robot or human|verify your identity|access denied|captcha|are you a human/i;

// Walmart's item id at the end of a product address: /ip/<slug>/<id> or /ip/<id>.
const itemIdOf = (url) => String(url ?? '').split(/[?#]/)[0].match(/\/ip\/(?:[^/]+\/)?([A-Za-z0-9]+)\/?$/)?.[1] ?? null;

// Walmart USA listings write the model with a "-1" after it (S-414T-1, S-414TG-1). No PIM SKU ends in
// "-1", so the bare model is added next to it; a "-2" (a set of two: P-201-2) is a SKU of its own and stays.
const withBase = (list) => uniq(list.flatMap((id) => (/^[A-Z]{1,3}-?\d[A-Z0-9-]*-1$/i.test(id) ? [id, id.replace(/-1$/, '')] : [id])));

// The model a listing's name ends with, read from its address ("…-with-6-Black-accs-S-625WK/1WTD9Z8FCO5C").
const modelOfAddress = (path) => String(path ?? '').split(/[?#]/)[0].split('/').slice(-2, -1)[0]
  ?.match(/-([A-Z]{1,3}-?\d{2,4}[A-Z0-9]*(?:-\d)?)$/)?.[1] ?? null;

const stockOf = (s) => (!s ? null : /^(IN_STOCK|LIMITED_STOCK|AVAILABLE)$/i.test(s) ? true : /OUT_OF_STOCK|NOT_AVAILABLE|UNAVAILABLE|RETIRED/i.test(s) ? false : null);

function readWalmart(html, url) {
  if (BOT_TITLE.test(pageTitle(html))) return null;
  const next = scriptJson(html, '__NEXT_DATA__');
  const props = next?.props?.pageProps ?? {};
  // A page served from Walmart's "skip SSR" cache can be ANOTHER item's (on 2026-10-20 walmart.com
  // answered 404 shells whose query and errors named unrelated unpublished items): only the asked item counts.
  const asked = itemIdOf(url);
  const served = [].concat(next?.query?.itemParams ?? []).at(-1) ?? null;
  if (props.servedFromSkipSSRCache && asked && served && served !== asked) return null;

  const p = props.initialData?.data?.product ?? null;
  // walmart.ca's JSON-LD variant of the item shown (its "sku" is Walmart's item id).
  const withOffer = jsonLdProducts(html).filter((x) => x.offers);
  const ld = (p ? withOffer.find((x) => x.sku === p.usItemId) : withOffer.find((x) => x.sku === asked) ?? withOffer[0]) ?? null;
  if (!p && !ld) return null; // home, search, not-found and bot pages carry no product

  // Identifiers of the item shown: model / manufacturer part # / UPC as written ("N/A" placeholders left out).
  const ids = withBase(uniq([p?.model, p?.manufacturerProductId, ld?.model, ld?.mpn, p?.upc ?? ld?.gtin13 ?? ld?.gtin12 ?? ld?.gtin14])
    .filter((id) => !/^(n\/?a|none|not applicable|does not apply|-+)$/i.test(id)));

  // The listing's other options: a "Model" option list (walmart.com) names them; every option's address
  // ends with its listing name, which on these listings ends with the model (walmart.ca: "…-K-140R").
  const self = new Set([p?.usItemId, p?.id, asked].filter(Boolean));
  const named = (p?.variantCriteria ?? []).filter((c) => /^model$/i.test(String(c.id ?? c.name ?? '')))
    .flatMap((c) => c.variantList ?? []).filter((v) => !v.selected && !(v.products ?? []).some((id) => self.has(id))).map((v) => v.name);
  const otherItems = Object.values(p?.variantsMap ?? {}).filter((v) => v?.usItemId && !self.has(v.usItemId) && !self.has(v.id));
  const addressed = otherItems.map((v) => modelOfAddress(v.productUrl));
  const own = new Set(ids.map(normSku));
  const options = withBase(uniq([...named, ...addressed])).filter((o) => !own.has(normSku(o)));
  // Each option is a Walmart item of its own: its address, the model its name ends with (the "-1" of
  // walmart.com dropped) and the option values that pick it ("Actual Color: Silver & Red").
  const choiceNames = new Map();
  for (const c of p?.variantCriteria ?? []) {
    for (const v of c.variantList ?? []) for (const id of v.products ?? []) choiceNames.set(id, [...(choiceNames.get(id) ?? []), `${c.name ?? c.id}: ${v.name}`]);
  }
  const optionLinks = [...new Map(otherItems.map((v) => [v.usItemId, v])).values()].map((v) => ({
    model: modelOfAddress(v.productUrl)?.replace(/^([A-Z]{1,3}-?\d[A-Z0-9-]*)-1$/i, '$1') ?? null,
    name: (choiceNames.get(v.usItemId) ?? []).join(' · ') || null, itemId: String(v.usItemId), url: absUrl(v.productUrl, url),
  })).filter((o) => o.url);

  // Price: the buy-box offer's current price (a third-party seller's offer when it holds the buy box).
  // A listing that shows a range has no option chosen: no price then.
  const pi = p?.priceInfo ?? {};
  const offer = ld ? jsonLdOffer(ld) : null;
  const hero = money(html.match(/data-seo-id="hero-price"[^>]*>([^<]*)</)?.[1]);
  const range = !pi.currentPrice && pi.priceRange?.minPrice != null;
  const price = range ? null : money(pi.currentPrice?.price) ?? offer?.price ?? (p?.priceInfo ? null : hero);
  const was = money(pi.wasPrice?.price) ?? money(html.match(/data-seo-id="strike-through-price"[^>]*>([^<]*)</)?.[1]);
  const heroCurrency = html.match(/itemprop="priceCurrency"[^>]*>\s*([A-Z]{3})\s*</)?.[1] ?? null;
  const currency = price === null ? null
    : String(pi.currentPrice?.currencyUnit ?? offer?.currency ?? heroCurrency ?? currencyOfMarket(/walmart\.ca/i.test(url) ? 'ca' : 'us')).toUpperCase();

  return {
    ids,
    options,
    optionLinks,
    price,
    wasPrice: price !== null && was !== null && was > price ? was : null,
    currency,
    inStock: stockOf(p?.availabilityStatus ?? p?.availabilityStatusV2?.value) ?? offer?.inStock ?? null,
    itemId: p?.usItemId ?? ld?.sku ?? asked,
    // A price under MAP that Walmart shows only in the cart / at checkout ("See price in cart") is still
    // the price paid; the source says so (priceDisplayCodes.submapType, not met on 2026-10-20).
    source: !p ? 'jsonld' : pi.priceDisplayCodes?.submapType ? `next-data (price in ${String(pi.priceDisplayCodes.submapType).toLowerCase()})` : 'next-data',
  };
}

export const readers = { walmart_ca: readWalmart, walmart_us: readWalmart };
