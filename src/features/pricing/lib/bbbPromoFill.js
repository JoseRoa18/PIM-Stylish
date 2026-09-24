// Fill the BB&B / Overstock promotion template from a PIM promotion.
//
// The file is downloaded fresh from their portal (the user pastes the promo's
// part numbers there first — the Copy SKUs button), so it already carries the
// site's own data: FULL_SKU, SITE_PRICE, FIRST_COST, current MAP, categories.
// The portal hands out a CSV; an .xlsx/.xlsm export of the same layout is
// accepted too. Only two columns are ours to fill, from the data rows down:
//   PROMO_MAP  = the promotion's US promo MAP  (promo_price_usd)
//   PROMO_COST = the promo first cost           (promo_costs.lowes_sod_bbb_usd)
// Matching runs on PARTNER_SKU, then on FULL_SKU against the product's
// BB&B / Overstock alias (Aliases tab) when the part number doesn't match
// as written; the header row is auto-detected (portal files carry
// instruction rows above it). Rows are never added.
//
// Two ways in (2026-09-24):
//   fillBBBPromoFile      the file downloaded fresh from the portal for this
//                         promo — rows are never removed, mismatches reported.
//   fillBBBPromoTemplate  the full catalog file uploaded once in Templates
//                         (purpose Promotions) — the promo's rows are filled
//                         and every other product row is taken out.
//
// Portal rules worth pre-checking (from the template's own header text):
// the promo MAP must be at least 1% below SITE_PRICE — violations are
// reported so they can be fixed before the portal rejects the upload.

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
import { parseCsvText } from '@/features/import/lib/parseSpreadsheet';
import { promotionMembersFor } from '@/features/pricing/api/promotions';
import { logActivity } from '@/features/activity/api/activityLog';
import { supabase } from '@/lib/supabase';

const ALIAS_MARKETPLACE = 'BB&B / Overstock';

/** Overstock SKU → PIM SKU for the promotion's members. */
async function loadAliasMap(skus) {
  const byAlias = new Map();
  for (let i = 0; i < skus.length; i += 200) {
    const { data, error } = await supabase
      .from('product_aliases')
      .select('sku, alias')
      .eq('marketplace', ALIAS_MARKETPLACE)
      .in('sku', skus.slice(i, i + 200));
    if (error) throw error;
    for (const a of data ?? []) if (a.alias) byAlias.set(norm(a.alias), a.sku);
  }
  return byAlias;
}

const HEADER_SCAN_ROWS = 10;
const norm = (v) => String(v ?? '').trim().toUpperCase();

function findHeader(grid) {
  for (let r = 0; r < Math.min(HEADER_SCAN_ROWS, grid.length); r++) {
    const cells = (grid[r] ?? []).map(norm);
    if (cells.includes('PARTNER_SKU') && cells.includes('PROMO_MAP')) return r;
  }
  return -1;
}

/**
 * Walk the grid and decide every fill: which rows get PROMO_MAP/PROMO_COST
 * and everything worth reporting. Format-agnostic — the CSV and XLSX writers
 * both consume the returned per-row fills.
 */
