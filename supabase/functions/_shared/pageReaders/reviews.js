// The reviews of a store page's MAIN product: how many, and its average rating
// out of 5 (user, 2026-11-16: "solo necesito la cantidad de reviews y el rating
// global"). Read from the page the Where to Buy check already opened, like its
// price: nothing more is fetched. Plain JS (Deno and Node), no dependencies.
//
// reviewsOf(html, retailer) → { reviewCount, rating } | null
//   reviewCount  what the store shows next to the stars (Amazon and Walmart
//                count ratings, the others reviews)
//   rating       the average out of 5, two decimals; null with no review
//   null         the page does not say. A store that draws no rating block for
//                a product nobody reviewed reads as null, never as 0: only a
//                number the page writes is kept.
// Where each store writes it — one real product page of each, 2026-11-16:
//   Wayfair          the listing's review header button (data attributes:
//                    averageRating, totalReviewCount), else the listing's own
//                    "reviews" object in the page's data. A listing's reviews
//                    are those of all its options.
//   Amazon           the stars under the title (#averageCustomerReviews):
//                    "4.7 out of 5 stars" and the count beside it
//   Walmart          __NEXT_DATA__: the product's numberOfReviews and the
//                    reviews' own average
//   Home Depot CA    the hidden schema.org block of the product (ratingValue,
//                    reviewCount), else the product's entry of the page state
//   Rona             the product's own record of the new page (aggregateRating),
//                    else the rating summary the page draws (Bazaarvoice)
//   Best Buy, Home Depot USA, Bed Bath & Beyond, Overstock, Sinks Direct and
//   any other store: the page's own JSON-LD Product (aggregateRating) — a
//   top-level one, never a product of a list or a carousel.
// Lowe's and Menards are read through Bright Data's scrapers: their record
// carries both (pageProduct.js lowesRecordRead / menardsRead, with
// reviewReading below). The small dealers' pages draw their reviews with a
// widget after loading (Judge.me): nothing to read there.

import { jsonLd, scriptJson, flightOf, flightRows } from './common.js';

const countOf = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[\s,\u00a0\u202f]/g, ''));
  return Number.isInteger(n) && n >= 0 && n < 10000000 ? n : null;
};
const starsOf = (v) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n <= 5 ? Math.round(n * 100) / 100 : null;
};

/** A reading from what a store gives: the count, and the rating when there is at least one review. */
export function reviewReading(rating, reviews) {
  const reviewCount = countOf(reviews);
  if (reviewCount === null) return null;
  return { reviewCount, rating: reviewCount > 0 ? starsOf(rating) : null };
}

// ---------------------------------------------------------------- JSON-LD
const isProduct = (x) => Boolean(x) && typeof x === 'object' && /\b(Product|ProductGroup)\b/.test([].concat(x['@type'] ?? []).join(','));
function fromJsonLd(html) {
  const top = jsonLd(html).flat().filter((x) => x && typeof x === 'object');
  const product = [...top, ...top.flatMap((x) => (Array.isArray(x['@graph']) ? x['@graph'] : [])), ...top.map((x) => x.mainEntity)].find(isProduct);
  const agg = [].concat(product?.aggregateRating ?? [])[0];
  return agg && typeof agg === 'object' ? reviewReading(agg.ratingValue, agg.reviewCount ?? agg.ratingCount) : null;
}

