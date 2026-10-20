// Wayfair (wayfair.com / wayfair.ca) product page reader.
// A Wayfair page is a Next.js app-router page: its data is the React "flight" (RSC) payload pushed by
// self.__next_f.push([1,"…"]). That payload carries the GraphQL objects of the page — MarketplaceListingVariant
// { variantId, partNumber, pricing.allPrices, fulfillment(v2).stockStatus, choiceCategories } — for the MAIN product
// and also for carousels, protection plans and brand grids, so everything is scoped to the page's own variant
// (pdpContext.variantId). A listing (TKJS1134) covers several options; the URL selects one with ?piid=… and the page
// renders that option, or the listing's DEFAULT option when the URL has no piid or one that is not an option of the
// listing (parsedParams.isOptionIdMismatched). The page's language (en-CA / fr-CA) does not matter: no label is read.
import { decode, money, uniq, currencyOfMarket, absUrl } from './common.js';

// The flight payload: the JSON strings of every self.__next_f.push([1,"…"]) joined.
function flightOf(html) {
  let s = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) { try { s += JSON.parse(m[1]); } catch { /* broken chunk */ } }
  return s;
}

// The flight's JSON rows, parsed: "<id>:<JSON>\n". A text row "<id>:T<hex UTF-8 bytes>,<text>" is skipped by its length.
function rowsOf(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const m = /^([0-9a-f]+):(T([0-9a-f]+),)?/.exec(s.slice(i, i + 24));
    if (!m) { const nl = s.indexOf('\n', i); if (nl < 0) break; i = nl + 1; continue; }
    i += m[0].length;
    if (m[2]) {
      for (let bytes = parseInt(m[3], 16); bytes > 0 && i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c < 0xdc00) { bytes -= 4; i++; } else bytes -= c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
      }
      continue;
    }
    const nl = s.indexOf('\n', i);
    const body = s.slice(i, nl < 0 ? s.length : nl);
    i = nl < 0 ? s.length : nl + 1;
    if (/^[[{]/.test(body)) { try { out.push(JSON.parse(body)); } catch { /* not JSON */ } }
  }
  return out;
}