function planFills(grid, headerRow, bySku, byAlias = new Map()) {
  const header = (grid[headerRow] ?? []).map(norm);
  const skuCol = header.indexOf('PARTNER_SKU');
  const fullSkuCol = header.indexOf('FULL_SKU');
  const promoMapCol = header.indexOf('PROMO_MAP');
  const promoCostCol = header.indexOf('PROMO_COST');
  const sitePriceCol = header.indexOf('SITE_PRICE');
  if (promoCostCol === -1) {
    throw new Error('The template has no PROMO_COST column — unexpected layout.');
  }

  const fills = new Map(); // 0-based row index → { map, cost }
  const fileSkus = new Set();
  const notInPromo = [];
  const missingData = [];
  const mapViolations = [];

  for (let i = headerRow + 1; i < grid.length; i++) {
    const partner = String(grid[i]?.[skuCol] ?? '').trim();
    if (!partner) continue;
    // Part number as written, else the Overstock SKU through the alias
    // (covers casing/dash differences like A-914Bk or D-701H-2).
    const viaAlias = fullSkuCol !== -1 ? byAlias.get(norm(grid[i]?.[fullSkuCol])) : undefined;
    const sku = bySku.has(partner) ? partner : (viaAlias ?? partner);
    fileSkus.add(sku);
    const promo = bySku.get(sku);
    if (!promo) {
      notInPromo.push(partner);
      continue;
    }
    // The portal demands a value in every cell of a submitted row.
    if (promo.map == null || promo.cost == null) {
      missingData.push(`${sku} (${promo.map == null ? 'promo MAP' : 'promo cost'} missing)`);
      continue;
    }
    const sitePrice = sitePriceCol !== -1 ? Number(grid[i]?.[sitePriceCol]) : NaN;
    if (Number.isFinite(sitePrice) && sitePrice > 0 && promo.map > sitePrice * 0.99 + 1e-9) {
      mapViolations.push(`${sku} ($${promo.map} vs site $${sitePrice})`);
    }
    fills.set(i, { map: Number(promo.map), cost: Number(promo.cost) });
  }

  if (!fills.size) {
    throw new Error('No file rows matched this promotion\'s SKUs — check that the file belongs to this promo.');
  }
  return { fills, skuCol, promoMapCol, promoCostCol, fileSkus, notInPromo, missingData, mapViolations };
}

const csvQuote = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function downloadCsv(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Fill the promotion file the portal handed out for this promo.
 * `file` is anything with .name, .text() and .arrayBuffer() (a File or a
 * downloaded template Blob wrapped with its name).
 * `trim`: take out every product row that is not in the promotion (used
 * when the file is the full-catalog template, see fillBBBPromoTemplate).
 */
export async function fillBBBPromoFile(file, promotion, { trim = false } = {}) {
  const { rows: prices, excluded } = await promotionMembersFor(promotion, 'bbb');
  const bySku = new Map(
    prices
      .filter((r) => r.promo_price_usd != null || r.promo_costs?.lowes_sod_bbb_usd != null)
      .map((r) => [r.sku, { map: r.promo_price_usd ?? null, cost: r.promo_costs?.lowes_sod_bbb_usd ?? null }]),
  );
  if (!bySku.size) {
    throw new Error('This promotion has no US promo MAP or Lowes/SOD/BB&B promo costs loaded.');
  }
  const byAlias = await loadAliasMap([...bySku.keys()]);

  const isCsv = /\.csv$/i.test(file.name);
  const baseName = `BBB_Overstock_Promo_${String(promotion.period).slice(0, 7)}`;
  let plan;

  if (isCsv) {
    const text = await file.text();
    const hadBom = text.charCodeAt(0) === 0xfeff;
    const grid = parseCsvText(text);
    const headerRow = findHeader(grid);
    if (headerRow === -1) {
      throw new Error('No PARTNER_SKU / PROMO_MAP header found — upload the promotion file downloaded from the BB&B / Overstock portal.');
    }
    plan = planFills(grid, headerRow, bySku, byAlias);
    for (const [rowIdx, f] of plan.fills) {
      const row = grid[rowIdx];
      while (row.length <= Math.max(plan.promoMapCol, plan.promoCostCol)) row.push('');
      row[plan.promoMapCol] = f.map;
      row[plan.promoCostCol] = f.cost;
    }
    // Trimming keeps the instruction rows, the header and the promo's rows only.
    const kept = trim ? grid.filter((_, i) => i <= headerRow || plan.fills.has(i)) : grid;
    const out = kept.map((row) => row.map(csvQuote).join(',')).join('\r\n');
    downloadCsv(`${baseName}.csv`, (hadBom ? '﻿' : '') + out);
  } else {
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const sharedFile = zip.file('xl/sharedStrings.xml');
    const shared = parseSharedStrings(sharedFile ? await sharedFile.async('string') : '');

    // Find the sheet that carries the promo table — scan for the header row
    // instead of trusting a sheet name.
    let path = null;
    let grid = null;
    let headerRow = -1;
    const workbookXml = await zip.file('xl/workbook.xml').async('string');
    for (const name of listSheetNames(workbookXml)) {
      const p = await sheetPathByName(zip, name);
      if (!p) continue;
      const g = sheetToGrid(await zip.file(p).async('string'), shared);
      const h = findHeader(g);
      if (h !== -1) { path = p; grid = g; headerRow = h; break; }
    }
    if (!path) {
      throw new Error('No PARTNER_SKU / PROMO_MAP header found — upload the promotion file downloaded from the BB&B / Overstock portal.');
    }

    plan = planFills(grid, headerRow, bySku, byAlias);
    const cellsByRow = new Map();
    for (const [rowIdx, f] of plan.fills) {
      const rowNum = rowIdx + 1; // grid is 0-based; sheet rows and columns are 1-based
      cellsByRow.set(rowNum, new Map([
        [plan.promoMapCol + 1, buildCell(`${indexToCol(plan.promoMapCol + 1)}${rowNum}`, f.map)],
        [plan.promoCostCol + 1, buildCell(`${indexToCol(plan.promoCostCol + 1)}${rowNum}`, f.cost)],
      ]));
    }
    let sheetXml = mergeRows(await zip.file(path).async('string'), cellsByRow);
    if (trim) {
      const gone = [];
      for (let i = headerRow + 1; i < grid.length; i++) {
        if (String(grid[i]?.[plan.skuCol] ?? '').trim() && !plan.fills.has(i)) gone.push(i + 1);
      }
      sheetXml = removeRows(sheetXml, gone);
    }
    zip.file(path, sheetXml);
    await downloadZip(zip, baseName, /\.xlsm$/i.test(file.name) ? 'xlsm' : 'xlsx');
  }

  const notInFile = [...bySku.keys()].filter((s) => !plan.fileSkus.has(s)).sort();
  const filled = plan.fills.size;

  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: 'bbb',
    summary: trim
      ? `Generated the BB&B / Overstock promo file for "${promotion.name}" from the catalog template (${filled} rows kept)`
      : `Filled BB&B / Overstock promo template for "${promotion.name}" (${filled} rows)`,
    metadata: {
      filled,
      trimmed: trim,
      removed: trim ? plan.notInPromo.length : 0,
      format: isCsv ? 'csv' : 'xlsx',
      file_rows: plan.fileSkus.size,
      not_in_promo: plan.notInPromo.length,
      not_in_file: notInFile.length,
      missing_data: plan.missingData.length,
      map_violations: plan.mapViolations.length,
    },
  });

  return {
    excluded,
    filled,
    trimmed: trim,
    fileRows: plan.fileSkus.size,
    notInPromo: plan.notInPromo,
    notInFile,
    missingData: plan.missingData,
    mapViolations: plan.mapViolations,
  };
}

