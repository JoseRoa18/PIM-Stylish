// What a store's product page says about its product — read by the Where to
// Buy check from the page it already opened (user, 2026-10-20: "que apunte al
// producto correcto por SKU" and "traer el precio para el price alignment").
// Plain JavaScript (Deno edge functions and Node scripts), no dependencies.
//
// readProductPage(html, retailer, url) → PageRead | null for the MAIN product:
//   ids      its model # / MPN / vendor SKU as the store writes them
//   options  the models of the listing's OTHER options, when the page lists them
//   gtins    its GTIN / UPC when the page gives one
//   price    what a shopper pays now (the sale price while on sale); wasPrice the
//            regular / struck-through price next to it; currency CAD / USD
//   inStock  when the page says; itemId the store's own id of the product
//   note     what changes the meaning of the price or the link: a coupon or a
//            discount taken in the cart, an open-box listing, a price shown only
//            in the cart, a link that selects no option of the listing
//   gone     the page is there but the store no longer sells the product
// null = no product data on the page (not found, bot check, home, brand,
// category or search page).
// Each store family has its reader in ./pageReaders, written and tested on the
// stores' real pages on 2026-10-20 (Wayfair, Home Depot USA / Canada, Best
// Buy, Amazon, Lowe's and Rona, Walmart, BB&B and Overstock, and the dealers:
// Kitchen & Bath Authority, Warehouse-USA, Cabinet Depot, Build with Rise,
// Sinks Direct, eBay). Any other store gets the generic JSON-LD reader.
//
// skuCheck(read, sku, catalog) says whether that product is the link's SKU.

import { jsonLdProducts, jsonLdOffer, jsonLdIds, meta, money, normSku, uniq } from "./pageReaders/common.js";
import { readers as wayfair } from "./pageReaders/wayfair.js";
import { readers as homeDepot } from "./pageReaders/homeDepot.js";
import { readers as bestBuy } from "./pageReaders/bestBuy.js";
import { readers as amazon } from "./pageReaders/amazon.js";
import { readers as lowesRona } from "./pageReaders/lowesRona.js";
import { readers as walmart } from "./pageReaders/walmart.js";
import { readers as beyond } from "./pageReaders/beyond.js";
import { readers as dealers } from "./pageReaders/dealers.js";

const READERS = { ...wayfair, ...homeDepot, ...bestBuy, ...amazon, ...lowesRona, ...walmart, ...beyond, ...dealers };

// The stores whose reader finds a product page's data every time it was
// tried: on these, an open page that reads as nothing is NOT a product page
// (a brand, category or search page the link was sent to).
export const SURE_READERS = new Set(Object.keys(READERS));

// ---------------------------------------------------------------- generic reader
// A page whose store has no reader of its own: its JSON-LD product, else the
// product meta tags.
function readGeneric(html) {
  const products = jsonLdProducts(html);
  const main = products.find((p) => jsonLdOffer(p)) ?? products[0];
  if (main) {
    const offer = jsonLdOffer(main);
    return { ids: jsonLdIds(main), options: [], price: offer?.price ?? null, wasPrice: offer?.wasPrice ?? null, currency: offer?.currency ?? null, inStock: offer?.inStock ?? null, itemId: null, source: "jsonld" };
  }
  const price = money(meta(html, "product:price:amount") ?? meta(html, "og:price:amount"));
  if (price === null) return null;
  return {
    ids: uniq([meta(html, "product:retailer_item_id"), meta(html, "product:mfr_part_no")]), options: [], price, wasPrice: null,
    currency: (meta(html, "product:price:currency") ?? meta(html, "og:price:currency"))?.toUpperCase() ?? null, inStock: null, itemId: null, source: "meta",
  };
}

