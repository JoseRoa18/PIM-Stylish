// Readers for the Beyond, Inc. stores: Bed Bath & Beyond USA and Overstock USA (one catalog: product and option ids
// are shared). Two page builds carry the same product record:
//   - bedbathandbeyond.com: Next.js pages router, <script id="__NEXT_DATA__"> props.pageProps
//       product {id, manufacturerPartNumber, basePrice, priceSet, inStock, options[{optionId, subSku, price,
//       comparePrice, isInStock}]}, optionMap {optionId: {modelNumber}}, initialOptionId (the option the URL selects)
//   - overstock.com: Next.js app router, the flight data in self.__next_f.push([1,"…"]) holds
//       {"product": {productId, specifications{"Model Number"}, variations[{variationId, fullSku, prices, status}],
//       lowestVariationPrice}} and initialPDPState.selectedVariation (the option the URL selects, null when none).
// A listing has options (finishes) and the page writes ONE "Model Number" for all of them: the BASE option's (sub-SKU
// 000-000, the first one created). So the reading follows the option the page shows — the URL's, else the base:
//   - another option is selected → its model is not on the page (ids = []), the listing's number goes to options
//     (BB&B's optionMap, when present, names each option's own model);
//   - no option selected → the base option's price, not the listing's lowest ("From") price, which can be another
//     finish on sale; when the base option is not offered any more → price null, inStock false.
// Sold-out listings drop their options: Overstock then has no price at all, BB&B keeps the last one (JSON-LD too).
import { decode, money, jsonLd, jsonLdOffer, scriptJson, uniq } from './common.js';

const urlProductId = (url) => String(url ?? '').match(/\/(\d{6,9})\/product\.html|\/products\/[^?#]*-(\d{6,9})(?:[?#/]|$)/)?.slice(1).find(Boolean) ?? null;
const urlOption = (url) => String(url ?? '').match(/[?&]option=(\d+)/)?.[1] ?? null;
const isBase = (subSku) => /(^|-)000-000$/.test(String(subSku ?? ''));

// The JSON object / array that starts at text[i], parsed (strings and escapes respected), or null.
function jsonAt(text, i) {
  if (i < 0) return null;
  let depth = 0, str = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (str) { if (c === '\\') j++; else if (c === '"') str = false; }
    else if (c === '"') str = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) { try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; } }
  }
  return null;
}

// Shared ending. listing: { models, price, was, inStock }; opts: [{ id, model, base, name, price, was, inStock }];
// sel: the option the URL selected (one of opts) or null.
function reading({ itemId, listing, opts, sel, currency, source }) {
  const shown = sel ?? opts.find((o) => o.base) ?? null;
  const ids = shown ? (shown.model ? [shown.model] : shown.base ? listing.models : []) : listing.models;
  const at = shown ?? (opts.length ? { price: null, was: null, inStock: false } : listing); // base option gone → not offered
  const options = uniq([...listing.models, ...opts.filter((o) => o !== shown).map((o) => o.model)]).filter((m) => !ids.includes(m));
  const how = shown ? ` · option ${shown.id}${shown.name ? ` "${shown.name}"` : ''}${sel ? '' : ' (listing default)'}`
    : opts.length ? ` · listing option not offered (on offer: ${opts.map((o) => `"${o.name || o.id}" ${o.price ?? '?'}`).join(', ')})` : '';
  return {
    ids: uniq(ids), options,
    price: at.price ?? null, wasPrice: at.was && at.price && at.was > at.price ? at.was : null,
    currency: currency ? String(currency).toUpperCase() : null,
    inStock: typeof at.inStock === 'boolean' ? at.inStock : null,
    itemId: itemId ? String(itemId) : null,
    source: source + how,
  };
}

// Bed Bath & Beyond: __NEXT_DATA__.
function fromNextData(html, url) {
  const pp = scriptJson(html, '__NEXT_DATA__')?.props?.pageProps;
  const p = pp?.product;
  if (!p?.id) return null;
  const opts = [].concat(p.options ?? []).map((o) => ({
    id: String(o.optionId), model: pp.optionMap?.[o.optionId]?.modelNumber ?? null, base: isBase(o.subSku),
    name: o.decription ?? o.description ?? '', // BB&B spells it "decription"
    price: money(o.price), was: money(o.comparePrice), inStock: o.isInStock ?? (o.qtyOnHand > 0),
  }));
  const want = String(pp.initialOptionId ?? urlOption(url) ?? '');
  const set = Object.fromEntries([].concat(p.priceSet ?? []).map((x) => [x.priceType, money(x.formattedPrice)]));
  const spec = (p.specificationAttributes?.attributeGroups ?? []).flatMap((g) => g.attributes ?? []).find((a) => /^model number$/i.test(a.label))?.values ?? [];
  return reading({
    itemId: p.id, opts, sel: opts.find((o) => o.id === want) ?? null, currency: pp.meta?.currencyCode,
    listing: { models: uniq([p.manufacturerPartNumber, ...spec].map(decode)), price: set.CURRENT_PRICE ?? money(p.basePrice), was: set.COMPARISON_PRICE, inStock: p.inStock },
    source: p.hideMAPProductPrice || [].concat(p.options ?? []).some((o) => o.hideMAPProductPrice) ? 'next-data · price in cart only' : 'next-data',
  });
}

