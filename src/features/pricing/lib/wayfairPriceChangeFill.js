// Fill Wayfair's Partner Home PRICING file ("Pricing / MAP Change" export)
// when a promotion ends: its products go back to their Blue level in Pricing
// (user flow 2026-09-28). Like the promotions file, it is always the file the
// person downloads from Partner Home right before — its "Current" columns are
// Wayfair's own snapshot of the moment (during a promotion they show the
// promo values), so the PIM never writes them. Sheet "Pricing", columns by
// their technical names on the header row:
//   USA supplier     BaseCost = WC Wayfair Blue (cost_usd_wayfair)
//                    NewMapUSD = MAP Blue USD (map_usd)
//   Canada supplier  NewMapCAD = MAP Blue CAD (map_cad); BaseCost stays empty
//                    — Wayfair Canada's USD cost has no Blue column in Pricing yet
//   MSRP columns and the other market's MAP stay empty (no change).
// The file lists every Wayfair product: only the promotion's rows are kept
// (renumbered from the first data row); promotion products the file doesn't
// list are not live there and are reported. Rows whose Current values already
// equal Blue are kept and reported — the promotion may never have reached them.

import { supabase } from '@/lib/supabase';
import {
  loadJSZip,
  parseSharedStrings,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  mergeRows,
  keepOnlyRows,
  ensureNumberFormat,
  downloadZip,
} from '@/features/syndication/exports/templateFiller';
import { promotionMembersFor } from '@/features/pricing/api/promotions';
import { markPromotionTask } from '@/features/pricing/api/promoTasks';
import { logActivity } from '@/features/activity/api/activityLog';

const MONEY = '"$"#,##0.00';
const COLUMNS = {
  sku: 'SupplierPartNumber',
  currentBaseCost: 'CurrentBaseCost',
  baseCost: 'BaseCost',
  currentMapUsd: 'CurrentMapUSD',
  newMapUsd: 'NewMapUSD',
  currentMapCad: 'CurrentMapCAD',
  newMapCad: 'NewMapCAD',
};

