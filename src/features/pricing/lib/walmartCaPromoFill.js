// Fill Walmart Canada's PRICE_AND_PROMOTION file (Seller Center spec
// "price-mp", multilocale) from a PIM promotion. Sheet "Price": A1 holds
// the spec version, labels on row 4, attribute XML names on row 5 (the
// stable key), field descriptions on row 6, data from row 7 (the file ships
// one sample row there, which is overwritten). Rules given by the user
// 2026-09-23:
//
//   sku                             the product's Walmart Canada alias, or
//                                   our SKU when it has none
//   msrp                            MAP Blue (map_cad)
//   price (Selling Price)           MAP Blue (map_cad)
//   promotionSettingAction          "Create" (closed list: Create / Delete /
//                                   Replace All)
//   promotionType                   left empty
//   promotionPrice                  MAP Orange for a monthly promotion, MAP
//                                   Purple for a flash deal / special event;
//                                   a promo price on the promotion's own list
//                                   (promo_price_cad) wins
//   promotionPriceStartDateTime     first day 00:00:00 (Excel date-time,
//   promotionPriceEndDateTime       last day 23:59:59  formatted
//                                   yyyy-mm-dd hh:mm:ss like the file's own)

import { supabase } from '@/lib/supabase';
import {
  openTemplate,
  listSheetNames,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  excelSerial,
  mergeRows,
  injectRows,
  downloadZip,
  templateExt,
  indexToCol,
} from '@/features/syndication/exports/templateFiller';
import { promotionMembersFor } from '@/features/pricing/api/promotions';
import { promoWindow } from '@/features/pricing/lib/promoCalendar';
import { logActivity } from '@/features/activity/api/activityLog';

const ACTION = 'Create';
const norm = (v) => String(v ?? '').trim().toLowerCase();

// Walmart's flash-deal upload ("DEAL_ITEM.xlsx"): sheet "Upload Template",
// row 1 section titles, row 2 headers, data from row 3. Only A and B are
// ours: SKU and Promo Price; Suggested / Comparison / Promo Referral Price
// stay empty (rules given by the user 2026-09-23).
function locateDeal(grid) {
  for (let r = 0; r < Math.min(12, grid.length); r++) {
    const row = (grid[r] ?? []).map(norm);
    const sku = row.findIndex((h) => /^sku\b/.test(h));
    const promo = row.findIndex((h) => /^promo ?price\b/.test(h));
    if (sku !== -1 && promo !== -1) return { headerRow: r, dataStart: r + 1, cols: { sku, promo } };
  }
  return null;
}

function locate(grid) {
  for (let r = 0; r < Math.min(12, grid.length); r++) {
    const row = (grid[r] ?? []).map(norm);
    const sku = row.indexOf('sku');
    const promo = row.indexOf('promotionprice');
    if (sku === -1 || promo === -1) continue;
    // Row 6 describes each field ("Decimal, Value range…"); data starts after it.
    const next = (grid[r + 1] ?? []).map(norm);
    const described = next.some((v) => /^(alphanumeric|decimal|datetime|closed list)/.test(v));
    return {
      xmlRow: r,
      dataStart: r + (described ? 2 : 1),
      cols: {
        sku,
        msrp: row.indexOf('msrp'),
        price: row.indexOf('price'),
        action: row.indexOf('promotionsettingaction'),
        type: row.indexOf('promotiontype'),
        promo,
        start: row.indexOf('promotionpricestartdatetime'),
        end: row.indexOf('promotionpriceenddatetime'),
      },
    };
  }
  return null;
}

/**
 * @param template  marketplace_templates row (Walmart CA, purpose "promotions" or "flash_deals")
 * @param promotion promotions row (kind decides the MAP level: monthly → Orange, else Purple)
 * @param channel   PROMO_CHANNELS entry for Walmart Canada
 */
