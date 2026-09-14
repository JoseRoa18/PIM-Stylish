// Fill a Mirakl "offers-import" promotions file (Home Depot USA, and any
// other Mirakl marketplace that hands out the same layout) from a PIM
// promotion. One header row of Mirakl offer columns, data from row 2:
//
//   sku                    OUR SKU (the shop SKU)
//   product-id             the marketplace's own id for the product (the
//                          product's alias there), when it has one
//   price                  the regular selling price (the channel's price field)
//   msrp                   the MSRP, when the channel names one
//   discount-price         the promo price
//   discount-start-date    the market's promo window, YYYY-MM-DD
//   discount-end-date
//   update-delete          "update"
//
// Every other column is left EMPTY on purpose. Mirakl's Normal import mode
// blanks missing fields (quantity included — the Best Buy stock incident of
// 2026-08-28), so the file must be imported as a PARTIAL UPDATE in the
// marketplace portal; the summary says so every time.

import { supabase } from '@/lib/supabase';
import {
  openTemplate,
  listSheetNames,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  injectRows,
  downloadZip,
  templateExt,
  indexToCol,
} from '@/features/syndication/exports/templateFiller';
import { getPromotionPrices } from '@/features/pricing/api/promotions';
import { marketWindow } from '@/features/pricing/lib/promoCalendar';
import { logActivity } from '@/features/activity/api/activityLog';

const norm = (v) => String(v ?? '').trim().toLowerCase();

function locate(grid) {
  for (let r = 0; r < Math.min(10, grid.length); r++) {
    const row = (grid[r] ?? []).map(norm);
    const sku = row.indexOf('sku');
    const discount = row.indexOf('discount-price');
    if (sku === -1 || discount === -1) continue;
    return {
      headerRow: r,
      cols: {
        sku,
        productId: row.indexOf('product-id'),
        price: row.indexOf('price'),
        msrp: row.indexOf('msrp'),
        discount,
        start: row.indexOf('discount-start-date'),
        end: row.indexOf('discount-end-date'),
        updateDelete: row.indexOf('update-delete'),
      },
    };
  }
  return null;
}

/**
 * @param template  marketplace_templates row (purpose "promotions")
 * @param promotion promotions row
 * @param channel   PROMO_CHANNELS entry: market, priceField, msrpField, aliasMarketplace, label, key
 */
export async function fillMiraklPromoTemplate(template, promotion, channel) {
  const { zip, shared } = await openTemplate(template.storage_path);
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  let hit = null;
  for (const name of listSheetNames(workbookXml)) {
    const path = await sheetPathByName(zip, name);
    if (!path) continue;
    const xml = await zip.file(path).async('string');
    const grid = sheetToGrid(xml, shared);
    const loc = locate(grid);
    if (loc) { hit = { name, path, xml, grid, ...loc }; break; }
  }
  if (!hit) throw new Error(`No sheet in "${template.file_name}" has the Mirakl offer columns (sku, discount-price). Send me the file and I map it.`);
  if (hit.cols.start === -1 || hit.cols.end === -1) throw new Error('The file has no discount-start-date / discount-end-date columns.');

  const market = channel.market;
  const priceKey = market === 'us' ? 'promo_price_usd' : 'promo_price_cad';
  const prices = await getPromotionPrices(promotion.id);
  const members = prices.filter((r) => r[priceKey] != null);
  if (!members.length) throw new Error(`This promotion has no ${market === 'us' ? 'USD' : 'CAD'} promo prices loaded.`);
  const skus = members.map((r) => r.sku);

  const pim = new Map();
  for (let i = 0; i < skus.length; i += 100) {
    const { data } = await supabase.from('products').select('sku, map_usd, map_cad, msrp_usd, msrp_cad').in('sku', skus.slice(i, i + 100));
    for (const p of data ?? []) pim.set(p.sku, p);
  }
  const alias = new Map();
  if (channel.aliasMarketplace) {
    for (let i = 0; i < skus.length; i += 100) {
      const { data } = await supabase.from('product_aliases').select('sku, alias').eq('marketplace', channel.aliasMarketplace).in('sku', skus.slice(i, i + 100));
      for (const a of data ?? []) alias.set(a.sku, a.alias);
    }
  }

  const window = marketWindow(promotion.period, market);
  const { cols } = hit;
  const lines = [];
  const noRegular = [];
  const atOrAbove = [];
  let aliased = 0;
  for (const m of members) {
    const p = pim.get(m.sku) ?? {};
    const regular = channel.priceField ? p[channel.priceField] : null;
    if (channel.priceField && regular == null) { noRegular.push(m.sku); continue; }
    if (regular != null && Number(m[priceKey]) >= Number(regular)) { atOrAbove.push(m.sku); continue; }
    if (alias.has(m.sku)) aliased += 1;
    lines.push({
      sku: m.sku,
      productId: alias.get(m.sku) ?? null,
      price: regular,
      msrp: channel.msrpField ? p[channel.msrpField] ?? null : null,
      discount: Number(m[priceKey]),
    });
  }
  if (!lines.length) throw new Error('Nothing to write: no member has a promo price below its regular price.');

  // Data starts right under the header; any rows already there stay.
  let lastRow = hit.headerRow + 1;
  for (let i = hit.headerRow + 1; i < hit.grid.length; i++) if ((hit.grid[i] ?? []).some((v) => String(v ?? '').trim())) lastRow = i + 1;
  let rowsXml = '';
  for (const [idx, l] of lines.entries()) {
    const rn = lastRow + 1 + idx;
    const cells = new Map();
    const put = (c, v) => { if (c != null && c !== -1 && v != null && v !== '') cells.set(c + 1, buildCell(`${indexToCol(c + 1)}${rn}`, v)); };
    put(cols.sku, l.sku);
    put(cols.productId, l.productId);
    put(cols.price, l.price != null ? Number(l.price) : null);
    put(cols.msrp, l.msrp != null ? Number(l.msrp) : null);
    put(cols.discount, l.discount);
    put(cols.start, window.start);
    put(cols.end, window.end);
    put(cols.updateDelete, 'update');
    rowsXml += `<row r="${rn}">` + [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('') + '</row>';
  }
  zip.file(hit.path, injectRows(hit.xml, rowsXml, lastRow + lines.length));

  const period = String(promotion.period).slice(0, 7);
  await downloadZip(zip, `${channel.label.replace(/[^\w]+/g, '_')}_Promo_${period}`, templateExt(template.storage_path));

  const report = { rows: lines.length, aliased, noRegular, atOrAbove, window, sheet: hit.name };
  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: channel.key,
    summary: `Filled ${channel.label} promotions file for "${promotion.name}" (${lines.length} offers)`,
    metadata: { template: template.file_name, rows: lines.length, noRegular: noRegular.length, atOrAbove: atOrAbove.length, window },
  });
  return report;
}

export function summarizeMiraklFill(channel, r) {
  const parts = [`${channel.label} file ready. ${r.rows} offers, ${r.window.start} to ${r.window.end}, ${r.aliased} with the marketplace id in product-id. Import it in the portal as a PARTIAL UPDATE, never Normal, or quantities get blanked`];
  if (r.noRegular.length) parts.push(`no regular price in the PIM, left out: ${r.noRegular.slice(0, 8).join(', ')}${r.noRegular.length > 8 ? ` and ${r.noRegular.length - 8} more` : ''}`);
  if (r.atOrAbove.length) parts.push(`promo not below the regular price, left out: ${r.atOrAbove.slice(0, 8).join(', ')}`);
  return parts.join(' · ');
}
