// Readers for Home Depot USA (homedepot.com/p/<slug>/<internet #>) and Home Depot Canada
// (homedepot.ca/product/<slug>/<item #>). Two platforms: each returns the PageRead of common.js for the
// page's MAIN product, or null when the page carries no product (not-found page, bot page, empty body).
// Checked on Bright Data (rendered) and ScraperAPI (server HTML) pages of 2026-10-19 / 20.
import { decode, textOf, money, jsonLdProducts, jsonLdOffer, scriptJson, uniq } from './common.js';

// ------------------------------------------------------------------ shared helpers
// The JSON object written after `marker` inside a script ("window.__APOLLO_STATE__={…};window.X=…"),
// cut at its own closing brace (the script goes on after it, so a plain regex can't take it).
function jsonAfter(html, marker) {
  const at = html.indexOf(marker);
  const start = at < 0 ? -1 : html.indexOf('{', at + marker.length);
  if (start < 0) return null;
  for (let i = start, depth = 0, inStr = false; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

// The whole <div …>…</div> whose opening tag matches `re` (nested divs counted), or ''.
function divAt(html, re) {
  const at = html.search(re);
  if (at < 0) return '';
  const tags = /<div\b|<\/div>/gi;
  tags.lastIndex = at;
  for (let m, depth = 0; (m = tags.exec(html)) && m.index - at < 30000;) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(at, m.index + 6);
  }
  return '';
}

// The store's own id at the end of the address path: "/p/…/700230016", "/product/…/1001587647?searchterm=…".
const idOfUrl = (u) => String(u ?? '').split(/[?#]/)[0].match(/\/(\d{6,12})\/?$/)?.[1] ?? null;
const canonicalOf = (html) => html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i)?.[1] ?? null;

// Price places in order of trust: the first with a price wins; `source` names the places that agree
// with it and the ones that don't ("apollo+jsonld+visible", "visible+state (≠ microdata=749)").
function choose(places) {
  const best = places.find((p) => p.price !== null);
  if (!best) return { price: null, wasPrice: null, source: places.map((p) => p.name).join('+') + ' (no price)' };
  const agree = places.filter((p) => p.price === best.price).map((p) => p.name);
  const differ = places.filter((p) => p.price !== null && p.price !== best.price).map((p) => `${p.name}=${p.price}`);
  const was = [best, ...places].map((p) => p.was).find((w) => w !== null && w > best.price) ?? null;
  return { price: best.price, wasPrice: was, source: agree.join('+') + (differ.length ? ` (≠ ${differ.join(', ')})` : '') };
}

// ------------------------------------------------------------------ Home Depot USA
// The page carries its main product three times: the Apollo state (ROOT_QUERY product:{itemId} →
// base-catalog-<itemId>: identifiers.modelNumber / itemId, pricing.value / original), the JSON-LD Product
// (thd-helmet productStructureData: model, productID, offers.price + StrikethroughPrice) and the visible
// buybox price (<div id="standard-price"> or, on sale, <div id="was-price"> with a sui-line-through "was").
// Stock is loaded in the browser (buybox placeholder), so inStock is only known when the page says
// discontinued / "not currently available". Other finishes are separate items (no options on the page).
function readHomeDepotUs(html, url) {
  html = String(html ?? '');
  const urlId = idOfUrl(url) ?? idOfUrl(canonicalOf(html));
  const state = jsonAfter(html, '__APOLLO_STATE__=');
  const root = state?.ROOT_QUERY ?? {};
  const ref = Object.entries(root).find(([k, v]) => /^product[:(]/.test(k) && v?.__ref)?.[1].__ref;
  // Only a product page (its canonical is /p/…, or the state's root query names a product): a link sent
  // to a category or search page lists other products, never "the" product.
  if (!ref && !/\/p\//.test(canonicalOf(html) ?? '')) return null;
  const base = (ref && state[ref]) || (urlId && state?.[`base-catalog-${urlId}`]) || null;
  const lds = jsonLdProducts(html);
  const ld = lds.find((p) => String(p.productID ?? '') === String(base?.itemId ?? urlId)) ?? (lds.length === 1 ? lds[0] : null);
  if (!base && !ld) return null;

  const ident = base?.identifiers ?? {};
  const pricing = base?.[Object.keys(base ?? {}).find((k) => k.startsWith('pricing'))] ?? null;
  const offer = ld ? jsonLdOffer(ld) : null;
  // Visible price: the big "$ 263 . 00", and the struck-through "$280.00" next to it while on sale.
  const block = divAt(html, /<div[^>]*\bid="(?:standard|was)-price"/);
  const big = textOf(block).match(/\$\s*([\d,]+)(?:\s*\.\s*(\d{2}))?/);
  const visible = big ? money(`${big[1]}.${big[2] ?? '00'}`) : null;
  const visibleWas = money(block.match(/sui-line-through[^>]*>(?:\s*<[^>]+>)*\s*\$?\s*([\d,]+(?:\.\d{2})?)/)?.[1]);

  const { price, wasPrice, source } = choose([
    { name: 'apollo', price: money(pricing?.value), was: money(pricing?.original) },
    { name: 'jsonld', price: offer?.price ?? null, was: offer?.wasPrice ?? null },
    { name: 'visible', price: visible, was: visibleWas },
  ]);
  const text = textOf(html);
  // "See Lower Price in Cart" (MAP policy): the page hides the number the Apollo state still carries.
  const inCart = /cart/i.test(String(pricing?.message ?? '')) || (visible === null && /Price in Cart/i.test(text));

  // Model # of the data, else the one written on the page ("Model # S-822L").
  const models = uniq([ident.modelNumber, ld?.model, ld?.mpn]);
  // A live page can carry Home Depot's not-found sentence (E-120, 2026-10-20: regional stock).
  const unavailable = base?.availabilityType?.discontinued === true || /The product you are trying to view is not currently available/i.test(text);
  return {
    ids: models.length ? models : uniq([text.match(/Model #\s*([A-Z0-9][A-Z0-9-]*)/i)?.[1]]),
    options: [],
    price,
    wasPrice,
    currency: offer?.currency ?? 'USD',
    inStock: unavailable ? false : offer?.inStock ?? null,
    itemId: String(ident.itemId ?? ld?.productID ?? urlId ?? '') || null,
    source: `hd-us ${source}${inCart ? ' (price in cart)' : ''}`,
  };
}

// ------------------------------------------------------------------ Home Depot Canada
// The page is Angular: <script id="hdca-state"> holds the catalog answer for the item as
// "product-<item #>" (modelNumber, code, price {value, currencyIso}, stock.stockLevelStatus,
// variantOptionsSorted = the other finishes by item # and finish name only — no model #, so no options).
// A hidden schema.org block (<hdca-product-schema-definition>) repeats item #, price, currency and
// availability, and a rendered page (Bright Data) shows the shopper's price in
// <div product-localized-price-component> ("$749.00 / each"; "Was"/"Save" lines when on sale). The
// "Was $179.00 / Save $50.00" of the carousels (hdca-product-box__…) are other products and never read.
function readHomeDepotCa(html, url) {
  html = String(html ?? '');
  const state = scriptJson(html, 'hdca-state');
  // The item of the address opened, else of the page's canonical address (a redirect), else the only one.
  const codes = [idOfUrl(url), idOfUrl(canonicalOf(html))].filter(Boolean);
  // (The "Product Not Found" page keeps a product-<item #> entry with every field null.)
  const entries = Object.entries(state ?? {}).filter(([k, v]) => /^product-\d+$/.test(k) && (v?.code || v?.modelNumber));
  const p = (codes.map((c) => entries.find(([k]) => k === `product-${c}`)).find(Boolean) ?? (entries.length === 1 ? entries[0] : null))?.[1] ?? null;
  const code = codes[0] ?? null;
  const schema = html.match(/<hdca-product-schema-definition[\s\S]*?<\/hdca-product-schema-definition>/i)?.[0] ?? '';
  const md = (prop) => decode(schema.match(new RegExp(`itemprop="${prop}"[^>]*>([^<]*)`))?.[1] ?? '').trim() || null;
  if (!p && !md('sku')) return null;

  // Visible price of the main product (rendered pages only); a range ("$120.00 - $150.00") is not a price.
  const hero = divAt(html, /<div[^>]*\bproduct-localized-price-component\b/);
  const heroText = textOf(hero);
  const ranged = /\$\s*[\d,.]+\s*[-–]\s*\$\s*[\d,.]+/.test(heroText);
  const heroPrice = ranged ? null : money(hero.match(/-price-value[^>]*>([^<]*)/)?.[1]);
  const heroWas = money(heroText.match(/(?:Was|Regular Price is)\s*:?\s*(\$\s*[\d,]+(?:\.\d{2})?)/i)?.[1]);

  const { price, wasPrice, source } = choose([
    { name: 'visible', price: heroPrice, was: heroWas },
    { name: 'state', price: money(p?.price?.value), was: null },
    { name: 'microdata', price: money(md('price')), was: null },
  ]);
  const visibleModel = html.match(/description-product-detail-model[^>]*>\s*Model #\s*([^<]+)</)?.[1];
  const status = String(p?.stock?.stockLevelStatus ?? '');
  const availability = schema.match(/itemprop="availability"[^>]*href="[^"]*\/(\w+)"/)?.[1] ?? '';
  const inCart = heroPrice === null && /Lower Price in Cart/i.test(heroText);
  return {
    ids: uniq([p?.modelNumber, decode(visibleModel ?? '')]),
    options: [],
    price,
    wasPrice,
    currency: (p?.price?.currencyIso ?? md('priceCurrency') ?? 'CAD').toUpperCase(),
    inStock: /outOfStock/i.test(status) ? false : /inStock|lowStock/i.test(status) ? true
      : /OutOfStock|Discontinued|SoldOut/i.test(availability) ? false : /InStock|Limited/i.test(availability) ? true : null,
    itemId: String(p?.code ?? md('sku') ?? code ?? '') || null,
    source: `hd-ca ${source}${inCart ? ' (price in cart)' : ''}`,
  };
}

export const readers = { homedepot_us: readHomeDepotUs, homedepot_ca: readHomeDepotCa };