// Overstock: the app-router flight data.
function fromFlight(html, url) {
  let flight = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) { try { flight += JSON.parse(m[1]); } catch { /* skip */ } }
  if (!flight) return null;
  const id = urlProductId(url);
  let p = null; // the main product record — the carousels' products have other shapes and ids
  for (const m of flight.matchAll(/\{"product":\{/g)) {
    const o = jsonAt(flight, m.index)?.product;
    if (o?.productId && (o.specifications || o.variations)) { p ??= o; if (String(o.productId) === id) { p = o; break; } }
  }
  if (!p || p.ok === false) return null;
  const at = flight.search(/"initialPDPState":\{/);
  const sv = at >= 0 ? jsonAt(flight, flight.indexOf('{', at))?.selectedVariation ?? null : null;
  const prices = (pr) => { // { basePrice, salePrice?, referencePrice? (MSRP, shown struck through) }, each { amount, currency }
    const amt = (c) => money(c?.amount);
    const ref = pr?.referencePrice?.metaData?.referenceInfo?.applied === false ? null : amt(pr?.referencePrice);
    return { price: amt(pr?.salePrice) ?? amt(pr?.basePrice), was: ref ?? (pr?.salePrice ? amt(pr?.basePrice) : null), currency: pr?.basePrice?.currency ?? null };
  };
  const toOpt = (v) => ({ // status SELLABLE / OUT_OF_STOCK
    id: String(v.variationId), model: null, base: isBase(v.fullSku), name: v.description ?? '', ...prices(v.prices),
    inStock: v.status ? v.status === 'SELLABLE' : typeof v.quantityAvailable === 'number' ? v.quantityAvailable > 0 : null,
  });
  // a variation can be a reference to the selected one: "$3c:4:props:initialPDPState:selectedVariation"
  const opts = [].concat(p.variations ?? []).map((v) => (typeof v === 'string' ? (/selectedVariation$/.test(v) ? sv : null) : v)).filter(Boolean).map(toOpt);
  const want = String(sv?.variationId ?? urlOption(url) ?? '');
  const low = prices(p.lowestVariationPrice);
  return reading({
    itemId: p.productId, opts, sel: opts.find((o) => o.id === want) ?? null, currency: opts[0]?.currency ?? low.currency,
    listing: { models: uniq([].concat(p.specifications?.['Model Number'] ?? []).map(decode)), price: low.price, was: low.was, inStock: p.inStock },
    source: 'rsc',
  });
}

// Fallback when neither record is there: JSON-LD (BB&B: listing mpn + offer; Overstock: the selected option's offer
// and full SKU), the Tealium utag_data of a product page (full_sku), the visible buy box and "Model Number" row.
// Same base-option rule; with no option SKU on the page the buy-box price may be another finish's → only offers count.
function fromMarkup(html, url) {
  const ld = jsonLd(html).flat().find((x) => x?.['@type'] === 'Product'); // top level only, never an ItemList
  const offer = ld?.offers ? jsonLdOffer(ld) : null;
  const ut = html.search(/utag_data\s*=\s*\{/);
  const utag0 = ut >= 0 ? jsonAt(html, html.indexOf('{', ut)) : null;
  const utag = /product detail/i.test(utag0?.page_type ?? '') ? utag0 : null;
  const id = urlProductId(url) ?? utag?.product_id?.[0] ?? null;
  const optSku = [ld?.sku, utag?.full_sku].find((s) => /-\d{3}-\d{3}$/.test(s ?? '')) ?? null; // "38831304-000-001"
  const box = id ? html.match(new RegExp(`data-testid="product-pricing-${id}"[\\s\\S]{0,400}?data-testid="product-price-amount"[^>]*>([^<]+)<`)) : null;
  const today = html.match(/data-testid="current-price"[\s\S]{0,600}?data-price="domestic">([^<]+)</); // BB&B "Today $97.00"
  const price = offer?.price ?? (optSku ? money(box?.[1] ?? today?.[1] ?? utag?.product_price?.[0]) : null);
  const models = uniq([ld?.mpn, html.match(/>Model Number<\/(?:td|div)>\s*<(?:td|div)[^>]*>([^<]+)</)?.[1]].map(decode));
  if (!models.length && price === null) return null;
  const other = optSku && !isBase(optSku); // the listing's number is the base option's
  return {
    ids: other ? [] : models, options: other ? models : [], price, wasPrice: null,
    currency: offer?.currency ?? utag?.order_currency ?? null,
    inStock: offer?.inStock ?? (utag?.product_in_stock ? utag.product_in_stock === '1' : null),
    itemId: id, source: `${offer ? 'jsonld' : utag && !box && !today ? 'utag' : 'html'}${optSku ? ` · option ${optSku}` : ''}`,
  };
}

function readBeyond(html, url) {
  html = String(html ?? '');
  if (!/bedbathandbeyond|overstock|ostkcdn/i.test(html) || /<title>\s*Access Denied/i.test(html)) return null; // Akamai block page
  return fromNextData(html, url) ?? fromFlight(html, url) ?? fromMarkup(html, url);
}

export const readers = { bbb_us: readBeyond, overstock_us: readBeyond };