/**
 * Generate the promo file from the full-catalog file uploaded in Templates
 * (BB&B / Overstock, purpose Promotions): the promotion's rows get
 * PROMO_MAP / PROMO_COST, every other product row is taken out. The other
 * columns (SITE_PRICE, FIRST_COST, MAP_PRICE) are whatever the template
 * carried the day it was uploaded.
 */
export async function fillBBBPromoTemplate(template, promotion) {
  const { data: blob, error } = await supabase.storage.from('templates').download(template.storage_path);
  if (error) throw new Error(`Failed to download template: ${error.message}`);
  const file = { name: template.file_name, text: () => blob.text(), arrayBuffer: () => blob.arrayBuffer() };
  return fillBBBPromoFile(file, promotion, { trim: true });
}

export function summarizeBBBFill(channel, r) {
  const parts = [`${channel.label} file ready — ${r.filled} promo rows kept, ${r.notInPromo.length} other products taken out`];
  if (r.notInFile.length) parts.push(`promo members not in the template: ${r.notInFile.slice(0, 8).join(', ')}${r.notInFile.length > 8 ? '…' : ''}`);
  if (r.missingData.length) parts.push(`skipped, incomplete promo data: ${r.missingData.join(', ')}`);
  if (r.mapViolations.length) parts.push(`promo MAP not 1% below the template's site price: ${r.mapViolations.join(', ')}`);
  if (r.excluded?.length) parts.push(`${r.excluded.length} excluded from BB&B / Overstock`);
  return parts.join(' · ');
}
