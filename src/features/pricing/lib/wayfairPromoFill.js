// Fill Wayfair's Partner Home PROMOTIONS file from a PIM promotion — always
// the file downloaded fresh from Partner Home and uploaded (Fill file), for
// both markets and every kind of promotion (user decision 2026-09-28). The
// sheet "Promotions" carries Wayfair's complete "Current" info for every
// listed row plus the tracking processId, and gets filled in place (JSZip
// XML edit), never rebuilt:
//   - rows already in the file that are promotion members get their promo
//     columns filled; the file lists every Wayfair product, so every other
//     row is REMOVED and the kept rows renumbered from the first data row
//     (user rule 2026-09-28, both markets)
//   - promotion members missing from the file are APPENDED, validated
//     against what Wayfair actually lists (latest API audit snapshot),
//     carrying the PIM's MAP / MSRP in the "Current" columns (the API exposes
//     no pricing)
//   - members Wayfair doesn't carry are skipped and reported
// Columns are found by their technical names on the header row — the layout
// grew from K/L/M (2026-07) to L…R with a B2B block (2026-09); both work.
//
// USA supplier (user rules 2026-09-28, monthly promotion):
//   PromotionalDiscountPercent       0
//   PromotionalDiscountBaseCost      the product's WC Wayfair of the promotion's
//                                    level (cost_usd_wayfair_orange; Purple for a
//                                    special event) — Pricing is the truth —
//                                    shown as $80.00 (a currency style is added
//                                    to the file, which has none)
//   PromotionalMap                   empty
//   B2bRecommendedDiscountPercent    0
//   B2bPromotionalDiscountPercent    0
//   B2bPromotionalDiscountBaseCost   empty
// Canada supplier (confirmed against the July submission): discount 0, base
// cost = the promotion's wayfair_ca_usd (Wayfair Canada's USD cost has no
// product column yet, so it still comes from the promotion's price file),
// promotional MAP empty, B2B columns untouched.

import { supabase } from '@/lib/supabase';
import {
  loadJSZip,
  parseSharedStrings,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  mergeRows,
  injectRows,
  ensureNumberFormat,
  keepOnlyRows,
  downloadZip,
} from '@/features/syndication/exports/templateFiller';
import { promotionMembersFor, promotionLevel, levelLabel } from '@/features/pricing/api/promotions';
import { logActivity } from '@/features/activity/api/activityLog';
import { markPromotionTask } from '@/features/pricing/api/promoTasks';

const COST_FORMAT = '"$"#,##0.00';
// Technical column names (header row) → roles.
const COLUMNS = {
  sku: 'SupplierPartNumber',
  discount: 'PromotionalDiscountPercent',
  baseCost: 'PromotionalDiscountBaseCost',
  promoMap: 'PromotionalMap',
  b2bRecommended: 'B2bRecommendedDiscountPercent',
  b2bDiscount: 'B2bPromotionalDiscountPercent',
  b2bBaseCost: 'B2bPromotionalDiscountBaseCost',
  mapUsd: 'CurrentMapUSD', msrpUsd: 'CurrentMsrpUSD', mapCad: 'CurrentMapCAD', msrpCad: 'CurrentMsrpCAD',
};

