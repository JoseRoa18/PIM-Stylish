// "Where to Buy" audit registry — mirrors the retailer keys the
// where-to-buy-audit edge function writes (supabase/functions/where-to-buy-audit).

export const WTB_SITES = [
  { key: 'stylish_ca', label: 'Stylish Canada', short: 'Canada' },
  { key: 'stylish_us', label: 'Stylish USA', short: 'USA' },
];

// Column order on the grid: Canada retailers, then USA, then the extras.
export const WTB_RETAILERS = [
  { key: 'sinksdirect_ca', label: 'SinksDirect.ca', short: 'SD.ca', market: 'ca' },
  { key: 'wayfair_ca', label: 'Wayfair.ca', short: 'WF.ca', market: 'ca' },
  { key: 'bestbuy_ca', label: 'BestBuy.ca', short: 'BB.ca', market: 'ca' },
  { key: 'homedepot_ca', label: 'HomeDepot.ca', short: 'HD.ca', market: 'ca' },
  { key: 'walmart_ca', label: 'Walmart.ca', short: 'WM.ca', market: 'ca' },
  { key: 'amazon_ca', label: 'Amazon.ca', short: 'AMZ.ca', market: 'ca' },
  { key: 'bbb_ca', label: 'BedBathandBeyond.ca', short: 'BBB.ca', market: 'ca' },
  { key: 'rona', label: 'Rona', short: 'Rona', market: 'ca' },
  { key: 'lowes_ca', label: 'Lowes.ca', short: 'LW.ca', market: 'ca' },
  { key: 'sinksdirect_us', label: 'SinksDirect USA', short: 'SD.us', market: 'us' },
  { key: 'wayfair_us', label: 'Wayfair.com', short: 'WF.com', market: 'us' },
  { key: 'amazon_us', label: 'Amazon.com', short: 'AMZ.com', market: 'us' },
  { key: 'homedepot_us', label: 'HomeDepot.com', short: 'HD.com', market: 'us' },
  { key: 'lowes_us', label: 'Lowes.com', short: 'LW.com', market: 'us' },
  { key: 'walmart_us', label: 'Walmart.com', short: 'WM.com', market: 'us' },
  { key: 'bbb_us', label: 'BedBathandBeyond.com', short: 'BBB.com', market: 'us' },
  { key: 'menards', label: 'Menards', short: 'Menards', market: 'us' },
  { key: 'kbauthority', label: 'KB Authority', short: 'KBA', market: 'us' },
  { key: 'warehouse_usa', label: 'Warehouse USA', short: 'WH USA', market: 'us' },
  { key: 'overstock_ca', label: 'Overstock.ca', short: 'OS.ca', market: 'ca' },
  { key: 'cabinet_depot', label: 'Cabinet Depot', short: 'CabDep', market: 'ca' },
  { key: 'build_with_rise', label: 'Build with Rise', short: 'Rise', market: 'ca' },
  { key: 'overstock_us', label: 'Overstock.com', short: 'OS.com', market: 'us' },
  { key: 'faucetline', label: 'Faucetline', short: 'Fline', market: 'us' },
  { key: 'ebay', label: 'eBay', short: 'eBay', market: null },
  { key: 'stylish_locator', label: 'Store locator', short: 'Locator', market: null },
  { key: 'other', label: 'Other link', short: 'Other', market: null },
];

// Four verdicts only (user rule, 2026-09-15): a pure "does the link open the
// product page" check, nothing compared with the PIM. `note` carries the reason.
export const WTB_VERDICTS = {
  ok: { label: 'OK', tone: 'ok', problem: false, hint: 'The link opens and shows the product.' },
  broken: { label: 'Broken', tone: 'error', problem: true, hint: 'There is a link but it does not open the product page: not found, redirects elsewhere or invalid address.' },
  missing: { label: 'Missing link', tone: 'warning', problem: true, hint: 'The page has no link to this portal, although most products of the site link it.' },
  pending: { label: 'Pending', tone: 'muted', problem: false, hint: 'Not verified yet: the site blocks automated checks or did not answer. Retried every hour.' },
};

export const isProblem = (verdict) => Boolean(WTB_VERDICTS[verdict]?.problem);

/** Group the flat rows by SKU: { sku, wix_product_id, links[], docs[], problems }. */
export function groupWhereToBuy(rows) {
  const bySku = new Map();
  for (const r of rows) {
    if (!bySku.has(r.sku)) bySku.set(r.sku, { sku: r.sku, wix_product_id: r.wix_product_id, links: [], docs: [], problems: 0, dropbox: 0 });
    const g = bySku.get(r.sku);
    (r.section === 'documents' ? g.docs : g.links).push(r);
    if (isProblem(r.verdict)) g.problems += 1;
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
