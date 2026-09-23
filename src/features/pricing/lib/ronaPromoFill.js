// Fill Rona's promotions file from a PIM promotion. One sheet, header on row
// 1, thousands of pre-formatted empty rows underneath (dates, currency), so
// rows are filled in place keeping their styles. Layout and rules given by
// the user 2026-09-23:
//
//   A Beginning Date / B End Date   the promotion window (Canada calendar
//                                   or the promotion's own dates)
//   C Rona product #                the product's Rona alias
//   D Vendor part #                 our SKU, as is
//   E UPC                           the product's UPC
//   F SUPPLIER_NAME                 always "Stylish International Inc"
//   G SUPPLIER_ID                   always 550562
//   H Brand                         the product's brand (Stylish or Azuni)
//   I Product Description           the name on the alias (Rona's own title)
//   J Inventory                     0 for now (to be decided)
//   K Status                        empty
//   L REGULAR COST                  WC Blue  = cost_cad_rona_hd
//   M PROMO COST                    WC Orange for a monthly promotion, WC
//                                   Purple for a flash deal / special event;
//                                   a promo cost typed on the promotion's own
//                                   list (promo_costs.rona_hd_cad) wins
//   N Regular MSRP                  empty
//   O Regular MAP                   MAP Blue = map_cad
//   P Promo MSRP                    empty
//   Q Promo MAP                     MAP Blue = map_cad (Rona keeps the MAP)
//   R Var                           formula =M-L
//   S Var %                         formula =M/L-1

import { supabase } from '@/lib/supabase';
import {
  openTemplate,
  listSheetNames,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  buildFormulaCell,
  excelSerial,
  mergeRows,
  injectRows,
  downloadZip,
  templateExt,
  indexToCol,
  norm,
} from '@/features/syndication/exports/templateFiller';
import { promotionMembersFor } from '@/features/pricing/api/promotions';
import { promoWindow } from '@/features/pricing/lib/promoCalendar';
import { logActivity } from '@/features/activity/api/activityLog';

export const RONA_SUPPLIER = { name: 'Stylish International Inc', id: '550562' };

const HEADERS = {
  start: /^beginningdate|^startdate/,
  end: /^enddate/,
  ronaId: /^ronaproduct|^ronaid|^ronasku/,
  part: /^vendorpart|^partnumber|^vendorsku/,
  upc: /^upc$/,
  supplierName: /^suppliername/,
  supplierId: /^supplierid/,
  brand: /^brand$/,
  description: /^productdescription/,
  inventory: /^inventory/,
  regularCost: /^regularcost/,
  promoCost: /^promocost/,
  regularMap: /^regularmap/,
  promoMap: /^promomap/,
  varAmount: /^var$/,
  varPct: /^var(percent|pct|%)?$|^varpercent/,
};

function locate(grid) {
  for (let r = 0; r < Math.min(10, grid.length); r++) {
    const row = (grid[r] ?? []).map((v) => norm(v ?? ''));
    const cols = {};
    for (const [key, re] of Object.entries(HEADERS)) {
      const idx = row.findIndex((h, i) => h && re.test(h) && !Object.values(cols).includes(i));
      if (idx !== -1) cols[key] = idx;
    }
    if (cols.ronaId != null && cols.promoCost != null) return { headerRow: r, cols };
  }
  return null;
}

/**
 * @param template  marketplace_templates row (Rona, purpose "promotions" or "flash_deals")
 * @param promotion promotions row (kind decides the WC level: monthly → Orange, else Purple)
 * @param channel   PROMO_CHANNELS entry for Rona (key, label, market 'ca')
 */
