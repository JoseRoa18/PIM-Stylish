// Fill Wayfair's Partner Home PRICING file ("Pricing / MAP Change" export) at
// both ends of a promotion (user flow 2026-09-28, every kind incl. monthly):
//   target 'promo'  the day it STARTS: the MAP goes down to the promotion's
//                   level (Orange, Purple for a special event) — the cost
//                   side of the promotion travels in the promotions file
//   target 'blue'   the day it ENDS: back to the Blue level
// Like the promotions file, it is always the file the person downloads from
// Partner Home right before — its "Current" columns are Wayfair's own
// snapshot of the moment, so the PIM never writes them. Sheet "Pricing",
// columns by their technical names on the header row:
//   USA supplier     NewMapUSD = MAP of the target level (map_usd / map_<level>_usd)
//                    BaseCost = WC Wayfair Blue (cost_usd_wayfair), END only
//   Canada supplier  (checked on its real file 2026-09-28) base cost in USD,
//                    MAP in CAD: NewMapCAD = the Canada MAP of the target
//                    level (map_cad / map_<level>_cad — what Wayfair shows);
//                    NewMapUSD = Wayfair Canada MAP USD of the level
//                    (map_usd_wayfair_ca / _<level>) only on the rows where
//                    Wayfair keeps a USD MAP too; BaseCost = WC Wayfair Canada
//                    Blue (cost_usd_wayfair_ca), END only
//   MSRP columns stay empty (no change), and so does the USA supplier's CAD MAP.
// The file lists every Wayfair product: only the promotion's rows are kept
// (renumbered from the first data row); promotion products the file doesn't
// list are not live there and are reported. Rows whose Current values already
// equal the target are kept and reported (at the end: the promotion may never
// have reached them; at the start: the MAP was already lowered).

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
import { promotionMembersFor, promotionLevel, levelLabel } from '@/features/pricing/api/promotions';
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
 * @param target    'blue' (the promotion ended) | 'promo' (it starts: MAP of its level)
 */