export async function fillWalmartCaPromoTemplate(template, promotion, channel) {
  const { zip, shared } = await openTemplate(template.storage_path);
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  let hit = null;
  let deal = null;
  for (const name of listSheetNames(workbookXml)) {
    const path = await sheetPathByName(zip, name);
    if (!path) continue;
    const xml = await zip.file(path).async('string');
    const grid = sheetToGrid(xml, shared);
    if (/^hidden/i.test(name)) continue;
    const loc = locate(grid);
    if (loc) { hit = { name, path, xml, grid, ...loc }; break; }
    const d = locateDeal(grid);
    if (d) { deal = { name, path, xml, grid, ...d }; break; }
  }
  if (deal) return fillDealFile(zip, deal, template, promotion, channel);
  if (!hit) throw new Error(`No sheet in "${template.file_name}" has the Walmart price columns (sku, promotionPrice) or the deal columns (SKU, Promo Price). Send me the file and I map it.`);
  const { cols } = hit;
  if (cols.start === -1 || cols.end === -1) throw new Error('The file has no promotionPriceStartDateTime / promotionPriceEndDateTime columns.');

  const tier = (promotion.kind ?? 'monthly') === 'monthly' ? 'orange' : 'purple';
  const tierLabel = tier === 'orange' ? 'Orange' : 'Purple';
  const promoMapField = `map_${tier}_cad`;
  const { rows: members, excluded } = await promotionMembersFor(promotion, 'walmart_ca');
  if (!members.length) throw new Error('This promotion has no products.');
  const skus = members.map((m) => m.sku);

  const pim = new Map();
  const alias = new Map();
  for (let i = 0; i < skus.length; i += 100) {
    const chunk = skus.slice(i, i + 100);
    const [{ data: prods, error: pErr }, { data: aliases, error: aErr }] = await Promise.all([
      supabase.from('products').select(`sku, map_cad, ${promoMapField}`).in('sku', chunk),
      supabase.from('product_aliases').select('sku, alias').eq('marketplace', 'Walmart CA').in('sku', chunk),
    ]);
    if (pErr) throw pErr;
    if (aErr) throw aErr;
    for (const p of prods ?? []) pim.set(p.sku, p);
    for (const a of aliases ?? []) alias.set(a.sku, a.alias);
  }

  const window = promoWindow(promotion, 'ca');
  const lines = [];
  const noMap = [];
  const noPromo = [];
  const atOrAbove = [];
  let aliased = 0;
  let fromList = 0;
  for (const m of members) {
    const p = pim.get(m.sku) ?? {};
    const map = p.map_cad != null ? Number(p.map_cad) : null;
    const promo = m.promo_price_cad != null ? Number(m.promo_price_cad) : p[promoMapField] != null ? Number(p[promoMapField]) : null;
    if (map == null) { noMap.push(m.sku); continue; }
    if (promo == null) { noPromo.push(m.sku); continue; }
    if (promo >= map) { atOrAbove.push(m.sku); continue; }
    if (m.promo_price_cad != null) fromList += 1;
    if (alias.has(m.sku)) aliased += 1;
    lines.push({ sku: m.sku, walmartSku: alias.get(m.sku) ?? m.sku, map, promo });
  }
  if (!lines.length) throw new Error(`Nothing to write: no product has a MAP ${tierLabel} below its MAP.`);

  // Styles of the file's own sample row (text action, date-time cells).
  const styles = new Map();
  const sample = hit.xml.match(new RegExp(`<row r="${hit.dataStart + 1}"[^>]*>[\\s\\S]*?</row>`))?.[0] ?? '';
  for (const m of sample.matchAll(/<c r="([A-Z]+)\d+"[^>]*?\ss="(\d+)"/g)) styles.set(m[1], m[2]);
  const startCol = indexToCol(cols.start + 1);
  const endCol = indexToCol(cols.end + 1);
  if (styles.has(startCol) && !styles.has(endCol)) styles.set(endCol, styles.get(startCol));
  const style = (c) => styles.get(indexToCol(c + 1)) ?? null;

  const existingRows = new Set([...hit.xml.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1])));
  const startSerial = excelSerial(window.start);
  const endSerial = excelSerial(window.end) + (23 * 3600 + 59 * 60 + 59) / 86400;
  const cellsByRow = new Map();
  let appended = '';
  for (const [idx, l] of lines.entries()) {
    const rn = hit.dataStart + 1 + idx; // 1-based sheet row
    const cells = new Map();
    const put = (c, v) => { if (c != null && c !== -1 && v != null && v !== '') cells.set(c + 1, buildCell(`${indexToCol(c + 1)}${rn}`, v, style(c))); };
    put(cols.sku, l.walmartSku);
    put(cols.msrp, l.map);
    put(cols.price, l.map);
    put(cols.action, ACTION);
    put(cols.promo, l.promo);
    put(cols.start, startSerial);
    put(cols.end, endSerial);
    if (existingRows.has(rn)) {
      // The sample row: every cell it had is replaced, the type stays empty.
      cellsByRow.set(rn, cells);
    } else {
      appended += `<row r="${rn}">` + [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('') + '</row>';
    }
  }
  let xml = hit.xml;
  if (cellsByRow.size) {
    // Drop the sample row's leftover cells (its promo type, if any) before merging ours.
    for (const rn of cellsByRow.keys()) {
      xml = xml.replace(new RegExp(`(<row r="${rn}"[^>]*>)[\\s\\S]*?(</row>)`), '$1$2');
    }
    xml = mergeRows(xml, cellsByRow, false);
  }
  if (appended) xml = injectRows(xml, appended, hit.dataStart + lines.length);
  zip.file(hit.path, xml);

  const period = String(promotion.period).slice(0, 7);
  await downloadZip(zip, `Walmart_Canada_Promo_${period}`, templateExt(template.storage_path));

  const report = { rows: lines.length, tier, tierLabel, aliased, fromList, noMap, noPromo, atOrAbove, excluded, window, sheet: hit.name };
  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: channel.key,
    summary: `Filled Walmart Canada promotions file for "${promotion.name}" (${lines.length} products, MAP ${tierLabel})`,
    metadata: { template: template.file_name, rows: lines.length, tier, aliased, noMap: noMap.length, noPromo: noPromo.length, atOrAbove: atOrAbove.length, window },
  });
  return report;
}