export async function fillRonaPromoTemplate(template, promotion, channel) {
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
  if (!hit) throw new Error(`No sheet in "${template.file_name}" has the Rona columns (Rona product #, PROMO COST). Send me the file and I map it.`);

  const tier = (promotion.kind ?? 'monthly') === 'monthly' ? 'orange' : 'purple';
  const promoCostField = `cost_cad_rona_hd_${tier}`;
  const { rows: members, excluded } = await promotionMembersFor(promotion, channel.key);
  if (!members.length) throw new Error('This promotion has no products.');
  const skus = members.map((r) => r.sku);

  const pim = new Map();
  const alias = new Map();
  for (let i = 0; i < skus.length; i += 100) {
    const chunk = skus.slice(i, i + 100);
    const [{ data: prods, error: pErr }, { data: aliases, error: aErr }] = await Promise.all([
      supabase.from('products').select(`sku, brand, map_cad, cost_cad_rona_hd, ${promoCostField}, attributes`).in('sku', chunk),
      supabase.from('product_aliases').select('sku, alias, listing_title').eq('marketplace', 'Rona').in('sku', chunk),
    ]);
    if (pErr) throw pErr;
    if (aErr) throw aErr;
    for (const p of prods ?? []) pim.set(p.sku, p);
    for (const a of aliases ?? []) alias.set(a.sku, a);
  }

  const window = promoWindow(promotion, 'ca');
  const lines = [];
  const noAlias = [];
  const noName = [];
  const noUpc = [];
  const noRegularCost = [];
  const noPromoCost = [];
  const atOrAbove = [];
  let fromList = 0;
  for (const m of members) {
    const a = alias.get(m.sku);
    if (!a) { noAlias.push(m.sku); continue; }
    const p = pim.get(m.sku) ?? {};
    const regularCost = p.cost_cad_rona_hd != null ? Number(p.cost_cad_rona_hd) : null;
    const listed = m.promo_costs?.rona_hd_cad;
    const promoCost = listed != null ? Number(listed) : p[promoCostField] != null ? Number(p[promoCostField]) : null;
    if (regularCost == null) { noRegularCost.push(m.sku); continue; }
    if (promoCost == null) { noPromoCost.push(m.sku); continue; }
    if (promoCost >= regularCost) { atOrAbove.push(m.sku); continue; }
    if (listed != null) fromList += 1;
    if (!a.listing_title) noName.push(m.sku);
    const upc = String(p.attributes?.upc ?? '').trim();
    if (!upc) noUpc.push(m.sku);
    lines.push({
      sku: m.sku,
      ronaId: a.alias,
      name: a.listing_title ?? null,
      upc: upc || null,
      brand: p.brand ?? null,
      regularCost,
      promoCost,
      map: p.map_cad != null ? Number(p.map_cad) : null,
    });
  }
  if (!lines.length) throw new Error('Nothing to write: no product has a Rona id with a promo cost below its regular cost.');

  // Rows already carrying a Rona id stay; ours go on the first empty rows
  // after them (the template ships thousands of pre-formatted empty rows).
  const { cols } = hit;
  let lastUsed = hit.headerRow;
  for (let i = hit.headerRow + 1; i < hit.grid.length; i++) if ((hit.grid[i] ?? []).some((v) => String(v ?? '').trim())) lastUsed = i;
  const firstRow = lastUsed + 2; // 1-based row number of the first line we write
  const existingRows = new Set([...hit.xml.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1])));

  // Every line takes the formatting of the template's first empty row (the
  // file is only fully formatted for its first hundred-odd rows). The regular
  // cost has no format of its own there, so it borrows the promo cost's.
  const styles = new Map();
  const modelRow = hit.xml.match(new RegExp(`<row r="${hit.headerRow + 2}"[^>]*>[\\s\\S]*?</row>`))?.[0] ?? '';
  for (const m of modelRow.matchAll(/<c r="([A-Z]+)\d+"[^>]*?\ss="(\d+)"/g)) styles.set(m[1], m[2]);
  if (cols.regularCost != null && cols.promoCost != null && !styles.has(indexToCol(cols.regularCost + 1))) {
    const promoStyle = styles.get(indexToCol(cols.promoCost + 1));
    if (promoStyle) styles.set(indexToCol(cols.regularCost + 1), promoStyle);
  }

  const cellsByRow = new Map();
  let appended = '';
  for (const [idx, l] of lines.entries()) {
    const rn = firstRow + idx;
    const cells = new Map();
    const put = (c, v) => { if (c != null && v != null && v !== '') cells.set(c + 1, buildCell(`${indexToCol(c + 1)}${rn}`, v, styles.get(indexToCol(c + 1)) ?? null)); };
    const formula = (c, f) => { if (c != null) cells.set(c + 1, buildFormulaCell(`${indexToCol(c + 1)}${rn}`, f, styles.get(indexToCol(c + 1)) ?? null)); };
    const col = (c) => indexToCol(c + 1);
    put(cols.start, excelSerial(window.start));
    put(cols.end, excelSerial(window.end));
    put(cols.ronaId, l.ronaId);
    put(cols.part, l.sku);
    put(cols.upc, l.upc);
    put(cols.supplierName, RONA_SUPPLIER.name);
    put(cols.supplierId, RONA_SUPPLIER.id);
    put(cols.brand, l.brand);
    put(cols.description, l.name);
    put(cols.inventory, 0);
    put(cols.regularCost, l.regularCost);
    put(cols.promoCost, l.promoCost);
    put(cols.regularMap, l.map);
    put(cols.promoMap, l.map);
    if (cols.promoCost != null && cols.regularCost != null) {
      formula(cols.varAmount, `${col(cols.promoCost)}${rn}-${col(cols.regularCost)}${rn}`);
      formula(cols.varPct, `${col(cols.promoCost)}${rn}/${col(cols.regularCost)}${rn}-1`);
    }
    if (existingRows.has(rn)) cellsByRow.set(rn, cells);
    else appended += `<row r="${rn}">` + [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('') + '</row>';
  }
  let xml = cellsByRow.size ? mergeRows(hit.xml, cellsByRow, true) : hit.xml;
  if (appended) xml = injectRows(xml, appended, firstRow + lines.length - 1);
  zip.file(hit.path, xml);

  const period = String(promotion.period).slice(0, 7);
  await downloadZip(zip, `Rona_Promo_${period}`, templateExt(template.storage_path));

  const report = { rows: lines.length, tier, fromList, noAlias, noName, noUpc, noRegularCost, noPromoCost, atOrAbove, excluded, window, sheet: hit.name };
  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: channel.key,
    summary: `Filled Rona promotions file for "${promotion.name}" (${lines.length} products, WC ${tier})`,
    metadata: { template: template.file_name, rows: lines.length, tier, noAlias: noAlias.length, noName: noName.length, noUpc: noUpc.length, noRegularCost: noRegularCost.length, noPromoCost: noPromoCost.length, atOrAbove: atOrAbove.length, window },
  });
  return report;
}

