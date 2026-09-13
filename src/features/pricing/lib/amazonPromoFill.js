// Fill Amazon's promotions template (Seller Central flat file) from a PIM
// promotion. The workbook carries several sheets; the data goes on the sheet
// named "Template", whose header block has a display-name row ("Sale Price
// CAD (Sell on Amazon, CA)") and, right under it, the technical field names
// (sale_price, sale_from_date…). Rows start after that block.
//
// Amazon does not know our SKUs: column A takes the SELLER SKU of the offer
// (S-300XG-CAN, 3P-LVMJ-40J0…), stored per marketplace in amazon_links. One
// product can have several offers (FBA + FBM, legacy codes) — every offer
// gets the promo. Filled per row: seller SKU, sale price in the market's
// currency, sale start and sale end = the market's promo window.

import { supabase } from '@/lib/supabase';
import {
  openTemplate,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  mergeRows,
  injectRows,
  downloadZip,
  templateExt,
  indexToCol,
} from '@/features/syndication/exports/templateFiller';
import { getPromotionPrices } from '@/features/pricing/api/promotions';
import { marketWindow } from '@/features/pricing/lib/promoCalendar';
import { logActivity } from '@/features/activity/api/activityLog';

const HEADER_SCAN_ROWS = 12;
const text = (v) => String(v ?? '').trim();
const lower = (v) => text(v).toLowerCase();