export async function fillWayfairPriceChangeFile(file, promotion, supplier = 'USA', target = 'blue') {
  const usa = supplier === 'USA';
  const start = target === 'promo';
  const tier = start ? promotionLevel(promotion) : null;
  const levelName = start ? levelLabel(tier) : 'Blue';
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
  // The MAP column Wayfair keeps for this supplier: USD for the USA, CAD for
  // Canada (which also carries a USD MAP on a few rows — see the header).
  const mapCol = usa ? cols.newMapUsd : cols.newMapCad;
  const currentMapCol = usa ? cols.currentMapUsd : cols.currentMapCad;
  if (mapCol == null) throw new Error(`The file has no ${usa ? 'NewMapUSD' : 'NewMapCAD'} column — is it the ${label} pricing file from Partner Home?`);

  const { rows: members, excluded } = await promotionMembersFor(promotion, usa ? 'wayfair_us' : 'wayfair_ca');
  if (!members.length) throw new Error(`This promotion has no products for ${label}.`);
  const memberSkus = members.map((r) => r.sku);
  const memberSet = new Set(memberSkus);

  // The target level of every member, straight from Pricing.
  const mapField = start ? `map_${tier}_${usa ? 'usd' : 'cad'}` : usa ? 'map_usd' : 'map_cad';
  const usdMapField = usa ? null : start ? `map_usd_wayfair_ca_${tier}` : 'map_usd_wayfair_ca';
  const costField = usa ? 'cost_usd_wayfair' : 'cost_usd_wayfair_ca';
  const withCost = !start;
  const select = ['sku', `map:${mapField}`, withCost ? `cost:${costField}` : null, usdMapField ? `usdMap:${usdMapField}` : null].filter(Boolean).join(', ');
  const numOrNull = (v) => (v != null ? Number(v) : null);
  const values = new Map();
  for (let i = 0; i < memberSkus.length; i += 100) {
    const { data, error } = await supabase.from('products').select(select).in('sku', memberSkus.slice(i, i + 100));
    if (error) throw error;
    for (const p of data ?? []) values.set(p.sku, { cost: withCost ? numOrNull(p.cost) : null, map: numOrNull(p.map), usdMap: numOrNull(p.usdMap) });
  }

  const money = await ensureNumberFormat(zip, MONEY, 0);
  const firstData = hit.headerRow + 3; // labels, instructions, then data
  const cellsByRow = new Map();
  const fileSkus = new Set();
  const already = [];
  const missing = [];
  let usdRows = 0;
  for (let i = firstData; i < grid.length; i++) {
    const sku = String(grid[i]?.[cols.sku] ?? '').trim();
    if (!sku) continue;
    fileSkus.add(sku);
    if (!memberSet.has(sku)) continue;
    const { cost = null, map = null, usdMap = null } = values.get(sku) ?? {};
    if (cost == null && map == null) { missing.push(sku); continue; }
    const rn = i + 1;
    const cells = new Map();
    if (cost != null) cells.set(cols.baseCost + 1, buildCell(`${colLetter(cols.baseCost)}${rn}`, cost, money));
    if (map != null) cells.set(mapCol + 1, buildCell(`${colLetter(mapCol)}${rn}`, map, money));
    // Canada: the USD MAP moves with the CAD one where Wayfair keeps both.
    const keepsUsd = !usa && cols.newMapUsd != null && String(grid[i][cols.currentMapUsd] ?? '').trim() !== '';
    if (keepsUsd && usdMap != null) {
      cells.set(cols.newMapUsd + 1, buildCell(`${colLetter(cols.newMapUsd)}${rn}`, usdMap, money));
      usdRows += 1;
    }
    cellsByRow.set(rn, cells);
    const same = (col, v) => v == null || col == null || Number(grid[i][col]) === v;
    if (same(cols.currentBaseCost, cost) && same(currentMapCol, map)) already.push(sku);
  }
  if (!cellsByRow.size) throw new Error(`None of the promotion's products is in this file with ${levelName} values in Pricing — check it is the ${label} pricing file.`);

  const kept = keepOnlyRows(mergeRows(xml, cellsByRow, true), firstData + 1, new Set(cellsByRow.keys()));
  zip.file(path, kept.xml);
  const notInFile = memberSkus.filter((s) => !fileSkus.has(s)).sort();

  const day = String((start ? promotion.starts_on : promotion.ends_on) ?? promotion.period).slice(0, 10);
  await downloadZip(zip, `Wayfair_${usa ? 'USA' : 'Canada'}_Price_Change_${start ? 'Promo' : 'Blue'}_${day}`, /\.xlsm$/i.test(file.name) ? 'xlsm' : 'xlsx');

  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: `${usa ? 'wayfair_usa' : 'wayfair'}_${start ? 'price_start' : 'price_change'}`,
    summary: `Filled ${label} price change for "${promotion.name}" (${cellsByRow.size} products ${start ? `to MAP ${levelName}` : 'back at Blue'}, ${kept.removed} other rows removed)`,
    metadata: { target, tier, rows: cellsByRow.size, removed: kept.removed, already: already.length, missing: missing.length, not_in_file: notInFile.length },
  });
  await markPromotionTask(promotion.id, `${usa ? 'wayfair_us' : 'wayfair_ca'}:${start ? 'price_start' : 'price_change'}`, { rows: cellsByRow.size, tier });

  return { supplier, target, levelName, rows: cellsByRow.size, removed: kept.removed, already, missing, notInFile, excluded, usdRows };
}

export function summarizeWayfairPriceChange(r) {
  const usa = r.supplier === 'USA';
  const start = r.target === 'promo';
  const label = usa ? 'Wayfair USA' : 'Wayfair Canada';
  const what = usa
    ? (start ? `New MAP (USD) = MAP ${r.levelName}` : 'New Base Cost = WC Wayfair, New MAP (USD) = MAP')
    : `${start ? '' : 'New Base Cost = WC Wayfair Canada, '}New MAP (CAD) = MAP ${r.levelName} CAD${r.usdRows ? `, and New MAP (USD) on the ${r.usdRows} rows where Wayfair keeps one` : ''}`;
  const parts = [`${label} price change ready — ${r.rows} products ${start ? `down to the ${r.levelName} MAP` : 'back at Blue'} (${what}), ${r.removed} other rows removed`];
  if (start) parts.push('upload it on the day the promotion starts: the file has no dates, the change applies when Wayfair imports it');
  if (r.already.length) parts.push(start
    ? `${r.already.length} already show the ${r.levelName} MAP on Wayfair (${list(r.already)})`
    : `${r.already.length} already show the Blue values on Wayfair, the promotion may not have reached them (${list(r.already)})`);
  if (r.missing.length) parts.push(`${r.missing.length} without ${r.levelName} values in Pricing, left out: ${list(r.missing)}`);
  if (r.notInFile.length) parts.push(`${r.notInFile.length} promotion products not in the file (not live on ${label}): ${list(r.notInFile)}`);
  if (r.excluded?.length) parts.push(`${r.excluded.length} excluded from ${label}`);
  return parts.join(' · ');
}