// The deal file: one row per product, SKU + promo price, nothing else.
async function fillDealFile(zip, hit, template, promotion, channel) {
  const tier = (promotion.kind ?? 'monthly') === 'monthly' ? 'orange' : 'purple';
  const tierLabel = tier === 'orange' ? 'Orange' : 'Purple';
  const promoMapField = `map_${tier}_cad`;
  const { rows: members, excluded } = await promotionMembersFor(promotion, 'walmart_ca');
  if (!members.length) throw new Error('This promotion has no products.');
  const skus = members.map((m) => m.sku);

  const pim = new Map();
  const alias = new Map();
  for (let i = 0; i < skus.length; i += 100) {
    const chunk = skus.slice(i, i + 100);
    const [{ data: prods, error: pErr }, { data: aliases, error: aErr }] = await Promise.all([
      supabase.from('products').select(`sku, map_cad, ${promoMapField}`).in('sku', chunk),
      supabase.from('product_aliases').select('sku, alias').eq('marketplace', 'Walmart CA').in('sku', chunk),
    ]);
    if (pErr) throw pErr;
    if (aErr) throw aErr;
    for (const p of prods ?? []) pim.set(p.sku, p);
    for (const a of aliases ?? []) alias.set(a.sku, a.alias);
  }

  const window = promoWindow(promotion, 'ca');
  const lines = [];
  const noMap = [];
  const noPromo = [];
  const atOrAbove = [];
  let aliased = 0;
  let fromList = 0;
  for (const m of members) {
    const p = pim.get(m.sku) ?? {};
    const map = p.map_cad != null ? Number(p.map_cad) : null;
    const promo = m.promo_price_cad != null ? Number(m.promo_price_cad) : p[promoMapField] != null ? Number(p[promoMapField]) : null;
    if (promo == null) { noPromo.push(m.sku); continue; }
    if (map == null) { noMap.push(m.sku); continue; }
    if (promo >= map) { atOrAbove.push(m.sku); continue; }
    if (m.promo_price_cad != null) fromList += 1;
    if (alias.has(m.sku)) aliased += 1;
    lines.push({ sku: m.sku, walmartSku: alias.get(m.sku) ?? m.sku, promo });
  }
  if (!lines.length) throw new Error(`Nothing to write: no product has a MAP ${tierLabel} below its MAP.`);

  const { cols } = hit;
  let lastUsed = hit.headerRow;
  for (let i = hit.headerRow + 1; i < hit.grid.length; i++) if ((hit.grid[i] ?? []).some((v) => String(v ?? '').trim())) lastUsed = i;
  let rowsXml = '';
  for (const [idx, l] of lines.entries()) {
    const rn = lastUsed + 2 + idx;
    rowsXml += `<row r="${rn}">` + buildCell(`${indexToCol(cols.sku + 1)}${rn}`, l.walmartSku) + buildCell(`${indexToCol(cols.promo + 1)}${rn}`, l.promo) + '</row>';
  }
  zip.file(hit.path, injectRows(hit.xml, rowsXml, lastUsed + 1 + lines.length));

  const period = String(promotion.period).slice(0, 7);
  await downloadZip(zip, `Walmart_Canada_Deal_${period}`, templateExt(template.storage_path));

  const report = { deal: true, rows: lines.length, tier, tierLabel, aliased, fromList, noMap, noPromo, atOrAbove, excluded, window, sheet: hit.name };
  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: channel.key,
    summary: `Filled Walmart Canada deal file for "${promotion.name}" (${lines.length} products, MAP ${tierLabel})`,
    metadata: { template: template.file_name, rows: lines.length, tier, aliased, noMap: noMap.length, noPromo: noPromo.length, atOrAbove: atOrAbove.length, window },
  });
  return report;
}

const few = (list, n = 8) => `${list.slice(0, n).join(', ')}${list.length > n ? ` and ${list.length - n} more` : ''}`;

export function summarizeWalmartCaFill(channel, r) {
  const parts = [r.deal
    ? `${channel.label} deal file ready. ${r.rows} products (SKU + promo price = MAP ${r.tierLabel}${r.fromList ? `, ${r.fromList} from the promotion's own list` : ''}), ${r.aliased} under their Walmart SKU. The dates go in the portal: ${r.window.start} to ${r.window.end}`
    : `${channel.label} file ready. ${r.rows} products, ${r.window.start} 00:00:00 to ${r.window.end} 23:59:59, promo price = MAP ${r.tierLabel}${r.fromList ? ` (${r.fromList} from the promotion's own list)` : ''}, ${r.aliased} under their Walmart SKU`];
  if (r.noMap.length) parts.push(`no MAP CAD in the PIM, left out: ${few(r.noMap)}`);
  if (r.noPromo.length) parts.push(`no MAP ${r.tierLabel} in the PIM, left out: ${few(r.noPromo)}`);
  if (r.atOrAbove.length) parts.push(`promo not below the MAP, left out: ${few(r.atOrAbove)}`);
  if (r.excluded?.length) parts.push(`${r.excluded.length} excluded from ${channel.label}: ${few(r.excluded)}`);
  return parts.join(' · ');
}