const few = (list, n = 8) => `${list.slice(0, n).join(', ')}${list.length > n ? ` and ${list.length - n} more` : ''}`;

export function summarizeRonaFill(channel, r) {
  const parts = [`${channel.label} file ready. ${r.rows} products, ${r.window.start} to ${r.window.end}, promo cost = WC ${r.tier === 'orange' ? 'Orange' : 'Purple'}${r.fromList ? ` (${r.fromList} from the promotion's own list)` : ''}`];
  if (r.noAlias.length) parts.push(`no Rona id in Aliases, left out: ${few(r.noAlias)}`);
  if (r.noRegularCost.length) parts.push(`no WC Rona / Home Depot in the PIM, left out: ${few(r.noRegularCost)}`);
  if (r.noPromoCost.length) parts.push(`no WC ${r.tier === 'orange' ? 'Orange' : 'Purple'} in the PIM, left out: ${few(r.noPromoCost)}`);
  if (r.atOrAbove.length) parts.push(`promo cost not below the regular cost, left out: ${few(r.atOrAbove)}`);
  if (r.noName.length) parts.push(`${r.noName.length} without a Rona name (column I empty): ${few(r.noName, 5)}`);
  if (r.noUpc.length) parts.push(`${r.noUpc.length} without UPC (column E empty): ${few(r.noUpc, 5)}`);
  if (r.excluded?.length) parts.push(`${r.excluded.length} excluded from ${channel.label}: ${few(r.excluded)}`);
  return parts.join(' · ');
}
