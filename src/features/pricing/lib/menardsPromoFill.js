// Fill Menards' promotion file from a PIM promotion. The file comes from
// Menards (uploaded here, handed back filled): every row already carries our
// SKU, and only three columns are ours to write (rules given by the user
// 2026-09-23):
//
//   F  MAP of the promo level   MAP Orange for a monthly promotion, MAP
//                               Purple for a flash deal / special event
//   G  WC Menards of the level  cost_usd_menards_orange / _purple
//   H  MAP of the promo level   same value as F
//
// A promo price / promo cost typed on the promotion's own list
// (promo_price_usd, promo_costs.menards_usd) wins over the product's level.
//
// Every row of the file stays (rule of the user 2026-09-23): products in the
// promotion get the level's prices, products OUTSIDE the promotion get the
// Blue prices (map_usd, cost_usd_menards), promotion members missing from
// the file are reported, and F/G/H are overwritten whatever they held. Before anything is written, the file is analyzed: rows
// whose product has no MAP (or no WC) of that level are listed, and the person
// decides what their rows get: nothing (left as they came), the Blue prices
// (map_usd and cost_usd_menards), or taken out of the returned file. Rows are
// matched on the column that holds our SKUs (found by content, not by
// header), so the layout can change.

import { supabase } from '@/lib/supabase';
import {
  loadJSZip,
  parseSharedStrings,
  listSheetNames,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  mergeRows,
  removeRows,
  downloadZip,
  indexToCol,
} from '@/features/syndication/exports/templateFiller';
import { promotionMembersFor } from '@/features/pricing/api/promotions';
import { logActivity } from '@/features/activity/api/activityLog';

// 0-based columns Menards reserves for us: F, G, H.
export const MENARDS_COLUMNS = { map: 5, cost: 6, map2: 7 };

async function openFile(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const sharedFile = zip.file('xl/sharedStrings.xml');
  const shared = parseSharedStrings(sharedFile ? await sharedFile.async('string') : '');
  return { zip, shared };
}

// The sheet and column carrying our SKUs: the column with the most cells
// that are PIM SKUs, across all sheets.
async function locateSkuColumn(zip, shared, pimSkus) {
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  let best = null;
  for (const name of listSheetNames(workbookXml)) {
    const path = await sheetPathByName(zip, name);
    if (!path) continue;
    const xml = await zip.file(path).async('string');
    const grid = sheetToGrid(xml, shared);
    const counts = new Map();
    for (const row of grid) {
      if (!row) continue;
      row.forEach((v, c) => { if (pimSkus.has(String(v ?? '').trim())) counts.set(c, (counts.get(c) ?? 0) + 1); });
    }
    for (const [col, n] of counts) if (!best || n > best.matches) best = { name, path, xml, grid, col, matches: n };
  }
  return best;
}

/**
 * Read the file and decide every row, without writing anything.
 * Returns the plan the dialog shows and fillMenardsPromoFile consumes.
 */
export async function analyzeMenardsPromoFile(file, promotion) {
  const tier = (promotion.kind ?? 'monthly') === 'monthly' ? 'orange' : 'purple';
  const tierLabel = tier === 'orange' ? 'Orange' : 'Purple';
  const mapField = `map_${tier}_usd`;
  const costField = `cost_usd_menards_${tier}`;

  const { rows: members, excluded } = await promotionMembersFor(promotion, 'menards');
  if (!members.length) throw new Error('This promotion has no products.');
  const bySku = new Map(members.map((m) => [m.sku, m]));

  // Every product's Blue and level prices: rows outside the promotion need
  // Blue too, so the whole catalog is read (a few hundred rows).
  const { data: prods, error } = await supabase.from('products').select(`sku, map_usd, cost_usd_menards, ${mapField}, ${costField}`).range(0, 4999);
  if (error) throw error;
  const pim = new Map((prods ?? []).map((p) => [p.sku, p]));
  const pimSkus = new Set(pim.keys());

  const { zip, shared } = await openFile(file);
  const hit = await locateSkuColumn(zip, shared, pimSkus);
  if (!hit) throw new Error(`No column of "${file.name}" holds our SKUs. Upload the promotion file Menards sent.`);

  const fills = new Map(); // 1-based row number → { map, cost }
  const missing = []; // { sku, row, reason }
  const notInPromo = []; // { sku, row, blue } — get the Blue prices
  const fileSkus = new Set();
  let fromList = 0;
  hit.grid.forEach((row, i) => {
    const sku = String(row?.[hit.col] ?? '').trim();
    if (!pimSkus.has(sku)) return;
    const rn = i + 1;
    fileSkus.add(sku);
    const m = bySku.get(sku);
    const p = pim.get(sku) ?? {};
    if (!m) {
      const blue = p.map_usd != null && p.cost_usd_menards != null ? { map: Number(p.map_usd), cost: Number(p.cost_usd_menards) } : null;
      notInPromo.push({ sku, row: rn, blue });
      return;
    }
    const map = m.promo_price_usd != null ? Number(m.promo_price_usd) : p[mapField] != null ? Number(p[mapField]) : null;
    const listedCost = m.promo_costs?.menards_usd;
    const cost = listedCost != null ? Number(listedCost) : p[costField] != null ? Number(p[costField]) : null;
    if (map == null || cost == null) {
      const blue = p.map_usd != null && p.cost_usd_menards != null ? { map: Number(p.map_usd), cost: Number(p.cost_usd_menards) } : null;
      missing.push({ sku, row: rn, blue, reason: map == null && cost == null ? `no MAP ${tierLabel} and no WC Menards ${tierLabel}` : map == null ? `no MAP ${tierLabel}` : `no WC Menards ${tierLabel}` });
      return;
    }
    if (m.promo_price_usd != null || listedCost != null) fromList += 1;
    fills.set(rn, { sku, map, cost });
  });
  if (!fills.size && !missing.length) throw new Error('No row of the file belongs to this promotion. Check that the file and the promotion match.');

  const notInFile = members.map((m) => m.sku).filter((s) => !fileSkus.has(s)).sort();
  return { tier, tierLabel, sheet: hit.name, path: hit.path, xml: hit.xml, skuCol: hit.col, fills, missing, notInPromo, notInFile, excluded, fromList, fileRows: fileSkus.size };
}

