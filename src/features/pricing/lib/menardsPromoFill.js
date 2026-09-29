// Fill Menards' promotion file from a PIM promotion. The file comes from
// Menards (uploaded here, handed back filled): every row already carries our
// SKU, and only three columns are ours to write (rules given by the user
// 2026-09-23):
//
//   F  MAP of the promo level   MAP Orange for a monthly promotion or a
//                               flash deal, MAP Purple for a special event
//   G  WC Menards of the level  cost_usd_menards_orange / _purple
//   H  MAP of the promo level   same value as F
//
// A promo price / promo cost typed on the promotion's own list
// (promo_price_usd, promo_costs.menards_usd) wins over the product's level.
//
// Every row of the file stays (rule of the user 2026-09-23): products in the
// promotion get the level's prices, products OUTSIDE the promotion get the
// Blue prices (map_usd, cost_usd_menards), promotion members missing from
// the file are reported (and confirmed before writing), F/G/H are overwritten
// whatever they held, and promotion products with no price on the level are
// simply left as they came. Rows are matched on the column that holds our
// SKUs (found by content, not by header), so the layout can change.
//
// Back to Blue (user rules 2026-09-29, monthly promotions, flash deals and
// special events alike): the day the promotion ends, the Menards file goes
// back with ONLY the promotion's products — the ones that went out when it
// started — at the Blue level: F = H = MAP Blue USD (map_usd), G = WC Menards
// Blue (cost_usd_menards). The rows of other products are removed (header,
// totals and notes stay); a sheet with formulas or merged cells is not
// reshaped — its other rows are left as they came, and the report says so.
// The file uploaded at the start is kept 60 days, so Back to Blue can be
// generated from it without another upload.

import { supabase } from '@/lib/supabase';
import {
  loadJSZip,
  parseSharedStrings,
  listSheetNames,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  mergeRows,
  removeRowsSafely,
  downloadZip,
  indexToCol,
} from '@/features/syndication/exports/templateFiller';
import { promotionMembersFor, promotionLevel } from '@/features/pricing/api/promotions';
import { logActivity } from '@/features/activity/api/activityLog';
import { markPromotionTask, savePromoFile, loadPromoFile } from '@/features/pricing/api/promoTasks';

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
  const tier = promotionLevel(promotion);
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
 * Write F/G/H on the planned rows and download the file. Promotion products
 * without a level price are left as they came (`missing` = 'blank', the
 * default; 'blue' would give them the Blue prices instead).
 */
export async function fillMenardsPromoFile(file, promotion, { plan = null, missing = 'blank' } = {}) {
  const p = plan ?? (await analyzeMenardsPromoFile(file, promotion));
  const { zip } = await openFile(file);
  const cellsByRow = new Map();
  const write = (rn, f) => writeFGH(cellsByRow, rn, f);
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
  zip.file(p.path, mergeRows(p.xml, cellsByRow, true));
  await downloadZip(zip, `Menards_Promo_${String(promotion.period).slice(0, 7)}`, /\.xlsm$/i.test(file.name) ? 'xlsm' : 'xlsx');

  const report = { ...p, filled: p.fills.size, othersBlue, othersNoBlue, withBlue, noBlue, leftBlank: missing === 'blank' ? p.missing.length : 0 };
  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: 'menards',
    summary: `Filled Menards promotion file for "${promotion.name}" (${report.filled} rows, ${p.tierLabel} level)`,
    metadata: { file: file.name, filled: report.filled, tier: p.tier, missing, with_blue: withBlue.length, left_blank: report.leftBlank, others_blue: othersBlue.length, others_no_blue: othersNoBlue.length, not_in_file: p.notInFile.length },
  });
  const skus = [...new Set([...[...p.fills.values()].map((f) => f.sku), ...p.missing.map((m) => m.sku)])].sort();
  const saved = await savePromoFile(promotion, 'menards:promo_file', file);
  await markPromotionTask(promotion.id, 'menards:promo_file', { rows: report.filled, tier: p.tier, skus, ...saved });
  report.saved = Boolean(saved.file);
  return report;
}

// F = H = MAP, G = cost on one row.
function writeFGH(cellsByRow, rn, f) {
  cellsByRow.set(rn, new Map([
    [MENARDS_COLUMNS.map + 1, buildCell(`${indexToCol(MENARDS_COLUMNS.map + 1)}${rn}`, f.map)],
    [MENARDS_COLUMNS.cost + 1, buildCell(`${indexToCol(MENARDS_COLUMNS.cost + 1)}${rn}`, f.cost)],
    [MENARDS_COLUMNS.map2 + 1, buildCell(`${indexToCol(MENARDS_COLUMNS.map2 + 1)}${rn}`, f.map)],
  ]));
}

/**
 * Back to Blue: the promotion's products (those that went out at the start)
 * at the Blue prices, every other product row removed — see the header.
 */