// Option ids of a URL: ?piid=94128987%2C94128991 → "94128987,94128991" (sorted: the order does not matter).
const piidsOf = (url) => (String(url ?? '').match(/[?&]piid=([^&#]*)/i)?.[1] ?? '').replace(/%2C/gi, ',').split(/[^\d]+/).filter(Boolean).sort().join(',');
const STOCK = { IN_STOCK: true, LOW_STOCK: true, LIMITED_STOCK: true, OUT_OF_STOCK: false, DISCONTINUED: false, NOT_AVAILABLE: false, UNAVAILABLE: false };
const stockOf = (s) => (s in STOCK ? STOCK[s] : null);
// allPrices: SALE / CLEARANCE / PRIMARY = what is paid now, PREVIOUS = the struck-through price. Others
// ("CONTRAST" = "Potential Loyalty Savings" $2.00…) are never a price.
const PAID = ['SALE', 'CLEARANCE', 'PRIMARY'];

function readWayfair(html, url) {
  html = String(html ?? '');
  if (/NEXT_HTTP_ERROR_FALLBACK;404|<title>\s*(Access to this page has been denied|Page Not Found)/i.test(html)) return null;
  const flight = flightOf(html);
  // 1. Every object of the flight: the page context (pdpContext) and the listing variants.
  let ctx = null;
  const variants = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 100) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    if (!ctx && o.parsedParams && o.displayListingId) ctx = o;
    if (o.__typename === 'MarketplaceListingVariant') variants.push(o);
    for (const k in o) walk(o[k], depth + 1);
  };
  for (const row of rowsOf(flight)) walk(row, 0);
  // Not a product page (brand / search / home page, bot page): no page context and no product page type.
  if (!ctx && !/"pageType":"Product/.test(flight)) return null;
  const listing = String(ctx?.displayListingId ?? String(url ?? '').match(/-([a-z]{3,5}\d{3,5}|[a-z]\d{9})\.html/i)?.[1] ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!listing) return null;
  const variantId = typeof ctx?.variantId === 'string' && !ctx.variantId.startsWith('$') ? ctx.variantId : null; // "$undefined" = none
  const selected = ctx ? (ctx.parsedParams?.selectionIds ?? []).map(String).sort().join(',') : piidsOf(url);
  // 2. The main product's objects: its own variantId; without one, its listing URL with the selected option ids.
  const onListing = (u) => new RegExp(`-${listing}\\.html`, 'i').test(String(u ?? ''));
  const main = variants.filter((v) => (v.variantId ? v.variantId === variantId
    : v.listingUrl ? onListing(v.listingUrl) && piidsOf(v.listingUrl) === selected
      : String(v.listing?.displayListingId ?? '').toUpperCase() === listing));
  if (!main.length) return null;
  // 3. Identifiers: Wayfair's "Part #" = the manufacturer part number of the selected option.
  const ids = uniq(main.map((v) => v.partNumber));
  // 4. Price of the selected option, from the flight; else from the visible price block (PricingFull).
  const pricings = main.map((v) => v.pricing).filter((p) => p && typeof p === 'object');
  const all = pricings.flatMap((p) => (Array.isArray(p.allPrices) ? p.allPrices : [])).filter((p) => p?.price?.value?.amount != null);
  const now = PAID.map((k) => all.find((p) => p.priceVariation === k)).find(Boolean)?.price.value
    ?? pricings.find((p) => p.primaryPrice?.price?.value?.amount != null)?.primaryPrice.price.value;
  let price = money(now?.amount);
  let wasPrice = money(all.find((p) => p.priceVariation === 'PREVIOUS')?.price.value.amount);
  let currency = now?.currency?.code ?? null;
  const fromBlock = price === null;
  if (fromBlock) {
    const shown = (k) => html.match(new RegExp(`data-test-id="PricingFull-${k}"[\\s\\S]{0,800}?data-test-id="PriceDisplay"[^>]*>([^<]+)`))?.[1];
    price = money(decode(shown('leadPrice') ?? ''));
    wasPrice = money(decode(shown('strikethroughPrice') ?? ''));
  }
  if (price === null || (wasPrice !== null && wasPrice <= price)) wasPrice = null;
  if (price !== null && !currency) currency = currencyOfMarket(/wayfair\.ca/i.test(String(url ?? '')) ? 'ca' : 'us');
  // 5. Stock of the selected option.
  const inStock = stockOf(main.map((v) => v.fulfillmentv2?.stockStatus ?? v.fulfillment?.stockStatus).find(Boolean));
  // 6. The listing's options (Finish, Size…): Wayfair names them and gives their piid and the address that
  //    selects them (the variant a click on the choice opens), never their part number.
  const choices = [];
  for (const cat of main.flatMap((v) => (Array.isArray(v.choiceCategories) ? v.choiceCategories : []))) {
    for (const e of cat?.variantChoices?.edges ?? []) {
      const c = e?.node?.choice;
      if (!c?.displayId || choices.some((x) => x.piid === String(c.displayId))) continue;
      choices.push({
        piid: String(c.displayId), name: `${cat.name ? `${cat.name}: ` : ''}${c.name}`, selected: selected.split(',').includes(String(c.displayId)),
        inStock: stockOf(e.node.selectableVariant?.fulfillmentv2?.stockStatus), url: absUrl(e.node.selectableVariant?.listingUrl, url),
      });
    }
  }
  return {
    ids, options: [], price, wasPrice, currency: currency ? currency.toUpperCase() : null, inStock, itemId: listing,
    piids: selected ? selected.split(',') : [], optionDefaulted: ctx?.parsedParams?.isOptionIdMismatched === true, choices,
    optionLinks: choices.filter((c) => !c.selected && c.url).map((c) => ({ name: c.name, itemId: c.piid, url: c.url })),
    source: fromBlock && price !== null ? 'rsc-flight+pricing-block' : 'rsc-flight',
  };
}

export const readers = { wayfair_us: readWayfair, wayfair_ca: readWayfair };