function locate(grid) {
  for (let r = 0; r < Math.min(6, grid.length); r++) {
    const row = (grid[r] ?? []).map((v) => String(v ?? '').trim());
    const sku = row.indexOf(COLUMNS.sku);
    if (sku === -1) continue;
    const cols = {};
    for (const [role, name] of Object.entries(COLUMNS)) {
      const c = row.indexOf(name);
      if (c !== -1) cols[role] = c;
    }
    if (cols.discount != null && cols.baseCost != null) return { headerRow: r, cols };
  }
  return null;
}
const colLetter = (c) => { let n = c + 1; let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

/**
 * @param file      the file the person uploaded (anything with .name and .arrayBuffer())
 * @param promotion promotions row
 * @param supplier  'CAN' | 'USA'
 */
export async function fillWayfairPromoFile(file, promotion, supplier = 'CAN') {
  const usa = supplier === 'USA';
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const sharedFile = zip.file('xl/sharedStrings.xml');
  const shared = parseSharedStrings(sharedFile ? await sharedFile.async('string') : '');

  const path = await sheetPathByName(zip, 'Promotions');
  if (!path) throw new Error('No "Promotions" sheet found — upload the promotions file downloaded from Wayfair Partner Home.');
  const xml = await zip.file(path).async('string');
  const grid = sheetToGrid(xml, shared);
  const hit = locate(grid);
  if (!hit) throw new Error('Unexpected column layout — this doesn\'t look like Wayfair\'s promotions file (no SupplierPartNumber / PromotionalDiscountPercent / PromotionalDiscountBaseCost header).');
  const { cols } = hit;

  const { rows: prices, excluded } = await promotionMembersFor(promotion, usa ? 'wayfair_us' : 'wayfair_ca');
  const tier = promotionLevel(promotion);
  // The base cost per member: USA from the product's level in Pricing,
  // Canada from the promotion's row (see the header note).
  const costBySku = new Map();
  if (usa) {
    const field = `cost_usd_wayfair_${tier}`;
    const skus = prices.map((r) => r.sku);
    for (let i = 0; i < skus.length; i += 100) {
      const { data, error } = await supabase.from('products').select(`sku, cost:${field}`).in('sku', skus.slice(i, i + 100));
      if (error) throw error;
      for (const p of data ?? []) if (p.cost != null) costBySku.set(p.sku, Number(p.cost));
    }
  } else {
    for (const r of prices) if (r.promo_costs?.wayfair_ca_usd != null) costBySku.set(r.sku, Number(r.promo_costs.wayfair_ca_usd));
  }
  const noCost = prices.map((r) => r.sku).filter((s) => !costBySku.has(s)).sort();
  if (!costBySku.size) {
    throw new Error(usa
      ? `No member of this promotion has a WC Wayfair ${levelLabel(tier)} in Pricing.`
      : 'This promotion has no Wayfair Canada (USD) promo costs loaded — they come from the promotion\'s price file.');
  }

  // The currency style for the base cost, cloned from the editable cells.
  const firstData = hit.headerRow + 3; // labels, instructions, then data
  const baseStyle = Number((xml.match(new RegExp(`<c r="${colLetter(cols.baseCost)}${firstData + 1}" s="(\\d+)"`)) || [])[1] ?? 0);
  const costStyle = await ensureNumberFormat(zip, COST_FORMAT, baseStyle);

  // Cells of one member row: the same for existing and appended rows.
  const promoCells = (rn, cost) => {
    const cells = new Map();
    const put = (c, v, style = null) => { if (c != null && v != null) cells.set(c + 1, buildCell(`${colLetter(c)}${rn}`, v, style)); };
    put(cols.discount, 0);
    put(cols.baseCost, cost, costStyle);
    if (usa) {
      put(cols.b2bRecommended, 0);
      put(cols.b2bDiscount, 0);
    }
    return cells;
  };

  const cellsByRow = new Map();
  const fileSkus = new Set();
  let filled = 0;
  for (let i = hit.headerRow + 1; i < grid.length; i++) {
    const sku = String(grid[i]?.[cols.sku] ?? '').trim();
    if (!sku || /\s/.test(sku)) continue; // the label and instruction rows under the header
    fileSkus.add(sku);
    const cost = costBySku.get(sku);
    if (cost == null) continue;
    cellsByRow.set(i + 1, promoCells(i + 1, cost));
    filled += 1;
  }
  let merged = cellsByRow.size ? mergeRows(xml, cellsByRow, true) : xml;
  const kept = keepOnlyRows(merged, firstData + 1, new Set(cellsByRow.keys()));
  merged = kept.xml;
  const removed = kept.removed;
  const lastRow = kept.lastRow;

  // Members missing from the file: append them — but only those Wayfair
  // actually lists (latest API audit snapshot, 2×/day); a SKU Wayfair doesn't
  // carry has no business in the promotion file.
  const notInFile = [...costBySku.keys()].filter((s) => !fileSkus.has(s)).sort();
  let toAppend = notInFile;
  let notOnWayfair = [];
  const { data: snaps } = await supabase
    .from('channel_health')
    .select('results')
    .eq('channel', usa ? 'wayfair_usa' : 'wayfair')
    .order('run_at', { ascending: false })
    .limit(1);
  if (snaps?.length) {
    const listed = new Set((snaps[0].results ?? []).map((r) => r.sku));
    toAppend = notInFile.filter((s) => listed.has(s));
    notOnWayfair = notInFile.filter((s) => !listed.has(s));
  }
  if (toAppend.length) {
    // Wayfair's API exposes no pricing, so the "Current" MAP / MSRP of an
    // appended row come from the PIM — the truth those values mirror anyway.
    const { data: pimRows } = await supabase
      .from('products')
      .select(usa ? 'sku, map:map_usd, msrp:msrp_usd' : 'sku, map:map_cad, msrp:msrp_cad')
      .in('sku', toAppend);
    const pimBySku = new Map((pimRows ?? []).map((p) => [p.sku, p]));
    const skuStyle = (xml.match(new RegExp(`<c r="${colLetter(cols.sku)}${firstData + 1}" s="(\\d+)"`)) || [])[1] ?? null;
    let rowsXml = '';
    for (const [idx, sku] of toAppend.entries()) {
      const rn = lastRow + 1 + idx;
      const pim = pimBySku.get(sku);
      const cells = promoCells(rn, costBySku.get(sku));
      cells.set(cols.sku + 1, buildCell(`${colLetter(cols.sku)}${rn}`, sku, skuStyle));
      const mapCol = usa ? cols.mapUsd : cols.mapCad;
      const msrpCol = usa ? cols.msrpUsd : cols.msrpCad;
      if (mapCol != null && pim?.map != null) cells.set(mapCol + 1, buildCell(`${colLetter(mapCol)}${rn}`, Number(pim.map), skuStyle));
      if (msrpCol != null && pim?.msrp != null) cells.set(msrpCol + 1, buildCell(`${colLetter(msrpCol)}${rn}`, Number(pim.msrp), skuStyle));
      rowsXml += `<row r="${rn}">` + [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('') + '</row>';
    }
    merged = injectRows(merged, rowsXml, lastRow + toAppend.length);
  }
  zip.file(path, merged);

  const baseName = `Wayfair_${usa ? 'USA' : 'Canada'}_Promotions_${String(promotion.period).slice(0, 7)}`;
  await downloadZip(zip, baseName, /\.xlsm$/i.test(file.name) ? 'xlsm' : 'xlsx');

  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: usa ? 'wayfair_usa' : 'wayfair',
    summary: `Filled Wayfair ${usa ? 'USA' : 'Canada'} promotions file for "${promotion.name}" (${filled} rows filled, ${toAppend.length} added, ${removed} outside the promotion removed${usa ? `, WC Wayfair ${levelLabel(tier)}` : ''})`,
    metadata: { filled, appended: toAppend.length, removed, file_rows: fileSkus.size, not_on_wayfair: notOnWayfair.length, no_cost: noCost.length, tier: usa ? tier : null },
  });

  await markPromotionTask(promotion.id, `${usa ? 'wayfair_us' : 'wayfair_ca'}:promo_file`, { rows: filled + toAppend.length });

  return { supplier, tier: usa ? tier : null, filled, removed, appended: toAppend, fileRows: fileSkus.size, notOnWayfair, noCost, excluded };
}