/**
 * Write F/G/H on the planned rows and download the file. `missing` says
 * what the rows without a level price get: 'blank' (left as they came),
 * 'blue' (the Blue MAP and WC Menards; rows without Blue stay blank) or
 * 'remove' (taken out of the file).
 */
export async function fillMenardsPromoFile(file, promotion, { plan = null, missing = 'blank' } = {}) {
  const p = plan ?? (await analyzeMenardsPromoFile(file, promotion));
  const { zip } = await openFile(file);
  const cellsByRow = new Map();
  const write = (rn, f) => cellsByRow.set(rn, new Map([
    [MENARDS_COLUMNS.map + 1, buildCell(`${indexToCol(MENARDS_COLUMNS.map + 1)}${rn}`, f.map)],
    [MENARDS_COLUMNS.cost + 1, buildCell(`${indexToCol(MENARDS_COLUMNS.cost + 1)}${rn}`, f.cost)],
    [MENARDS_COLUMNS.map2 + 1, buildCell(`${indexToCol(MENARDS_COLUMNS.map2 + 1)}${rn}`, f.map)],
  ]));
  for (const [rn, f] of p.fills) write(rn, f);
  const withBlue = [];
  const noBlue = [];
  if (missing === 'blue') {
    for (const m of p.missing) {
      if (m.blue) { write(m.row, m.blue); withBlue.push(m.sku); } else noBlue.push(m.sku);
    }
  }
  // Rows outside the promotion keep their place and get the Blue prices.
  const othersBlue = [];
  const othersNoBlue = [];
  for (const r of p.notInPromo) {
    if (r.blue) { write(r.row, r.blue); othersBlue.push(r.sku); } else othersNoBlue.push(r.sku);
  }
  let xml = mergeRows(p.xml, cellsByRow, true);
  const removed = missing === 'remove' ? p.missing.map((m) => m.row) : [];
  if (removed.length) xml = removeRows(xml, removed);
  zip.file(p.path, xml);
  await downloadZip(zip, `Menards_Promo_${String(promotion.period).slice(0, 7)}`, /\.xlsm$/i.test(file.name) ? 'xlsm' : 'xlsx');

  const report = { ...p, filled: p.fills.size, removed: removed.length, othersBlue, othersNoBlue, withBlue, noBlue, leftBlank: missing === 'blank' ? p.missing.length : 0 };
  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: 'menards',
    summary: `Filled Menards promotion file for "${promotion.name}" (${report.filled} rows, ${p.tierLabel} level)`,
    metadata: { file: file.name, filled: report.filled, tier: p.tier, missing, removed: report.removed, with_blue: withBlue.length, left_blank: report.leftBlank, others_blue: othersBlue.length, others_no_blue: othersNoBlue.length, not_in_file: p.notInFile.length },
  });
  return report;
}

const few = (list, n = 8) => `${list.slice(0, n).join(', ')}${list.length > n ? ` and ${list.length - n} more` : ''}`;

export function summarizeMenardsFill(r) {
  const parts = [`Menards file ready. ${r.filled} of ${r.fileRows} rows filled with MAP ${r.tierLabel} and WC Menards ${r.tierLabel} (columns F, G, H)${r.fromList ? `, ${r.fromList} from the promotion's own list` : ''}`];
  if (r.withBlue?.length) parts.push(`${r.withBlue.length} rows with no ${r.tierLabel} price got the Blue prices: ${few(r.withBlue)}`);
  if (r.noBlue?.length) parts.push(`${r.noBlue.length} rows with no ${r.tierLabel} price and no Blue price either, left as they came: ${few(r.noBlue)}`);
  if (r.removed) parts.push(`${r.removed} rows with no ${r.tierLabel} price taken out: ${few(r.missing.map((m) => m.sku))}`);
  if (r.leftBlank) parts.push(`${r.leftBlank} rows with no ${r.tierLabel} price left as they came: ${few(r.missing.map((m) => m.sku))}`);
  if (r.othersBlue?.length) parts.push(`${r.othersBlue.length} rows of products outside this promotion got the Blue prices: ${few(r.othersBlue)}`);
  if (r.othersNoBlue?.length) parts.push(`${r.othersNoBlue.length} rows outside this promotion have no Blue price in the PIM, left as they came: ${few(r.othersNoBlue)}`);
  if (r.notInFile.length) parts.push(`MISSING from the file, ${r.notInFile.length} products of the promotion: ${few(r.notInFile, 12)}`);
  if (r.excluded?.length) parts.push(`${r.excluded.length} excluded from Menards, untouched: ${few(r.excluded)}`);
  return parts.join(' · ');
}
