// "Where to Buy" audit registry — the retailer keys the where-to-buy-audit
// edge function writes (supabase/functions/where-to-buy-audit).

import { WTB_RETAILERS as STORES } from '@/features/products/lib/whereToBuy';

export const WTB_SITES = [
  { key: 'stylish_ca', label: 'Stylish Canada', short: 'Canada' },
  { key: 'stylish_us', label: 'Stylish USA', short: 'USA' },
];

// Column order on the grid: the stores the PIM keeps, Canada then USA — the
// same registry as the product page and the Wix push (the store locator,
// documents and unknown links are not checked, user 2026-10-19).
const SHORT = {
  sinksdirect_ca: 'SD.ca', wayfair_ca: 'WF.ca', bestbuy_ca: 'BB.ca', homedepot_ca: 'HD.ca', walmart_ca: 'WM.ca', amazon_ca: 'AMZ.ca',
  rona: 'Rona', cabinet_depot: 'CabDep', build_with_rise: 'Rise', ebay: 'eBay',
  sinksdirect_us: 'SD.us', wayfair_us: 'WF.com', amazon_us: 'AMZ.com', homedepot_us: 'HD.com', lowes_us: 'LW.com', walmart_us: 'WM.com',
  bbb_us: 'BBB.com', overstock_us: 'OS.com', menards: 'Menards', kbauthority: 'KBA', warehouse_usa: 'WH USA', faucetline: 'Fline',
};
export const WTB_RETAILERS = STORES.map((r) => ({ key: r.key, label: r.label, short: SHORT[r.key] ?? r.label, market: r.market }));

// A pure "does the link open the product page" check, nothing compared with
// the PIM; `note` carries the reason. The list says OK or Broken (user,
// 2026-10-19); a portal the page does not link is a KPI of links to add, and
// the sites no service can open are checked by hand.
export const WTB_VERDICTS = {
  ok: { label: 'OK', tone: 'ok', problem: false, hint: 'The link opens and shows the product. Checked every Monday, Wednesday and Friday from 1 AM (Cambridge time).' },
  broken: { label: 'Broken', tone: 'error', problem: true, hint: 'There is a link but it does not open the product page: not found, redirects elsewhere or invalid address. Checked again every Monday, Wednesday and Friday.' },
  missing: { label: 'Link to add', tone: 'warning', problem: false, hint: 'The page has no link to this portal, although most products of the site link it.' },
  pending: { label: 'Not checked yet', tone: 'muted', problem: false, hint: 'Waiting for its first answer: new links are opened within the hour, and a store that did not answer is tried again a few hours later.' },
  manual: { label: 'Check by hand', tone: 'muted', problem: false, hint: 'This site turns every automatic check away (Faucetline): open the link to check it.' },
};

export const WTB_VIA = { direct: 'the PIM', brightdata: 'Bright Data', scraperapi: 'ScraperAPI', price2spy: 'Price2Spy' };

export const isProblem = (verdict) => Boolean(WTB_VERDICTS[verdict]?.problem);

// The check also reads the page's product (user, 2026-10-20: "que apunte al
// producto correcto por SKU"): a link whose page shows another product, or
// another option of it (another finish or size, or the listing's default
// option), is a problem of its own, "Wrong product". It leaves the websites
// until it is fixed (user, the same day: "solo dejar los OK" — isHiddenLink in
// supabase/functions/_shared/whereToBuy.js, which also leaves sold-out links out);
// another PIM product also turns Broken on a second check two days later.
export const WRONG_PRODUCT = {
  label: 'Wrong product', tone: 'warning', problem: true,
  hint: 'The link opens another product. It is not shown on the Stylish websites until it is fixed — use the suggested link or edit it in the product\'s Where to Buy tab.',
};
export const WRONG_OPTION = {
  label: 'Wrong product', tone: 'warning', problem: true,
  hint: 'The link opens another option of the same product (another finish or size). It is not shown on the Stylish websites until it opens this product\'s option — use the suggested link or edit it.',
};
// A link that opens the right listing on its default option (sku_check
// 'listing' — Wayfair without ?piid=): the user counts it as fine (2026-10-20),
// so it stays on the websites and is no problem; only a hint to give it the
// product's own option.
export const OTHER_FINISH = {
  label: 'Other finish', tone: 'muted', problem: false,
  hint: 'Opens the right listing, but the store preselects another finish (with its price); this product\'s finish is one click away. It stays on the websites — use the suggested link so it opens this product\'s own option.',
};
// A link whose page says the product is sold out (user, 2026-10-26: some
// marketplaces showed it as Broken — "Ocultar hasta que vuelva"): nothing to
// fix. It leaves the websites until the store has the product again
// (isHiddenLink) and is read again on every check day. Best Buy takes the page down while
// our offer has no stock, so such a 404 counts here too. An "Other finish"
// page shows the stock of the store's default option and never counts.
export const OUT_OF_STOCK = {
  label: 'Out of stock', tone: 'stock', problem: false,
  hint: 'The store shows the product as sold out. It is not shown on the Stylish websites until the store has it again; read again every Monday, Wednesday and Friday.',
};
export const isWrongProduct = (row) => row?.sku_check === 'other' || row?.sku_check === 'variant';
export const isOtherFinish = (row) => row?.sku_check === 'listing';
export const isOutOfStock = (row) => row?.in_stock === false && !isOtherFinish(row);
// What a link's status chip says: its verdict, or "Wrong product" / "Out of
// stock" / "Other finish" while the link is not Broken (OK, or a new link
// waiting for its second check).
export const linkStatus = (row) => {
  const open = row.verdict === 'ok' || row.verdict === 'pending';
  if (open && isWrongProduct(row)) return row.sku_check === 'variant' ? WRONG_OPTION : WRONG_PRODUCT;
  if (open && isOutOfStock(row)) return OUT_OF_STOCK;
  if (open && isOtherFinish(row)) return OTHER_FINISH;
  return WTB_VERDICTS[row.verdict] ?? { label: row.verdict, tone: 'muted' };
};
export const isLinkProblem = (row) => isProblem(row.verdict) || isWrongProduct(row);