function locate(grid) {
  for (let r = 0; r < Math.min(6, grid.length); r++) {
    const row = (grid[r] ?? []).map((v) => String(v ?? '').trim());
    if (!row.includes(COLUMNS.sku) || !row.includes(COLUMNS.baseCost)) continue;
    const cols = {};
    for (const [role, name] of Object.entries(COLUMNS)) {
      const c = row.indexOf(name);
      if (c !== -1) cols[role] = c;
    }
    return { headerRow: r, cols };
  }
  return null;
}
const colLetter = (c) => { let n = c + 1; let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const list = (a, n = 8) => `${a.slice(0, n).join(', ')}${a.length > n ? '…' : ''}`;

/**
 * @param file      the pricing file the person uploaded (.name, .arrayBuffer())
 * @param promotion promotions row (the one that ended)
 * @param supplier  'USA' | 'CAN'
 */
export async function fillWayfairPriceChangeFile(file, promotion, supplier = 'USA') {
  const usa = supplier === 'USA';
  const label = usa ? 'Wayfair USA' : 'Wayfair Canada';
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const sharedFile = zip.file('xl/sharedStrings.xml');
  const shared = parseSharedStrings(sharedFile ? await sharedFile.async('string') : '');

  const path = await sheetPathByName(zip, 'Pricing');
  if (!path) throw new Error('No "Pricing" sheet found — upload the pricing file downloaded from Wayfair Partner Home (Current / New base cost and MAP).');
  const xml = await zip.file(path).async('string');
  const grid = sheetToGrid(xml, shared);
  const hit = locate(grid);
  if (!hit) throw new Error("Unexpected column layout — no SupplierPartNumber / BaseCost header. Is this Wayfair's pricing file?");
  const { cols } = hit;
  const mapCol = usa ? cols.newMapUsd : cols.newMapCad;
  const currentMapCol = usa ? cols.currentMapUsd : cols.currentMapCad;
  if (mapCol == null) throw new Error(`The file has no ${usa ? 'NewMapUSD' : 'NewMapCAD'} column — is it the ${usa ? 'USA' : 'Canada'} supplier's pricing file?`);

  const { rows: members, excluded } = await promotionMembersFor(promotion, usa ? 'wayfair_us' : 'wayfair_ca');
  if (!members.length) throw new Error(`This promotion has no products for ${label}.`);
  const memberSkus = members.map((r) => r.sku);
  const memberSet = new Set(memberSkus);

  // The Blue level of every member, straight from Pricing.
  const blue = new Map();
  for (let i = 0; i < memberSkus.length; i += 100) {
    const { data, error } = await supabase
      .from('products')
      .select(usa ? 'sku, cost:cost_usd_wayfair, map:map_usd' : 'sku, map:map_cad')
      .in('sku', memberSkus.slice(i, i + 100));
    if (error) throw error;
    for (const p of data ?? []) blue.set(p.sku, { cost: usa && p.cost != null ? Number(p.cost) : null, map: p.map != null ? Number(p.map) : null });
  }

  const money = await ensureNumberFormat(zip, MONEY, 0);
  const firstData = hit.headerRow + 3; // labels, instructions, then data
  const cellsByRow = new Map();
  const fileSkus = new Set();
  const alreadyBlue = [];
  const noBlue = [];
  for (let i = firstData; i < grid.length; i++) {
    const sku = String(grid[i]?.[cols.sku] ?? '').trim();
    if (!sku) continue;
    fileSkus.add(sku);
    if (!memberSet.has(sku)) continue;
    const { cost = null, map = null } = blue.get(sku) ?? {};
    if (cost == null && map == null) { noBlue.push(sku); continue; }
    const rn = i + 1;
    const cells = new Map();
    if (cost != null) cells.set(cols.baseCost + 1, buildCell(`${colLetter(cols.baseCost)}${rn}`, cost, money));
    if (map != null) cells.set(mapCol + 1, buildCell(`${colLetter(mapCol)}${rn}`, map, money));
    cellsByRow.set(rn, cells);
    const same = (col, v) => v == null || col == null || Number(grid[i][col]) === v;
    if (same(cols.currentBaseCost, cost) && same(currentMapCol, map)) alreadyBlue.push(sku);
  }
  if (!cellsByRow.size) throw new Error(`None of the promotion's products is in this file with Blue values in Pricing — check it is the ${label} pricing file.`);

  const kept = keepOnlyRows(mergeRows(xml, cellsByRow, true), firstData + 1, new Set(cellsByRow.keys()));
  zip.file(path, kept.xml);
  const notInFile = memberSkus.filter((s) => !fileSkus.has(s)).sort();

  const day = String(promotion.ends_on ?? promotion.period).slice(0, 10);
  await downloadZip(zip, `Wayfair_${usa ? 'USA' : 'Canada'}_Price_Change_${day}`, /\.xlsm$/i.test(file.name) ? 'xlsm' : 'xlsx');

  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: `${usa ? 'wayfair_usa' : 'wayfair'}_price_change`,
    summary: `Filled ${label} price change for "${promotion.name}" (${cellsByRow.size} products back at Blue, ${kept.removed} other rows removed)`,
    metadata: { rows: cellsByRow.size, removed: kept.removed, already_blue: alreadyBlue.length, no_blue: noBlue.length, not_in_file: notInFile.length },
  });
  await markPromotionTask(promotion.id, `${usa ? 'wayfair_us' : 'wayfair_ca'}:price_change`, { rows: cellsByRow.size });

  return { supplier, rows: cellsByRow.size, removed: kept.removed, alreadyBlue, noBlue, notInFile, excluded };
}

export function summarizeWayfairPriceChange(r) {
  const usa = r.supplier === 'USA';
  const label = usa ? 'Wayfair USA' : 'Wayfair Canada';
  const parts = [`${label} price change ready — ${r.rows} products back at Blue (${usa ? 'New Base Cost = WC Wayfair, New MAP (USD) = MAP' : 'New MAP (CAD) = MAP'}), ${r.removed} other rows removed`];
  if (!usa) parts.push('New Base Cost left empty: Wayfair Canada has no Blue cost (USD) in Pricing yet');
  if (r.alreadyBlue.length) parts.push(`${r.alreadyBlue.length} already show the Blue values on Wayfair, the promotion may not have reached them (${list(r.alreadyBlue)})`);
  if (r.noBlue.length) parts.push(`${r.noBlue.length} without Blue values in Pricing, left out: ${list(r.noBlue)}`);
  if (r.notInFile.length) parts.push(`${r.notInFile.length} promotion products not in the file (not live on ${label}): ${list(r.notInFile)}`);
  if (r.excluded?.length) parts.push(`${r.excluded.length} excluded from ${label}`);
  return parts.join(' · ');
}
