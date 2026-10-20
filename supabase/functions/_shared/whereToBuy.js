/**
 * WHERE TO BUY — the retailer links of the Stylish product pages (user,
 * 2026-10-19: "que PIM sea dueño"). The PIM keeps ONE list per product
 * (table product_where_to_buy: sku, retailer, url) and builds the WHERE TO
 * BUY section of BOTH Stylish sites from it, so the two pages always agree.
 * Shared by the product page (Where to Buy tab), the Listing Health audit
 * (supabase/functions/where-to-buy-audit) and the import from Wix
 * (scripts/import-where-to-buy-from-wix.mjs).
 *
 * One label per retailer (they used to vary page by page: "SinksDirect.com" /
 * "SinksDirect USA", "KBAuthority.com" / "Kitchen&Bath Authority"…) and each
 * retailer under its own country (Cabinet Depot and Build with Rise are
 * Canadian stores; they sat under "Online in USA"). The order of the list is
 * the order on the page. BedBathandBeyond.ca, Overstock.ca and Lowes.ca no
 * longer exist (user, 2026-10-20): they are not stores of the list, so their links are
 * neither kept, checked nor published.
 */

export const WTB_RETAILERS = [
  // Online in Canada
  { key: 'sinksdirect_ca', label: 'SinksDirect.ca', market: 'ca', host: /(^|\.)sinksdirect\.ca$/ },
  { key: 'wayfair_ca', label: 'Wayfair.ca', market: 'ca', host: /(^|\.)wayfair\.ca$/ },
  { key: 'bestbuy_ca', label: 'BestBuy.ca', market: 'ca', host: /(^|\.)bestbuy\.ca$/ },
  { key: 'homedepot_ca', label: 'HomeDepot.ca', market: 'ca', host: /(^|\.)homedepot\.ca$/ },
  { key: 'walmart_ca', label: 'Walmart.ca', market: 'ca', host: /(^|\.)walmart\.ca$/ },
  { key: 'amazon_ca', label: 'Amazon.ca', market: 'ca', host: /(^|\.)amazon\.ca$/ },
  { key: 'rona', label: 'Rona', market: 'ca', host: /(^|\.)rona\.ca$/ },
  { key: 'cabinet_depot', label: 'Cabinet Depot', market: 'ca', host: /(^|\.)cabinetdepotnewmarket\.com$/ },
  { key: 'build_with_rise', label: 'Build with Rise', market: 'ca', host: /(^|\.)buildwithrise\.com$/ },
  { key: 'ebay', label: 'eBay.ca', market: 'ca', host: /(^|\.)ebay\.(ca|com)$/ },
  // Online in USA
  { key: 'sinksdirect_us', label: 'SinksDirect USA', market: 'us', host: /(^|\.)sinksdirectusa\.com$/ },
  { key: 'wayfair_us', label: 'Wayfair.com', market: 'us', host: /(^|\.)wayfair\.com$/ },
  { key: 'amazon_us', label: 'Amazon.com', market: 'us', host: /(^|\.)amazon\.com$/ },
  { key: 'homedepot_us', label: 'HomeDepot.com', market: 'us', host: /(^|\.)homedepot\.com$/ },
  { key: 'lowes_us', label: 'Lowes.com', market: 'us', host: /(^|\.)lowes\.com$/ },
  { key: 'walmart_us', label: 'Walmart.com', market: 'us', host: /(^|\.)walmart\.com$/ },
  { key: 'bbb_us', label: 'BedBathandBeyond.com', market: 'us', host: /(^|\.)bedbathandbeyond\.com$/ },
  { key: 'overstock_us', label: 'Overstock.com', market: 'us', host: /(^|\.)overstock\.com$/ },
  { key: 'menards', label: 'Menards.com', market: 'us', host: /(^|\.)menards\.com$/ },
  { key: 'kbauthority', label: 'Kitchen & Bath Authority', market: 'us', host: /(^|\.)kbauthority\.com$/ },
  { key: 'warehouse_usa', label: 'Warehouse-USA.com', market: 'us', host: /(^|\.)warehouse-usa\.com$/ },
  { key: 'faucetline', label: 'Faucetline.com', market: 'us', host: /(^|\.)faucetline\.com$/ },
];

export const WTB_MARKETS = [
  { key: 'ca', heading: 'Online in Canada', label: 'Canada' },
  { key: 'us', heading: 'Online in USA', label: 'USA' },
];

// The two Stylish sites that carry the section, and their order of blocks.
// The Canada page opens with the store locator (a page element, not a link
// the PIM keeps).
export const WTB_SITES = [
  { key: 'stylish_ca', label: 'Stylish Canada', markets: ['ca', 'us'], locator: true },
  { key: 'stylish_us', label: 'Stylish USA', markets: ['us', 'ca'], locator: false },
];
export const WTB_SECTION_TITLE = 'WHERE TO BUY';
export const STORE_LOCATOR_URL = 'https://www.stylishkb.com/store-locator';

const byKey = new Map(WTB_RETAILERS.map((r) => [r.key, r]));
export const wtbRetailer = (key) => byKey.get(key) ?? null;

/** The retailer an address belongs to, or null (not a store the PIM keeps). */
export function retailerForUrl(url) {
  let host;
  try { host = new URL(String(url).trim()).hostname.toLowerCase(); } catch { return null; }
  return WTB_RETAILERS.find((r) => r.host.test(host)) ?? null;
}

