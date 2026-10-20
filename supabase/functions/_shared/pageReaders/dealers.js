// Page readers for the dealer stores of the Where to Buy audit: Kitchen & Bath Authority, Warehouse-USA,
// Cabinet Depot and Build with Rise (Shopify), our own Sinks Direct Canada / USA (Wix) and eBay.
// Each reader takes the page HTML and the URL that was opened and returns a PageRead (see common.js) for
// the page's MAIN product, or null when the page carries no product (404, bot page, "Too many requests"…).
// One optional field beyond the contract: `note`, when the page says something that changes what the price
// means (eBay "Open box" / "Used", Warehouse-USA's "additional 11% discount applied in the cart").
import { decode, pageTitle, normSku, money, jsonLdProducts, jsonLdOffer, meta, uniq, withParam } from './common.js';

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────────
const strip = (s) => decode(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const grab = (html, re) => String(html ?? '').match(re)?.[1] ?? null;
const availabilityOf = (v) => (v ? /InStock|LimitedAvailability|OnlineOnly|PreOrder|InStoreOnly/i.test(String(v)) : null);
const higher = (was, price) => (was !== null && price !== null && was > price ? was : null);

// Every <script type="application/json"> block, parsed, with its attributes.
function jsonScripts(html) {
  const out = [];
  for (const m of String(html).matchAll(/<script\b([^>]*)type=["']application\/json["']([^>]*)>([\s\S]*?)<\/script>/gi)) {
    try { out.push({ attrs: m[1] + m[2], data: JSON.parse(m[3]) }); } catch { /* not JSON */ }
  }
  return out;
}

// Model numbers written in a title ("Stylish - Capri K-140S [K-140B] …", "OPEN BOX S-611W GRADE A …").
// Steel grades (T-304) and other short codes are not models.
const titleSkus = (title) => uniq([...String(title ?? '').toUpperCase().matchAll(/\b[A-Z]{1,3}-?\d{2,4}[A-Z0-9]*(?:-\d)?\b/g)]
  .map((m) => m[0]).filter((t) => !/^(T-?3\d\d|SUS\d+|[A-Z]{1,2}\d{1,2})$/.test(t) && (t.includes('-') || /\d{3}/.test(t))));
// The digits part of a model: "K-140S" → "K140", to tell an alias of the same model from another product.
const root = (s) => normSku(s).replace(/[A-Z]*$/, '');

// ── Kitchen & Bath Authority (X-Cart) ────────────────────────────────────────────────────────────────
// The main product is the microdata of div.product-place (productID, then its Offer); the visible price
// is #product_price, the struck "market price" #product_list_price ("0.00" = none). A family page (B-102,
// A-900…) opens on one finish and carries a JSON-LD ProductGroup whose hasVariant are all the options,
// each with its own gtin (the microdata gtin of some family pages is one UPC shared by every finish).
// A product that is gone redirects to a category page, whose listing microdata has no productID.
function kbauthority(html) {
  const sku = meta(html, 'productID') ?? meta(html, 'product:retailer_item_id');
  if (!sku) return null; // 404, home or category page
  const price = money(grab(html, /id="product_price">([^<]*)/)) ?? money(meta(html, 'price'));
  const variants = jsonLdProducts(html).filter((p) => p.sku);
  const self = variants.find((p) => normSku(p.sku) === normSku(sku));
  const others = variants.filter((p) => normSku(p.sku) !== normSku(sku));
  return {
    ids: uniq([sku, self ? self.gtin : variants.length ? null : meta(html, 'gtin')]),
    options: uniq(others.map((p) => p.sku)),
    // Each finish of a family page has its own address (hasVariant url).
    optionLinks: others.filter((p) => p.url).map((p) => ({ model: String(p.sku), name: p.color ? String(p.color) : null, gtin: p.gtin ? String(p.gtin) : null, url: String(p.url) })),
    price,
    wasPrice: higher(money(grab(html, /id="product_list_price">([^<]*)/)), price),
    currency: (meta(html, 'priceCurrency') ?? meta(html, 'product:price:currency'))?.toUpperCase() ?? null,
    inStock: availabilityOf(grab(html, /itemprop="availability"[^>]*href="([^"]+)"/)),
    itemId: grab(html, /<input[^>]*name="productid"[^>]*value="(\d+)"/),
    source: 'microdata',
  };
}

// ── Warehouse-USA (Shift4Shop / 3dcart) ──────────────────────────────────────────────────────────────
// "mpn: <span id="product_id" itemprop="sku">" is the model; the pricing block holds "Your Price"
// (ITEMPRICE), an optional SALEPRICE and price2 (regular) block, and the Offer microdata.
// The product's extra fields may say "Sale - additional 11% discount applied in the cart": a price the
// page does not show; it is returned as `note`.
function warehouseUsa(html) {
  const sku = strip(grab(html, /<span[^>]*id="product_id"[^>]*>([\s\S]*?)<\/span>/));
  const block = grab(html, /<!--START: pricing-->([\s\S]*?)<!--END: pricing-->/) ?? '';
  if (!sku && !block) return null; // 404 page, Cloudflare "Just a moment…"
  const amount = (part) => money(grab(grab(block, new RegExp(`<!--START: ${part}-->([\\s\\S]*?)<!--END: ${part}-->`, 'i')) ?? '', /\$\s*([\d,]+(?:\.\d{2})?)/));
  const yours = amount('ITEMPRICE') ?? money(grab(block, /itemprop="price"[^>]*content="([^"]+)"/));
  const sale = amount('SALEPRICE');
  const price = sale ?? yours;
  // The H1 may carry the new and the old code ("Capri K-140S [K-140B]"): keep the aliases of the same model.
  const h1 = strip(grab(html, /<h1[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/h1>/));
  const aliases = titleSkus(h1).filter((t) => !sku || root(t) === root(sku));
  const avail = grab(block, /itemprop="availability"[^>]*content="([^"]+)"/);
  const cart = grab(html, /additional\s+(\d+(?:\.\d+)?)\s*%\s*discount applied in the cart/i);
  return {
    ids: uniq([sku, ...aliases]),
    options: [],
    price,
    wasPrice: higher(sale !== null ? yours : amount('price2'), price),
    currency: grab(block, /itemprop="priceCurrency"[^>]*content="([A-Z]{3})"/) ?? null,
    inStock: avail ? /^InStock$/i.test(avail) : null,
    itemId: grab(html, /name="item_id"[^>]*value="(\d+)"/),
    source: 'microdata',
    ...(cart ? { note: `additional ${cart}% discount applied in the cart` } : {}),
  };
}

// ── Shopify (Cabinet Depot, Build with Rise) ─────────────────────────────────────────────────────────
// Every Shopify page has the analytics `var meta = {"product":{"variants":[{id, price (cents), sku}]}}`.
// The selected option is the URL's ?variant= (when it is one of this product's), else what the theme
// selected (Dawn's data-selected-variant JSON, the product form's <select name="id"> option "selected"
// (Empire) or <input name="id">), else the first available one, as Shopify does.
// compare_at_price / available come from the theme's product JSON, matched by variant id and price.
function shopify(html, url) {
  let product = null;
  try { product = JSON.parse(grab(html, /var meta = (\{[\s\S]*?\});\s*for \(var attr in meta\)/) ?? 'null')?.product; } catch { /* broken */ }
  const variants = product?.variants ?? [];
  if (!variants.length) return null; // not a product page / "Too many requests"
  const scripts = jsonScripts(html);
  const details = new Map(); // variant id → the theme's JSON of that variant (same id, same cents price)
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 6) return;
    const same = !Array.isArray(o) && variants.find((x) => String(x.id) === String(o.id) && x.price === o.price);
    if (same && !details.has(String(same.id))) details.set(String(same.id), o);
    for (const x of Object.values(o)) walk(x, d + 1);
  };
  for (const s of scripts) walk(s.data, 0);
  const pick = (id) => (id && variants.some((x) => String(x.id) === String(id)) ? String(id) : null);
  const form = [
    ...[...String(html).matchAll(/<select[^>]*name="id"[^>]*>([\s\S]*?)<\/select>/gi)].map((m) => grab(m[1], /<option\b(?=[^>]*\bselected\b)[^>]*value="(\d+)"/)),
    ...[...String(html).matchAll(/<input[^>]*name="id"[^>]*value="(\d+)"/gi)].map((m) => m[1]),
  ];
  const chosen = pick(grab(url, /[?&]variant=(\d+)/))
    ?? pick(scripts.find((s) => /data-selected-variant/.test(s.attrs))?.data?.id)
    ?? form.map(pick).find(Boolean)
    ?? String((variants.find((x) => details.get(String(x.id))?.available) ?? variants[0]).id);
  const v = variants.find((x) => String(x.id) === chosen);
  const full = details.get(chosen) ?? null;
  // JSON-LD offer of that variant (its url names the variant), for availability when the theme JSON has none.
  const ld = jsonLdProducts(html).filter((p) => p.offers);
  const offer = jsonLdOffer(ld.find((p) => [].concat(p.offers).some((o) => String(o?.url ?? '').includes(chosen))) ?? (variants.length === 1 ? ld[0] : null));
  const price = money(v.price / 100);
  const currency = grab(html, /Shopify\.currency\s*=\s*\{"active":"([A-Z]{3})"/) ?? offer?.currency ?? meta(html, 'og:price:currency');
  return {
    ids: uniq([v.sku, ...(v.sku ? [] : titleSkus(v.name))]),
    options: uniq(variants.filter((x) => String(x.id) !== chosen).map((x) => x.sku)),
    // The other options open with the product address + ?variant=<id>.
    optionLinks: variants.filter((x) => String(x.id) !== chosen).map((x) => ({
      model: x.sku ? String(x.sku) : null, name: x.public_title ?? x.name ?? null, itemId: String(x.id), url: withParam(url, 'variant', x.id),
    })).filter((o) => o.url),
    price,
    wasPrice: higher(full?.compare_at_price ? money(full.compare_at_price / 100) : null, price),
    currency: currency?.toUpperCase() ?? null,
    inStock: typeof full?.available === 'boolean' ? full.available : offer?.inStock ?? null,
    itemId: chosen,
    source: full ? 'shopify-meta+theme-json' : 'shopify-meta',
  };
}

// ── Sinks Direct Canada / USA (Wix Stores) ───────────────────────────────────────────────────────────
// JSON-LD Product (sku, offer = the price paid; Sinks Direct Canada writes "Offers" / "Availability" with
// capitals), the server-rendered price (data-hook formatted-primary-price / -secondary-price = struck) and
// the warmup data's product (appsWarmupData.*.productPage_<CUR>_<slug>.catalog.product: price = regular,
// discountedPrice = paid, productItems = options). The category gallery in the same data is other products.
function wix(html) {
  const ld = jsonLdProducts(html).find((p) => p.sku);
  let warm = null;
  try {
    const data = JSON.parse(grab(html, /<script[^>]*id="wix-warmup-data"[^>]*>([\s\S]*?)<\/script>/) ?? 'null');
    for (const app of Object.values(data?.appsWarmupData ?? {})) for (const [k, x] of Object.entries(app ?? {})) if (/^productPage_/.test(k) && x?.catalog?.product) warm = x.catalog.product;
  } catch { /* no warmup data */ }
  const sku = ld?.sku ?? warm?.sku ?? strip(grab(html, /data-hook="sku"[^>]*>([\s\S]*?)<\//)).replace(/^SKU:\s*/i, '');
  if (!sku) return null; // Wix "Product not found" page
  const offer = [].concat(ld?.offers ?? ld?.Offers ?? [])[0] ?? {};
  const shown = strip(grab(html, /data-hook="formatted-primary-price"[^>]*>([\s\S]*?)<\//));
  const price = money(offer.price) ?? money(warm?.discountedPrice) ?? money(shown);
  const struck = money(strip(grab(html, /data-hook="formatted-secondary-price"[^>]*>([\s\S]*?)<\//)));
  const avail = offer.availability ?? offer.Availability;
  return {
    ids: [sku],
    options: uniq((warm?.productItems ?? []).map((i) => i.sku).filter((s) => s && normSku(s) !== normSku(sku))),
    price,
    wasPrice: higher(struck ?? money(warm?.price), price),
    currency: (offer.priceCurrency ?? warm?.currency ?? (/C\$|CA\$/.test(shown) ? 'CAD' : null))?.toUpperCase() ?? null,
    inStock: avail ? availabilityOf(avail) : typeof warm?.isInStock === 'boolean' ? warm.isInStock : null,
    itemId: warm?.id ?? null,
    source: ld ? 'jsonld' : 'wix-warmup',
  };
}

// ── eBay ─────────────────────────────────────────────────────────────────────────────────────────────
// JSON-LD Product (offer price in the listing's currency), the item number from the canonical /itm/<n>,
// the item specifics (dt/dd: MPN, Model, Condition…) and the title. A removed listing is eBay's
// "page is missing" page (no JSON-LD product). A condition other than New is returned as `note`.
function ebay(html, url) {
  const p = jsonLdProducts(html).find((x) => x.offers);
  const itemId = grab(grab(html, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i) ?? url, /\/itm\/(?:[^/?#]+\/)?(\d{9,})/);
  if (!p || !itemId) return null;
  const specs = {};
  for (const m of String(html).matchAll(/<dt class="ux-labels-values__labels">([\s\S]*?)<\/dt>\s*<dd class="ux-labels-values__values">([\s\S]*?)<\/dd>/g)) specs[strip(m[1]).toLowerCase()] ??= strip(m[2]);
  const title = strip(grab(html, /<h1[^>]*class="x-item-title__mainTitle"[^>]*>([\s\S]*?)<\/h1>/)) || decode(p.name ?? pageTitle(html));
  const listed = [specs.mpn, specs['manufacturer part number'], specs.model].filter((s) => s && !/^(does not apply|n\/a|na|unbranded)$/i.test(s));
  const offer = jsonLdOffer(p);
  const shown = strip(grab(html, /<div[^>]*class="x-price-primary"[^>]*>([\s\S]*?)<\/div>/));
  const range = /\bto\b|–/.test(shown); // a listing with options and no option chosen: "C $120.00 to C $150.00"
  const was = money(strip(grab(grab(html, /<div[^>]*class="x-additional-info"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/) ?? '', /ux-textspans--STRIKETHROUGH[^>]*>([^<]*)/)));
  const condition = grab(specs.condition, /^(New(?: other| with defects)?|Open box|Used|(?:[\w ]+ - )?Refurbished|Seller refurbished|For parts or not working)/i);
  const ended = /This listing (?:was ended|sold on|has ended)|seller has ended this listing|This item is out of stock/i
    .test(String(html).replace(/<script\b[\s\S]*?<\/script>/gi, ' ')); // the status banner of an ended / sold-out listing
  return {
    ids: uniq([...(listed.length ? listed : titleSkus(title)), specs.upc]),
    options: [],
    price: range ? null : offer?.price ?? money(shown),
    wasPrice: range ? null : higher(was, offer?.price ?? money(shown)),
    currency: offer?.currency ?? (/^C\s?\$/.test(shown) ? 'CAD' : /^US\s?\$/.test(shown) ? 'USD' : null),
    inStock: ended ? false : offer?.inStock ?? null,
    itemId,
    source: 'jsonld',
    ...(condition && !/^new$/i.test(condition) ? { note: `condition: ${condition}` } : {}),
  };
}

export const readers = {
  kbauthority,
  warehouse_usa: warehouseUsa,
  cabinet_depot: shopify,
  build_with_rise: shopify,
  sinksdirect_ca: wix,
  sinksdirect_us: wix,
  ebay,
};
