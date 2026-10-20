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
  ok: { label: 'OK', tone: 'ok', problem: false, hint: 'The link opens and shows the product. Checked again every 2 days.' },
  broken: { label: 'Broken', tone: 'error', problem: true, hint: 'There is a link but it does not open the product page: not found, redirects elsewhere or invalid address. Checked again daily.' },
  missing: { label: 'Link to add', tone: 'warning', problem: false, hint: 'The page has no link to this portal, although most products of the site link it.' },
  pending: { label: 'Not checked yet', tone: 'muted', problem: false, hint: 'Waiting for its first answer: new links are opened within the hour, and a store that did not answer is tried again a few hours later.' },
  manual: { label: 'Check by hand', tone: 'muted', problem: false, hint: 'This site turns every automatic check away (Faucetline): open the link to check it.' },
};

export const WTB_VIA = { direct: 'the PIM', brightdata: 'Bright Data', scraperapi: 'ScraperAPI', price2spy: 'Price2Spy' };

export const isProblem = (verdict) => Boolean(WTB_VERDICTS[verdict]?.problem);

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
    if (isProblem(r.verdict)) g.problems += 1;
    if (r.verdict === 'missing') g.missing.push(r.retailer);
    if (r.retailer === 'dropbox') g.dropbox += 1;
  }
  return [...bySku.values()].sort((a, b) => b.problems - a.problems || a.sku.localeCompare(b.sku));
}

export function summarizeWhereToBuy(rows) {
  const s = { products: new Set(), links: 0, docs: 0, byVerdict: {}, problems: 0, dropbox: 0, pending: 0, lastScan: null, lastCheck: null };
  for (const r of rows) {
    s.products.add(r.sku);
    if (r.section === 'documents') s.docs += 1; else if (r.url) s.links += 1;
    s.byVerdict[r.verdict] = (s.byVerdict[r.verdict] ?? 0) + 1;
    if (isProblem(r.verdict)) s.problems += 1;
    if (r.verdict === 'pending') s.pending += 1;
    if (r.retailer === 'dropbox') s.dropbox += 1;
    if (!s.lastScan || r.scanned_at > s.lastScan) s.lastScan = r.scanned_at;
    if (r.checked_at && (!s.lastCheck || r.checked_at > s.lastCheck)) s.lastCheck = r.checked_at;
  }
  s.products = s.products.size;
  return s;
}