// ---------------------------------------------------------------- Wayfair
function wayfair(html) {
  const head = html.match(/averageRating&quot;:([\d.]+|null),&quot;totalReviewCount&quot;:(\d+)\}"[^>]{0,400}reviewsHeaderButton/);
  if (head) return reviewReading(head[1] === 'null' ? null : head[1], head[2]);
  const own = flightOf(html).match(/"reviews":\{"averageRating":([\d.]+|null),"totalCount":(\d+),"__typename":"MarketplaceListingReviews/);
  return own ? reviewReading(own[1] === 'null' ? null : own[1], own[2]) : null;
}

// ---------------------------------------------------------------- Amazon
// "4.7 out of 5 stars" (French pages: "4,7 sur 5 étoiles") and the count: its
// aria-label ("1,234 Reviews"), else its text "(6)" — never a shortened "1.2K".
function amazon(html) {
  const at = html.indexOf('id="averageCustomerReviews');
  if (at < 0) return null;
  const zone = html.slice(at, at + 12000);
  const stars = zone.match(/id="acrPopover"[^>]*title="([\d.,]+)\s/)?.[1];
  const label = zone.match(/id="acrCustomerReviewText"[^>]*aria-label="([\d.,\s\u00a0\u202f]+?)\s*[A-Za-zÀ-ÿ]/)?.[1];
  const text = zone.match(/id="acrCustomerReviewText"[^>]*>\s*\(?\s*([\d,\s\u00a0\u202f]+?)\s*\)?\s*(?:[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ ]*)?</)?.[1];
  return stars ? reviewReading(stars, countOf(label) ?? countOf(text)) : null;
}

// ---------------------------------------------------------------- Walmart
function walmart(html) {
  const data = scriptJson(html, '__NEXT_DATA__')?.props?.pageProps?.initialData?.data;
  const p = data?.product;
  if (!p) return null;
  const all = data.reviews ?? null;
  const count = p.numberOfReviews ?? all?.totalReviewCount;
  // The reviews' own average when it is about the same count (4.93), else the product's rounded one (4.9).
  const rating = (all && all.totalReviewCount === count ? all.averageOverallRating : null) ?? p.averageRating ?? all?.roundedAverageOverallRating;
  return reviewReading(rating, count);
}

// ---------------------------------------------------------------- Home Depot Canada
function homeDepotCa(html) {
  const schema = html.match(/<hdca-product-schema-definition[\s\S]*?<\/hdca-product-schema-definition>/i)?.[0] ?? '';
  const m = schema.match(/itemprop="ratingValue"[^>]*>([^<]*)<[\s\S]{0,300}?itemprop="reviewCount"[^>]*>([^<]*)</);
  if (m) return reviewReading(m[1], m[2]);
  // The page's state: the one item it is about ("product-<item #>": averageRating, numberOfReviews).
  const items = Object.entries(scriptJson(html, 'hdca-state') ?? {}).filter(([k, v]) => /^product-\d+$/.test(k) && (v?.code || v?.modelNumber));
  return items.length === 1 ? reviewReading(items[0][1].averageRating, items[0][1].numberOfReviews) : null;
}

// ---------------------------------------------------------------- Rona
/** The product's own record of Rona's new page: { name, brand, sku = article #, gtin, mpn = model #, aggregateRating, isDiscontinued }. */
export function ronaRecord(html) {
  if (!html.includes('self.__next_f.push')) return null;
  const found = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 14) return;
    if (!Array.isArray(o) && typeof o.mpn === 'string' && o.sku && ('isDiscontinued' in o || 'aggregateRating' in o || o.gtin)) { found.push(o); return; }
    for (const k in o) walk(o[k], depth + 1);
  };
  for (const row of flightRows(flightOf(html))) walk(row, 0);
  // One product per page; several different ones = a list, not a product page.
  return new Set(found.map((x) => String(x.sku))).size === 1 ? found[0] : null;
}
function rona(html) {
  const rec = ronaRecord(html);
  if (rec?.aggregateRating && typeof rec.aggregateRating === 'object') return reviewReading(rec.aggregateRating.ratingValue, rec.aggregateRating.reviewCount);
  // The rating summary the page draws under the title (Bazaarvoice): "4.9" and "(66)".
  const stars = html.match(/itemprop="ratingValue"[^>]*class="bv_avgRating_component_container[^"]*"[^>]*>\s*([\d.]+)\s*</)?.[1];
  const count = html.match(/class="bv_numReviews_text[^"]*"[^>]*>\s*\(?\s*([\d,]+)\s*\)?\s*</)?.[1];
  return stars && count ? reviewReading(stars, count) : null;
}

const OWN = {
  wayfair_ca: wayfair, wayfair_us: wayfair,
  amazon_ca: amazon, amazon_us: amazon,
  walmart_ca: walmart, walmart_us: walmart,
  homedepot_ca: homeDepotCa,
  rona,
};

export function reviewsOf(html, retailer) {
  const page = String(html ?? '');
  try {
    return OWN[retailer]?.(page) ?? fromJsonLd(page);
  } catch {
    return null; // a page this does not understand says nothing about its reviews
  }
}