/**
 * Tidy an address before it is stored: trim, spaces as %20, and Amazon's
 * long tracking links cut to …/dp/<ASIN> (the same page).
 */
export function cleanWtbUrl(url) {
  let u = String(url ?? '').trim().replace(/ /g, '%20');
  const asin = u.match(/^https?:\/\/(?:www\.)?(amazon\.(?:ca|com))\/(?:[^?#]*\/)?dp\/([A-Z0-9]{10})(?:[/?#]|$)/i);
  if (asin) u = `https://www.${asin[1].toLowerCase()}/dp/${asin[2].toUpperCase()}`;
  return u;
}

/**
 * Why an address cannot go in a retailer's row, or null when it fits:
 * it must be a web address of that retailer's own site.
 */
export function wtbUrlProblem(retailerKey, url) {
  const r = wtbRetailer(retailerKey);
  if (!r) return 'Unknown store';
  let parsed;
  try { parsed = new URL(String(url).trim()); } catch { return 'Not a web address'; }
  if (!/^https?:$/.test(parsed.protocol)) return 'Not a web address';
  if (!r.host.test(parsed.hostname.toLowerCase())) return `Not a ${r.label} address`;
  return null;
}

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Whether the pages leave a link out (user, 2026-10-20: "solo dejar los OK"):
 * the audit found it broken, or its page shows another product or another
 * option of it ("Wrong product"). It stays in the PIM to be fixed and comes
 * back on the page once it opens the product again. A link not verified yet
 * is shown (the user's choice the same day: BB&B / Overstock wait for
 * ScraperAPI).
 */
export const isHiddenLink = (verdict, skuCheck) => verdict === 'broken' || skuCheck === 'variant' || skuCheck === 'other';

/** The links a page shows: the product's list minus its hidden addresses (isHiddenLink). */
export const linksToShow = (links, hiddenUrls) => (links ?? []).filter((l) => l?.url && !hiddenUrls?.has(l.url));

/**
 * The WHERE TO BUY section of one Stylish site from the product's links
 * ([{ retailer, url }]), in the shape the pages already use:
 *   <p><strong>Online in Canada:</strong></p><ul><li><a href target=_blank>Label</a></li>…</ul>
 * A country with no link is left out. Returns '' when nothing would show —
 * unless `allowEmpty`, where the Canada page keeps its store locator alone.
 */
export function buildWhereToBuyHtml(links, siteKey, { allowEmpty = false } = {}) {
  const site = WTB_SITES.find((s) => s.key === siteKey);
  if (!site) throw new Error(`Unknown Stylish site ${siteKey}`);
  const byRetailer = new Map(links.filter((l) => l?.url).map((l) => [l.retailer, l.url]));
  const blocks = [];
  if (site.locator) {
    blocks.push(
      '<p><strong>In Stores in Canada:</strong></p>\n'
      + `<p>Click <a href="${STORE_LOCATOR_URL}" target="_blank">here</a> to locate a Dealer near you.&nbsp;</p>`,
    );
  }
  let hasLink = false;
  for (const m of site.markets) {
    const market = WTB_MARKETS.find((x) => x.key === m);
    const items = WTB_RETAILERS.filter((r) => r.market === m && byRetailer.has(r.key))
      .map((r) => ` <li><a href="${escAttr(byRetailer.get(r.key))}" target="_blank">${escText(r.label)}</a></li>`);
    if (!items.length) continue;
    hasLink = true;
    blocks.push(`<p><strong>${market.heading}:</strong></p>\n<ul>\n${items.join('\n')}\n</ul>`);
  }
  return hasLink || (allowEmpty && site.locator) ? blocks.join('\n<p>&nbsp;</p>\n') : '';
}

/**
 * The sections to push to a site: the WHERE TO BUY section replaced (or
 * added at the end) and every other section exactly as Wix has it.
 * Returns null when there is nothing to write. `owned`: the PIM has a list
 * for the product, so a section with nothing to show is emptied (Canada:
 * the store locator alone) or removed (USA) instead of left as it was.
 */
export function withWhereToBuySection(sections, links, siteKey, { owned = false } = {}) {
  const html = buildWhereToBuyHtml(links, siteKey, { allowEmpty: owned });
  const list = (sections ?? []).map((s) => ({ title: s.title ?? '', description: s.description ?? '' }));
  const i = list.findIndex((s) => /where\s*to\s*buy/i.test(s.title));
  if (!html) {
    if (!owned || i < 0) return null;
    list.splice(i, 1);
    return list;
  }
  if (i >= 0) {
    // Wix stores the HTML with its own spacing between tags.
    const norm = (s) => s.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
    if (norm(list[i].description) === norm(html)) return null; // already up to date
    list[i] = { title: list[i].title || WTB_SECTION_TITLE, description: html };
  } else {
    list.push({ title: WTB_SECTION_TITLE, description: html });
  }
  return list;
}

/** The store links of a WHERE TO BUY section's HTML: [{ retailer, url, label }] (other links skipped). */
export function parseWhereToBuyHtml(html) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html ?? '')))) {
    const url = m[1].replace(/&amp;/g, '&').trim();
    const r = retailerForUrl(url);
    if (r) out.push({ retailer: r.key, url, label: m[2].replace(/<[^>]+>/g, '').trim() });
  }
  return out;
}