// ---------------------------------------------------------------- menards
// Menards is read through Bright Data's Menards scraper: its record already
// carries the product's data (title, brand, mpn = our SKU, price, sale_price,
// availability, gtin, item_id).
export function menardsRead(rec) {
  if (!rec || rec.error) return null;
  const sale = money(rec.sale_price);
  const regular = money(rec.price);
  return clean({
    ids: uniq([rec.mpn, rec.model_number, rec.model]),
    gtins: uniq([rec.gtin]),
    price: sale ?? regular,
    wasPrice: sale !== null && regular !== null && regular > sale ? regular : null,
    currency: String(rec.currency ?? "USD").toUpperCase(),
    inStock: rec.availability ? /IN_STOCK|InStock|in stock/i.test(String(rec.availability)) : null,
    itemId: rec.item_id ? String(rec.item_id) : null,
    source: "menards-scraper",
  });
}

// ---------------------------------------------------------------- reading
// Keep a reading within sane bounds. A bare 12–14 digit "id" is a GTIN / UPC.
function clean(read) {
  if (!read) return null;
  const all = uniq(read.ids).filter((x) => x.length <= 40);
  const ids = all.filter((x) => !/^\d{12,14}$/.test(x)).slice(0, 8);
  const gtins = uniq([...(read.gtins ?? []), ...all.filter((x) => /^\d{12,14}$/.test(x))]).filter((x) => /^\d{8,14}$/.test(x)).slice(0, 4);
  const price = typeof read.price === "number" && read.price > 0 && read.price < 100000 ? read.price : null;
  const wasPrice = typeof read.wasPrice === "number" && price !== null && read.wasPrice > price && read.wasPrice < 100000 ? read.wasPrice : null;
  const currency = /^(CAD|USD)$/.test(String(read.currency ?? "")) ? read.currency : null;
  const gone = read.gone === true;
  if (!ids.length && !gtins.length && price === null && !gone) return null;
  const note = uniq([
    read.note,
    read.coupon ? `${read.coupon} coupon at checkout` : null,
    /price in cart/i.test(String(read.source ?? "")) ? "price shown only in the cart" : null,
    read.optionDefaulted === true ? "the link selects no option: the store shows the listing's default one" : null,
  ]).join("; ").slice(0, 300) || null;
  return {
    ids,
    options: uniq(read.options).filter((x) => x.length <= 40).slice(0, 40),
    gtins, price, wasPrice, currency,
    inStock: typeof read.inStock === "boolean" ? read.inStock : null,
    itemId: read.itemId ? String(read.itemId).slice(0, 40) : null,
    source: read.source ? String(read.source).slice(0, 120) : null,
    optionDefaulted: read.optionDefaulted === true,
    gone,
    note,
  };
}

export function readProductPage(html, retailer, url) {
  if (!html) return null;
  try {
    const own = READERS[retailer];
    return clean(own ? own(html, url ?? "") : readGeneric(html));
  } catch {
    return null; // a page the reader does not understand reads as nothing
  }
}

// ---------------------------------------------------------------- the SKU check
// The PIM's products, to recognise a SKU or UPC that a page names and to tell
// a sibling of the same family: pimCatalog([{ sku, upc, family_number }]) —
// the UPC is the product's attributes.upc (`upc:attributes->>upc`).
//   bySku   letters-and-digits key → the SKUs that have it: a Stylish SKU and
//           its Azuni twin share one (A-906 / A906, ST-03 / ST03)
//   byUpc   UPC → SKU, only for a UPC one product alone carries (the kits
//           S-828W*K / S-831W*K share one, D-700C2 / D-701C2 another)
const upcKey = (v) => String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
export function pimCatalog(products) {
  const bySku = new Map();
  const upcs = new Map();
  const family = new Map();
  for (const p of products ?? []) {
    if (!p?.sku) continue;
    const n = normSku(p.sku);
    bySku.set(n, [...(bySku.get(n) ?? []), p.sku]);
    const upc = upcKey(p.upc);
    if (upc.length >= 8) upcs.set(upc, [...(upcs.get(upc) ?? []), p.sku]);
    if (p.family_number !== null && p.family_number !== undefined) family.set(p.sku, p.family_number);
  }
  const byUpc = new Map([...upcs].filter(([, skus]) => skus.length === 1).map(([upc, [sku]]) => [upc, sku]));
  return { bySku, byUpc, family };
}