// "S-611W · C$749.00" — what the page showed the last time it was read.
export function pageReading(row) {
  if (!row?.read_at) return null;
  const symbol = row.currency === 'USD' ? '$' : row.currency === 'CAD' ? 'C$' : '';
  const price = row.price != null ? `${symbol}${Number(row.price).toFixed(2)}` : null;
  const was = row.was_price != null ? `was ${symbol}${Number(row.was_price).toFixed(2)}` : null;
  return {
    model: row.page_model ?? null,
    price,
    text: [row.page_model, price, was, row.in_stock === false ? 'sold out' : null, row.page_note].filter(Boolean).join(' · ') || 'No model or price on the page',
  };
}

/** Missing links by portal: [{ retailer, label, skus[] }], most missing first. */
export function linksToAdd(rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.verdict !== 'missing') continue;
    if (!by.has(r.retailer)) by.set(r.retailer, new Set());
    by.get(r.retailer).add(r.sku);
  }
  return [...by.entries()]
    .map(([retailer, skus]) => ({ retailer, label: WTB_RETAILERS.find((x) => x.key === retailer)?.label ?? retailer, skus: [...skus].sort() }))
    .sort((a, b) => b.skus.length - a.skus.length || a.label.localeCompare(b.label));
}

/** Group the flat rows by SKU: { sku, wix_product_id, links[], docs[], problems }. */
export function groupWhereToBuy(rows) {
  const bySku = new Map();
  for (const r of rows) {
    if (!bySku.has(r.sku)) bySku.set(r.sku, { sku: r.sku, wix_product_id: r.wix_product_id, links: [], docs: [], problems: 0, missing: [], dropbox: 0 });
    const g = bySku.get(r.sku);
    (r.section === 'documents' ? g.docs : g.links).push(r);
    if (isLinkProblem(r)) g.problems += 1;
    if (r.verdict === 'missing') g.missing.push(r.retailer);
    if (r.retailer === 'dropbox') g.dropbox += 1;
  }
  return [...bySku.values()].sort((a, b) => b.problems - a.problems || a.sku.localeCompare(b.sku));
}

export function summarizeWhereToBuy(rows) {
  const s = { products: new Set(), links: 0, docs: 0, byVerdict: {}, problems: 0, wrongProduct: 0, outOfStock: 0, otherFinish: 0, dropbox: 0, pending: 0, lastScan: null, lastCheck: null };
  for (const r of rows) {
    s.products.add(r.sku);
    if (r.section === 'documents') s.docs += 1; else if (r.url) s.links += 1;
    // Each link counts once, under what its chip says ("Wrong product", "Out
    // of stock", "Other finish" or its verdict — a Broken one that opens
    // another product counts as Broken).
    const status = linkStatus(r);
    if (r.url && (status === WRONG_PRODUCT || status === WRONG_OPTION)) s.wrongProduct += 1;
    else if (r.url && status === OUT_OF_STOCK) s.outOfStock += 1;
    else if (r.url && status === OTHER_FINISH) s.otherFinish += 1;
    else {
      s.byVerdict[r.verdict] = (s.byVerdict[r.verdict] ?? 0) + 1;
      if (r.verdict === 'pending') s.pending += 1;
    }
    if (isLinkProblem(r)) s.problems += 1;
    if (r.retailer === 'dropbox') s.dropbox += 1;
    if (!s.lastScan || r.scanned_at > s.lastScan) s.lastScan = r.scanned_at;
    if (r.checked_at && (!s.lastCheck || r.checked_at > s.lastCheck)) s.lastCheck = r.checked_at;
  }
  s.products = s.products.size;
  return s;
}