export async function fillMenardsBackToBlue(file, promotion, { fromSaved = false } = {}) {
  const { rows: members, excluded } = await promotionMembersFor(promotion, 'menards');
  const sentAtStart = promotion.file_tasks?.['menards:promo_file']?.skus ?? null;
  const promoSkus = sentAtStart?.length ? sentAtStart : members.map((m) => m.sku);
  if (!promoSkus.length) throw new Error('This promotion has no products for Menards.');
  const promoSet = new Set(promoSkus);
  const { data: prods, error } = await supabase.from('products').select('sku, map_usd, cost_usd_menards').range(0, 4999);
  if (error) throw error;
  const pim = new Map((prods ?? []).map((p) => [p.sku, p]));

  const { zip, shared } = await openFile(file);
  const hit = await locateSkuColumn(zip, shared, new Set(pim.keys()));
  if (!hit) throw new Error(`No column of "${file.name}" holds our SKUs. Upload the promotion file Menards sent.`);

  const cellsByRow = new Map();
  const back = []; // the promotion's products, now at Blue
  const noBlue = []; // promotion products without MAP Blue USD or WC Menards Blue: left as they came
  const drop = new Set(); // rows of other products
  const fileSkus = new Set();
  const firstData = hit.grid.findIndex((row) => pim.has(String(row?.[hit.col] ?? '').trim()));
  hit.grid.forEach((row, i) => {
    const sku = String(row?.[hit.col] ?? '').trim();
    if (!sku || i < firstData) return; // header rows above, totals / notes without a SKU
    fileSkus.add(sku);
    if (!promoSet.has(sku)) { drop.add(i + 1); return; }
    const p = pim.get(sku);
    if (p?.map_usd == null || p?.cost_usd_menards == null) { noBlue.push(sku); return; }
    writeFGH(cellsByRow, i + 1, { map: Number(p.map_usd), cost: Number(p.cost_usd_menards) });
    back.push(sku);
  });
  if (!back.length && !noBlue.length) throw new Error('No product of this promotion is in the file. Check that it is the Menards file of this promotion.');

  let xml = mergeRows(hit.xml, cellsByRow, true);
  const removal = removeRowsSafely(xml, drop);
  if (removal) xml = removal.xml;
  zip.file(hit.path, xml);
  const day = String(promotion.ends_on ?? promotion.period).slice(0, 10);
  await downloadZip(zip, `Menards_Back_to_Blue_${day}`, /\.xlsm$/i.test(file.name) ? 'xlsm' : 'xlsx');

  const notInFile = promoSkus.filter((s) => !fileSkus.has(s)).sort();
  const removed = removal ? removal.removed : 0;
  const keptOthers = removal ? 0 : drop.size;
  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: 'menards_price_change',
    summary: `Filled Menards back to Blue for "${promotion.name}" (${back.length} promotion products at Blue, ${removed} other rows removed${fromSaved ? ', from the saved file' : ''})`,
    metadata: { file: file.name, back: back.length, removed, kept_others: keptOthers, no_blue: noBlue.length, not_in_file: notInFile.length, from_saved: fromSaved },
  });
  await markPromotionTask(promotion.id, 'menards:price_change', { rows: back.length, skus: back.slice().sort(), ...(fromSaved ? { from_saved: true } : {}) });
  return { back, removed, keptOthers, noBlue, notInFile, excluded, fileRows: fileSkus.size, fromSaved, onlySent: Boolean(sentAtStart?.length) };
}

/** Back to Blue from the Menards file kept when the promotion started. */
export async function fillMenardsBackToBlueFromSaved(promotion) {
  const file = await loadPromoFile(promotion.file_tasks?.['menards:promo_file']);
  if (!file) throw new Error('The Menards file of this promotion is no longer saved (files are kept 60 days) — upload it.');
  return fillMenardsBackToBlue(file, promotion, { fromSaved: true });
}

export function summarizeMenardsBackToBlue(r) {
  const parts = [`Menards file ready, back at Blue${r.fromSaved ? ' from the saved file' : ''}. ${r.back.length} products of the promotion got MAP Blue USD and WC Menards Blue (columns F, G, H)`];
  if (r.removed) parts.push(`${r.removed} rows of other products removed`);
  if (r.keptOthers) parts.push(`${r.keptOthers} rows of other products left as they came: the sheet has formulas or merged cells, so rows were not moved`);
  if (r.onlySent) parts.push('only the products that went out when the promotion started');
  if (r.noBlue.length) parts.push(`${r.noBlue.length} promotion products have no Blue price in the PIM, left as they came: ${few(r.noBlue)}`);
  if (r.notInFile.length) parts.push(`MISSING from the file, ${r.notInFile.length} products of the promotion: ${few(r.notInFile, 12)}`);
  if (r.excluded?.length) parts.push(`${r.excluded.length} excluded from Menards`);
  return parts.join(' · ');
}

const few = (list, n = 8) => `${list.slice(0, n).join(', ')}${list.length > n ? ` and ${list.length - n} more` : ''}`;

export function summarizeMenardsFill(r) {
  const parts = [`Menards file ready. ${r.filled} of ${r.fileRows} rows filled with MAP ${r.tierLabel} and WC Menards ${r.tierLabel} (columns F, G, H)${r.fromList ? `, ${r.fromList} from the promotion's own list` : ''}`];
  if (r.withBlue?.length) parts.push(`${r.withBlue.length} rows with no ${r.tierLabel} price got the Blue prices: ${few(r.withBlue)}`);
  if (r.noBlue?.length) parts.push(`${r.noBlue.length} rows with no ${r.tierLabel} price and no Blue price either, left as they came: ${few(r.noBlue)}`);
  if (r.leftBlank) parts.push(`${r.leftBlank} promotion products with no ${r.tierLabel} price in the PIM, left as they came: ${few(r.missing.map((m) => m.sku))}`);
  if (r.othersBlue?.length) parts.push(`${r.othersBlue.length} rows of products outside this promotion got the Blue prices: ${few(r.othersBlue)}`);
  if (r.othersNoBlue?.length) parts.push(`${r.othersNoBlue.length} rows outside this promotion have no Blue price in the PIM, left as they came: ${few(r.othersNoBlue)}`);
  if (r.notInFile.length) parts.push(`MISSING from the file, ${r.notInFile.length} products of the promotion: ${few(r.notInFile, 12)}`);
  if (r.excluded?.length) parts.push(`${r.excluded.length} excluded from Menards, untouched: ${few(r.excluded)}`);
  return parts.join(' · ');
}