// The spelling as written, without spaces or case: tells A-906 from A906.
const spelled = (s) => String(s ?? "").toUpperCase().replace(/\s+/g, "");

// The PIM product a store's code names: the SKU itself (between twins, the
// one written that way), or the longest PIM SKU it starts with when the store
// adds a short suffix of its own (Lowe's writes "S-310G1" for S-310G).
function ownerOf(id, catalog) {
  const code = normSku(id);
  const exact = catalog?.bySku?.get(code);
  if (exact) return exact.find((sku) => spelled(sku) === spelled(id)) ?? exact[0];
  let best = null;
  for (const [n, skus] of catalog?.bySku ?? []) {
    if (n.length >= 4 && code.length - n.length <= 2 && code.startsWith(n) && (!best || n.length > normSku(best).length)) best = skus[0];
  }
  return best;
}

// Do all the PIM products whose SKU starts with this code belong to one
// family — ours? A dealer's family model without its finish ("A-801") names
// one family; "K-131" covers the Modena faucets and their combos too.
function oneFamily(code, ourFamily, catalog) {
  if (ourFamily === null) return false;
  for (const [n, skus] of catalog?.bySku ?? []) {
    if (n.startsWith(code) && skus.some((sku) => catalog.family.get(sku) !== ourFamily)) return false;
  }
  return true;
}

// Is the page's product the link's SKU?
//   match    the page names it — as written, with a store's own suffix
//            (Lowe's "S-310G1"), as its family model without the finish (a
//            dealer's "A-801" for A-801B, when only that family starts so),
//            or by its UPC
//   variant  the page is on another option of the same product: a PIM product
//            of the same family (A-801N for A-801B, P-205-2 for P-205), a
//            listing that names ours among its options, or a listing the link
//            opens on its default option (no option selected)
//   other    the page is on ANOTHER PIM product (by its model or its UPC)
//   unknown  the page names no model the PIM can place (or one it cannot
//            tell from the link's SKU: the Azuni twin's spelling)
export function skuCheck(read, sku, catalog) {
  if (!read) return null;
  const want = normSku(sku);
  const ids = uniq(read.ids).map((id) => ({ id, n: normSku(id) })).filter((x) => x.n.length >= 3 && !/^\d+$/.test(x.n));
  const options = new Set(uniq(read.options).map(normSku));
  const ourFamily = catalog?.family?.get(sku) ?? null;
  const sibling = (owner) => options.has(want) || read.optionDefaulted === true
    || (ourFamily !== null && catalog?.family?.get(owner) === ourFamily);
  const judge = (owner, model) => (owner === sku ? { check: "match", model } : { check: sibling(owner) ? "variant" : "other", model: owner });
  const gtinOwner = () => (read.gtins ?? []).map((g) => catalog?.byUpc?.get(upcKey(g))).find(Boolean) ?? null;
  // A Stylish SKU and its Azuni twin differ only by the dash: the UPC tells
  // them apart, else only the exact spelling counts.
  if ((catalog?.bySku?.get(want)?.length ?? 0) > 1) {
    const owner = gtinOwner();
    if (owner) return judge(owner, ids[0]?.id ?? owner);
    const exact = ids.find((x) => spelled(x.id) === spelled(sku));
    if (exact) return { check: "match", model: exact.id };
    const twin = ids.find((x) => x.n === want);
    if (twin) return { check: "unknown", model: twin.id };
  } else if (ids.some((x) => x.n === want)) {
    return { check: "match", model: ids.find((x) => x.n === want).id };
  }
  for (const x of ids) {
    const owner = ownerOf(x.id, catalog);
    if (owner) return judge(owner, x.id);
  }
  const owner = gtinOwner();
  if (owner) return judge(owner, ids[0]?.id ?? owner);
  const family = ids.find((x) => x.n.length >= 4 && want.startsWith(x.n) && oneFamily(x.n, ourFamily, catalog));
  if (family) return { check: "match", model: family.id };
  return { check: "unknown", model: ids[0]?.id ?? null };
}