// The display-name row names the columns; the technical row confirms where
// the data starts.
function locate(grid) {
  for (let r = 0; r < Math.min(HEADER_SCAN_ROWS, grid.length); r++) {
    const row = (grid[r] ?? []).map(lower);
    const price = row.findIndex((h) => /sale price/.test(h) && !/date/.test(h));
    if (price === -1) continue;
    const start = row.findIndex((h) => /sale (start|from) date/.test(h));
    const end = row.findIndex((h) => /sale end date/.test(h));
    const skuIdx = row.findIndex((h) => /^(seller )?sku$/.test(h) || /^sku \(/.test(h));
    // Row under the display names: Amazon's technical field names
    // (contribution_sku#1.value, purchasable_offer[...]...). Then Amazon's
    // example row ("ABC123"), which stays exactly as it is (rule 2026-09-13):
    // our rows go below it.
    const next = (grid[r + 1] ?? []).map(lower);
    const technical = next.some((h) => /^(item_sku|sku|sale_price|sale_from_date)$|contribution_sku|purchasable_offer|#1\.value$/.test(h));
    return { headerRow: r, dataStart: r + (technical ? 2 : 1), cols: { sku: skuIdx === -1 ? 0 : skuIdx, price, start, end } };
  }
  return null;
}

/**
 * @param template  marketplace_templates row (Amazon, purpose "promotions")
 * @param promotion promotions row
 * @param channel   PROMO_CHANNELS entry: market 'ca' | 'us'
 */
export async function fillAmazonPromoTemplate(template, promotion, channel) {
  const { zip, shared } = await openTemplate(template.storage_path);
  const path = await sheetPathByName(zip, 'Template');
  if (!path) throw new Error('No "Template" sheet in this file. Upload Amazon\'s promotions flat file.');
  const xml = await zip.file(path).async('string');
  const grid = sheetToGrid(xml, shared);
  const loc = locate(grid);
  if (!loc) throw new Error('No "Sale Price" column found on the Template sheet. Send me the file and I map it.');
  if (loc.cols.start === -1 || loc.cols.end === -1) {
    throw new Error('The Template sheet has no Sale Start Date / Sale End Date columns next to Sale Price.');
  }

  const market = channel.market;
  const priceKey = market === 'us' ? 'promo_price_usd' : 'promo_price_cad';
  const prices = await getPromotionPrices(promotion.id);
  const members = prices.filter((r) => r[priceKey] != null);
  if (!members.length) throw new Error(`This promotion has no ${market === 'us' ? 'USD' : 'CAD'} promo prices loaded.`);
  const priceBySku = new Map(members.map((r) => [r.sku, r[priceKey]]));

  // Every Amazon offer of every member: seller SKU → promo price. Amazon USA
  // lists our products under the PIM SKU itself; Canada needs the alias.
  const offers = [];
  const skus = members.map((r) => r.sku);
  if (channel.sellerSku === 'pim') {
    for (const r of members) offers.push({ seller: r.sku, sku: r.sku, price: r[priceKey] });
  } else {
    for (let i = 0; i < skus.length; i += 100) {
      const { data, error } = await supabase
        .from('amazon_links')
        .select('sku, seller_sku')
        .eq('marketplace', market)
        .in('sku', skus.slice(i, i + 100));
      if (error) throw error;
      for (const l of data ?? []) offers.push({ seller: l.seller_sku, sku: l.sku, price: priceBySku.get(l.sku) });
    }
  }
  const withOffer = new Set(offers.map((o) => o.sku));
  const noOffer = skus.filter((s) => !withOffer.has(s)).sort();
  if (!offers.length) {
    throw new Error(`None of the promotion's products has an Amazon ${market.toUpperCase()} seller SKU on file. Load the seller SKU list first.`);
  }
  offers.sort((a, b) => a.seller.localeCompare(b.seller));

  const window = marketWindow(promotion.period, market);
  const { sku: skuCol, price: priceCol, start: startCol, end: endCol } = loc.cols;
  const cellsFor = (rn, o) => new Map([
    [skuCol + 1, buildCell(`${indexToCol(skuCol + 1)}${rn}`, o.seller)],
    [priceCol + 1, buildCell(`${indexToCol(priceCol + 1)}${rn}`, Number(o.price))],
    [startCol + 1, buildCell(`${indexToCol(startCol + 1)}${rn}`, window.start)],
    [endCol + 1, buildCell(`${indexToCol(endCol + 1)}${rn}`, window.end)],
  ]);

  // Rows already on the sheet (a file that came back from Amazon with
  // offers listed): fill matching seller SKUs in place; append the rest.
  // Amazon's example row (SKU "ABC123") is left untouched and our rows start
  // right below it.
  const bySeller = new Map(offers.map((o) => [o.seller, o]));
  const cellsByRow = new Map();
  const onSheet = new Set();
  let lastRow = loc.dataStart; // 1-based row number of the last used row
  for (let i = loc.dataStart; i < grid.length; i++) {
    const seller = text(grid[i]?.[skuCol]);
    if (!seller) continue;
    lastRow = i + 1;
    if (/^abc123$/i.test(seller)) continue; // Amazon's example, kept as is
    onSheet.add(seller);
    const o = bySeller.get(seller);
    if (o) cellsByRow.set(i + 1, cellsFor(i + 1, o));
  }
  let merged = cellsByRow.size ? mergeRows(xml, cellsByRow) : xml;
  const rowXml = (rn, o) => `<row r="${rn}">` + [...cellsFor(rn, o).entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('') + '</row>';
  const toAppend = offers.filter((o) => !onSheet.has(o.seller));
  if (toAppend.length) {
    let rowsXml = '';
    for (const [idx, o] of toAppend.entries()) rowsXml += rowXml(lastRow + 1 + idx, o);
    merged = injectRows(merged, rowsXml, lastRow + toAppend.length);
  }
  zip.file(path, merged);

  const period = String(promotion.period).slice(0, 7);
  await downloadZip(zip, `Amazon_${market.toUpperCase()}_Promo_${period}`, templateExt(template.storage_path));

  const report = {
    offers: offers.length,
    products: withOffer.size,
    filled: cellsByRow.size,
    appended: toAppend.length,
    noOffer,
    window,
    columns: { sku: indexToCol(skuCol + 1), price: indexToCol(priceCol + 1), start: indexToCol(startCol + 1), end: indexToCol(endCol + 1) },
  };
  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: channel.key,
    summary: `Filled Amazon ${market.toUpperCase()} promotions file for "${promotion.name}" (${offers.length} offers, ${withOffer.size} products)`,
    metadata: { template: template.file_name, ...report, noOffer: noOffer.length },
  });
  return report;
}

export function summarizeAmazonFill(channel, r) {
  const parts = [`${channel.label} file ready. ${r.offers} offers for ${r.products} products, ${r.window.start} to ${r.window.end}`];
  if (r.filled) parts.push(`${r.filled} rows filled in place, ${r.appended} added`);
  if (r.noOffer.length) parts.push(`no Amazon seller SKU on file: ${r.noOffer.slice(0, 10).join(', ')}${r.noOffer.length > 10 ? ` and ${r.noOffer.length - 10} more` : ''}`);
  return parts.join(' · ');
}
