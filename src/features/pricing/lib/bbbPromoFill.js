// Fill the BB&B / Overstock promotion template from a PIM promotion.
//
// The file is downloaded fresh from their portal (the user pastes the promo's
// part numbers there first — the Copy SKUs button), so it already carries the
// site's own data: FULL_SKU, SITE_PRICE, FIRST_COST, current MAP, categories.
// Only two columns are ours to fill, from row 5 down:
//   PROMO_MAP  (col H) = the promotion's US promo MAP  (promo_price_usd)
//   PROMO_COST (col I) = the promo first cost           (promo_costs.lowes_sod_bbb_usd)
// Matching runs on PARTNER_SKU (col C). Rows are never added or removed —
// the portal decides which SKUs are eligible; we report mismatches instead.
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
  downloadZip,
  indexToCol,
} from '@/features/syndication/exports/templateFiller';
import { getPromotionPrices } from '@/features/pricing/api/promotions';
import { logActivity } from '@/features/activity/api/activityLog';

const HEADER_SCAN_ROWS = 10;
const norm = (v) => String(v ?? '').trim().toUpperCase();

export async function fillBBBPromoFile(file, promotion) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const sharedFile = zip.file('xl/sharedStrings.xml');
  const shared = parseSharedStrings(sharedFile ? await sharedFile.async('string') : '');

  // Find the sheet that carries the promo table — scan for the header row
  // with PARTNER_SKU + PROMO_MAP instead of trusting a sheet name.
  let path = null;
  let grid = null;
  let headerRow = -1;
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  for (const name of listSheetNames(workbookXml)) {
    const p = await sheetPathByName(zip, name);
    if (!p) continue;
    const g = sheetToGrid(await zip.file(p).async('string'), shared);
    for (let r = 0; r < Math.min(HEADER_SCAN_ROWS, g.length); r++) {
      const cells = (g[r] ?? []).map(norm);
      if (cells.includes('PARTNER_SKU') && cells.includes('PROMO_MAP')) {
        path = p;
        grid = g;
        headerRow = r;
        break;
      }
    }
    if (path) break;
  }
  if (!path) {
    throw new Error('No PARTNER_SKU / PROMO_MAP header found — upload the promotion template downloaded from the BB&B / Overstock portal.');
  }

  const header = (grid[headerRow] ?? []).map(norm);
  const col = (label) => header.indexOf(label);
  const skuCol = col('PARTNER_SKU');
  const promoMapCol = col('PROMO_MAP');
  const promoCostCol = col('PROMO_COST');
  const sitePriceCol = col('SITE_PRICE');
  if (promoCostCol === -1) {
    throw new Error('The template has no PROMO_COST column — unexpected layout.');
  }

  const prices = await getPromotionPrices(promotion.id);
  const bySku = new Map(
    prices
      .filter((r) => r.promo_price_usd != null || r.promo_costs?.lowes_sod_bbb_usd != null)
      .map((r) => [r.sku, { map: r.promo_price_usd ?? null, cost: r.promo_costs?.lowes_sod_bbb_usd ?? null }]),
  );
  if (!bySku.size) {
    throw new Error('This promotion has no US promo MAP or Lowes/SOD/BB&B promo costs loaded.');
  }

  const cellsByRow = new Map();
  const fileSkus = new Set();
  const notInPromo = [];
  const missingData = [];
  const mapViolations = [];
  let filled = 0;

  for (let i = headerRow + 1; i < grid.length; i++) {
    const sku = String(grid[i]?.[skuCol] ?? '').trim();
    if (!sku) continue;
    fileSkus.add(sku);
    const promo = bySku.get(sku);
    if (!promo) {
      notInPromo.push(sku);
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
    const rowNum = i + 1;
    // grid indexes are 0-based; indexToCol / mergeRows keys are 1-based.
    cellsByRow.set(rowNum, new Map([
      [promoMapCol + 1, buildCell(`${indexToCol(promoMapCol + 1)}${rowNum}`, Number(promo.map))],
      [promoCostCol + 1, buildCell(`${indexToCol(promoCostCol + 1)}${rowNum}`, Number(promo.cost))],
    ]));
    filled += 1;
  }

  if (!filled) {
    throw new Error('No file rows matched this promotion\'s SKUs — check that the file belongs to this promo.');
  }

  zip.file(path, mergeRows(await zip.file(path).async('string'), cellsByRow));

  const notInFile = [...bySku.keys()].filter((s) => !fileSkus.has(s)).sort();

  const baseName = `BBB_Overstock_Promo_${String(promotion.period).slice(0, 7)}`;
  await downloadZip(zip, baseName, /\.xlsm$/i.test(file.name) ? 'xlsm' : 'xlsx');

  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: 'bbb',
    summary: `Filled BB&B / Overstock promo template for "${promotion.name}" (${filled} rows)`,
    metadata: {
      filled,
      file_rows: fileSkus.size,
      not_in_promo: notInPromo.length,
      not_in_file: notInFile.length,
      missing_data: missingData.length,
      map_violations: mapViolations.length,
    },
  });

  return { filled, fileRows: fileSkus.size, notInPromo, notInFile, missingData, mapViolations };
}
