// Fill Wayfair's Partner Home PROMOTIONS template from a PIM promotion.
//
// The monthly file is downloaded fresh from Partner Home: Wayfair pre-fills
// its own SKU list (cols A-J, do not edit) and a hidden WAYFAIR_USE_ONLY
// sheet carries a per-download processId — so this NEVER builds a file from
// scratch; it fills the user's uploaded template in place (JSZip XML edit,
// same architecture as every marketplace export).
//
// Fill rule (confirmed against the July submission):
//   K (B2C Promotion Discount %)   = 0
//   L (B2C Promotion Base Cost USD) = the promotion's wayfair_ca_usd cost
//   M (Promotional MAP USD)         = left empty (Canada supplier)
// Rows whose SKU isn't in the promotion stay untouched.

import {
  loadJSZip,
  parseSharedStrings,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  mergeRows,
  downloadZip,
} from '@/features/syndication/exports/templateFiller';
import { getPromotionPrices } from '@/features/pricing/api/promotions';
import { logActivity } from '@/features/activity/api/activityLog';

const HEADER_ROW = 2; // technical names: SupplierPartNumber, ..., PromotionalDiscountPercent
const FIRST_DATA_ROW = 5;

export async function fillWayfairPromoFile(file, promotion) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const sharedFile = zip.file('xl/sharedStrings.xml');
  const shared = parseSharedStrings(sharedFile ? await sharedFile.async('string') : '');

  const path = await sheetPathByName(zip, 'Promotions');
  if (!path) {
    throw new Error('No "Promotions" sheet found — upload the promotions template downloaded from Wayfair Partner Home.');
  }
  const xml = await zip.file(path).async('string');
  const grid = sheetToGrid(xml, shared);

  const header = grid[HEADER_ROW - 1] ?? [];
  if (String(header[0]).trim() !== 'SupplierPartNumber' ||
      String(header[10]).trim() !== 'PromotionalDiscountPercent' ||
      String(header[11]).trim() !== 'PromotionalDiscountBaseCost') {
    throw new Error('Unexpected column layout — this doesn\'t look like Wayfair\'s promotions template.');
  }

  const prices = await getPromotionPrices(promotion.id);
  const costBySku = new Map(
    prices
      .filter((r) => r.promo_costs?.wayfair_ca_usd != null)
      .map((r) => [r.sku, r.promo_costs.wayfair_ca_usd]),
  );
  if (!costBySku.size) {
    throw new Error('This promotion has no Wayfair Canada (USD) promo costs loaded.');
  }

  const cellsByRow = new Map();
  const templateSkus = new Set();
  let filled = 0;
  for (let i = FIRST_DATA_ROW - 1; i < grid.length; i++) {
    const sku = String(grid[i]?.[0] ?? '').trim();
    if (!sku) continue;
    templateSkus.add(sku);
    const cost = costBySku.get(sku);
    if (cost == null) continue;
    const rowNum = i + 1;
    cellsByRow.set(rowNum, new Map([
      [11, buildCell(`K${rowNum}`, 0)],
      [12, buildCell(`L${rowNum}`, cost)],
    ]));
    filled += 1;
  }

  zip.file(path, mergeRows(xml, cellsByRow));

  const notInTemplate = [...costBySku.keys()].filter((s) => !templateSkus.has(s)).sort();
  const ext = /\.xlsm$/i.test(file.name) ? 'xlsm' : 'xlsx';
  const baseName = `Wayfair_Promotions_${String(promotion.period).slice(0, 7)}_filled`;
  await downloadZip(zip, baseName, ext);

  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: 'wayfair',
    summary: `Filled Wayfair promotions template for "${promotion.name}" (${filled} rows)`,
    metadata: { filled, template_rows: templateSkus.size, not_in_template: notInTemplate.length },
  });

  return { filled, templateRows: templateSkus.size, notInTemplate };
}