export function summarizeWayfairFill(channel, r) {
  const label = channel?.label ?? (r.supplier === 'USA' ? 'Wayfair USA' : 'Wayfair Canada');
  const parts = [`${label} file ready — ${r.filled} of ${r.fileRows} rows filled${r.tier ? ` (discount 0, cost after discount = WC Wayfair ${levelLabel(r.tier)}, B2B 0)` : ''}`];
  if (r.removed) parts.push(`${r.removed} rows of products outside the promotion removed`);
  if (r.appended.length) parts.push(`${r.appended.length} rows added (${r.appended.slice(0, 8).join(', ')}${r.appended.length > 8 ? '…' : ''})`);
  if (r.notOnWayfair.length) parts.push(`skipped, not listed on ${label}: ${r.notOnWayfair.slice(0, 8).join(', ')}${r.notOnWayfair.length > 8 ? '…' : ''}`);
  if (r.noCost?.length) parts.push(`${r.noCost.length} promo members without ${r.tier ? `WC Wayfair ${levelLabel(r.tier)} in Pricing` : 'a Wayfair Canada cost'}, left out: ${r.noCost.slice(0, 8).join(', ')}${r.noCost.length > 8 ? '…' : ''}`);
  if (r.excluded?.length) parts.push(`${r.excluded.length} excluded from ${label}`);
  return parts.join(' · ');
}
