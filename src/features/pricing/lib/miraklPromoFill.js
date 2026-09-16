// Fill a Mirakl "offers-import" promotions file (Home Depot USA, and any
// other Mirakl marketplace that hands out the same layout) from a PIM
// promotion. One header row of Mirakl offer columns, data from row 2:
//
//   sku                    OUR SKU (the shop SKU)
//   product-id             the marketplace's own id for the product (its
//                          alias); products without one are left out
//   price                  the BASE COST = the channel's regular cost in the PIM
//                          (`costField`, Home Depot USA: cost_usd_lowes_sod_bbb)
//   msrp and retail-price  the regular price (the channel's price field, MAP)
//   discount-retail-price  the promo price
//   discount-price         the PROMO COST (the channel's promoCostSlug in
//                          promotion_prices.promo_costs), empty when the
//                          list carries none
//   discount-start/end-date and discount-retail-price-start/end-date
//                          the market's promo window as Eastern-time stamps
//                          (2026-10-01T00:00:00.000-04:00 … T23:59:59.999)
//   quantity               1
//   state                  11
//   update-delete          "update"
// (Home Depot USA rules given by the user 2026-09-14.)

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

// Eastern-time offset for a calendar day: EDT (-04:00) from the second
// Sunday of March to the first Sunday of November, EST (-05:00) otherwise.
function etOffset(day) {
  const [y, m, d] = day.split('-').map(Number);
  const nthSunday = (month, n) => { const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + (n - 1) * 7; };
  const t = m * 100 + d;
  const dstStart = 3 * 100 + nthSunday(3, 2);
  const dstEnd = 11 * 100 + nthSunday(11, 1);
  return t >= dstStart && t < dstEnd ? '-04:00' : '-05:00';
}
// Home Depot's timestamps: 2026-09-11T00:00:00.000-04:00 / 2026-09-30T23:59:59.999-04:00
const startStamp = (day) => `${day}T00:00:00.000${etOffset(day)}`;
const endStamp = (day) => `${day}T23:59:59.999${etOffset(day)}`;

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
        retailPrice: row.indexOf('retail-price'),
        discountRetail: row.indexOf('discount-retail-price'),
        retailStart: row.indexOf('discount-retail-price-start-date'),
        retailEnd: row.indexOf('discount-retail-price-end-date'),
        discount,
        start: row.indexOf('discount-start-date'),
        end: row.indexOf('discount-end-date'),
        quantity: row.indexOf('quantity'),
        state: row.indexOf('state'),
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
    const cols = ['sku', 'map_usd', 'map_cad', 'msrp_usd', 'msrp_cad', channel.costField].filter(Boolean).join(', ');
    const { data } = await supabase.from('products').select(cols).in('sku', skus.slice(i, i + 100));
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
  const noAlias = [];
  let aliased = 0;
  for (const m of members) {
    if (channel.aliasMarketplace && !alias.has(m.sku)) { noAlias.push(m.sku); continue; }
    const p = pim.get(m.sku) ?? {};
    const regular = channel.priceField ? p[channel.priceField] : null;
    if (channel.priceField && regular == null) { noRegular.push(m.sku); continue; }
    if (regular != null && Number(m[priceKey]) >= Number(regular)) { atOrAbove.push(m.sku); continue; }
    if (alias.has(m.sku)) aliased += 1;
    lines.push({
      sku: m.sku,
      productId: alias.get(m.sku) ?? null,
      price: regular,
      baseCost: channel.costField ? p[channel.costField] ?? null : null,
      promoCost: channel.promoCostSlug ? m.promo_costs?.[channel.promoCostSlug] ?? null : null,
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
    put(cols.price, l.baseCost != null ? Number(l.baseCost) : null);
    put(cols.msrp, l.price != null ? Number(l.price) : null);
    put(cols.retailPrice, l.price != null ? Number(l.price) : null);
    put(cols.discountRetail, l.discount);
    put(cols.retailStart, startStamp(window.start));
    put(cols.retailEnd, endStamp(window.end));
    put(cols.discount, l.promoCost != null ? Number(l.promoCost) : null);
    put(cols.start, startStamp(window.start));
    put(cols.end, endStamp(window.end));
    put(cols.quantity, 1);
    put(cols.state, 11);
    put(cols.updateDelete, 'update');
    rowsXml += `<row r="${rn}">` + [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('') + '</row>';
  }
  zip.file(hit.path, injectRows(hit.xml, rowsXml, lastRow + lines.length));

  const period = String(promotion.period).slice(0, 7);
  await downloadZip(zip, `${channel.label.replace(/[^\w]+/g, '_')}_Promo_${period}`, templateExt(template.storage_path));

  const noPromoCost = lines.filter((l) => l.promoCost == null).length;
  const noBaseCost = channel.costField ? lines.filter((l) => l.baseCost == null).length : 0;
  const report = { rows: lines.length, aliased, noAlias, noRegular, atOrAbove, noPromoCost, noBaseCost, window, sheet: hit.name };
  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: channel.key,
    summary: `Filled ${channel.label} promotions file for "${promotion.name}" (${lines.length} offers)`,
    metadata: { template: template.file_name, rows: lines.length, noAlias: noAlias.length, noRegular: noRegular.length, atOrAbove: atOrAbove.length, window },
  });
  return report;
}

export function summarizeMiraklFill(channel, r) {
  const parts = [`${channel.label} file ready. ${r.rows} offers, ${startStamp(r.window.start)} to ${endStamp(r.window.end)}`];
  if (r.noPromoCost) parts.push(`${r.noPromoCost} rows without a promo cost (column U empty)`);
  if (r.noBaseCost) parts.push(`${r.noBaseCost} rows without the channel cost in the PIM (column F empty)`);
  if (r.noAlias.length) parts.push(`no ${channel.label} id on file, left out: ${r.noAlias.slice(0, 8).join(', ')}${r.noAlias.length > 8 ? ` and ${r.noAlias.length - 8} more` : ''}`);
  if (r.noRegular.length) parts.push(`no regular price in the PIM, left out: ${r.noRegular.slice(0, 8).join(', ')}${r.noRegular.length > 8 ? ` and ${r.noRegular.length - 8} more` : ''}`);
  if (r.atOrAbove.length) parts.push(`promo not below the regular price, left out: ${r.atOrAbove.slice(0, 8).join(', ')}`);
  return parts.join(' · ');
}
