// Shared helpers of the store page readers (one file per store family in this
// folder, gathered by ../pageProduct.js). Plain JS: runs in Deno and Node, no
// dependencies. Every reader returns a PageRead for the MAIN product of a
// product page:
//   {
//     ids:      string[]  identifiers of the page's own product as the store writes them:
//                         model #, MPN, manufacturer part #, vendor / seller SKU ("S-611W", "K-133N")
//     options:  string[]  model numbers of the OTHER options of the same listing when the page lists them
//                         (Wayfair / Amazon / Home Depot finishes) — never products of carousels
//     price:    number|null  what a shopper pays now (the sale price while on sale), in `currency`
//     wasPrice: number|null  the regular / struck-through price the page shows next to a sale price
//     currency: 'CAD'|'USD'|null
//     inStock:  boolean|null
//     itemId:   string|null  the store's own id of the product (Home Depot internet #, Lowe's item #,
//                            Rona article #, Beyond product id, ASIN…)
//     source:   string    which part of the page the reading came from ("jsonld", "next-data"…)
//   }
// or null when the page carries no product data (bot page, error page, home page).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#34': '"', reg: '®', trade: '™', copy: '©' };
export function decode(s) {
  return String(s ?? '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k in ENTITIES) return ENTITIES[k];
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
      return m;
    });
}

export const pageTitle = (html) => decode((String(html).match(/<title[^>]*>([^<]*)/i)?.[1] ?? '').replace(/\s+/g, ' ').trim());

// Visible text (scripts, styles and tags removed), one space between words.
export function textOf(html) {
  return decode(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Upper-case letters and digits only: "S-611W" → "S611W".
export const normSku = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// A money amount: 749, "749.00", "$1,234.50", "1 234,50 $", "CDN$ 1,234.50", "C$899.99".
export function money(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  let s = String(v).replace(/[^\d.,]/g, '');
  if (!s) return null;
  // "1 234,50" / "1.234,50" (French Canadian): a comma followed by exactly two digits at the end is the decimal mark.
  if (/,\d{2}$/.test(s) && !/\.\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// Every JSON-LD block of the page, parsed (blocks that do not parse are skipped).
export function jsonLd(html) {
  const out = [];
  for (const m of String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
    try { out.push(JSON.parse(raw)); } catch { /* a broken block */ }
  }
  return out;
}

// The Product / ProductGroup nodes of the JSON-LD blocks, in page order (variants of a group included).
export function jsonLdProducts(html) {
  const out = [];
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    const type = [].concat(o['@type'] ?? []).join(',');
    if (/\b(Product|ProductGroup|IndividualProduct|ProductModel)\b/i.test(type)) out.push(o);
    if (o['@graph']) walk(o['@graph'], depth + 1);
    if (o.hasVariant) walk(o.hasVariant, depth + 1);
    if (o.mainEntity) walk(o.mainEntity, depth + 1);
    if (o.itemListElement) walk(o.itemListElement, depth + 1);
    if (o.item) walk(o.item, depth + 1);
  };
  for (const block of jsonLd(html)) walk(block);
  return out;
}

// The first usable offer of a JSON-LD product: { price, wasPrice, currency, inStock }.
export function jsonLdOffer(product) {
  const offers = [].concat(product?.offers ?? []).flatMap((o) => (o?.['@type'] === 'AggregateOffer' && o.offers ? [].concat(o.offers) : [o]));
  for (const o of offers) {
    const spec = [].concat(o?.priceSpecification ?? []);
    const price = money(o?.price ?? o?.lowPrice ?? spec.find((p) => p?.price != null)?.price);
    if (price === null) continue;
    const list = spec.find((p) => /ListPrice|StrikethroughPrice|MSRP/i.test(String(p?.priceType ?? '')));
    const availability = String(o?.availability ?? '');
    return {
      price,
      wasPrice: list ? money(list.price) : null,
      currency: (o?.priceCurrency ?? spec.find((p) => p?.priceCurrency)?.priceCurrency ?? null)?.toUpperCase?.() ?? null,
      inStock: availability ? /InStock|LimitedAvailability|OnlineOnly|PreOrder|InStoreOnly/i.test(availability) : null,
    };
  }
  return null;
}

// Identifier fields of a JSON-LD product, as written.
export function jsonLdIds(product) {
  const ids = [];
  for (const k of ['mpn', 'sku', 'model', 'productID', 'gtin12', 'gtin13', 'gtin14', 'gtin']) {
    let v = product?.[k];
    if (v && typeof v === 'object') v = v.name ?? v.model ?? v['@id'] ?? null;
    if (v !== null && v !== undefined && String(v).trim()) ids.push(String(v).trim());
  }
  return ids;
}

// <meta property|name|itemprop="…" content="…"> (either attribute order).
export function meta(html, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(html).match(new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${k}["'][^>]*content=["']([^"']*)["']`, 'i'))
    ?? String(html).match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${k}["']`, 'i'));
  return m ? decode(m[1]).trim() : null;
}

// The JSON of a <script id="__NEXT_DATA__"> (or any script by id), parsed, or null.
export function scriptJson(html, id) {
  const k = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(html).match(new RegExp(`<script[^>]*id=["']${k}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Unique, trimmed, non-empty strings in their first order.
export const uniq = (list) => [...new Set((list ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))];

// Currency from a market when the page does not say it.
export const currencyOfMarket = (market) => (market === 'ca' ? 'CAD' : market === 'us' ? 'USD' : null);
