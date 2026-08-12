// Generate Wayfair's Partner Home PROMOTIONS file from a PIM promotion —
// same one-click flow as the listing exports: the template lives in the
// Templates system (marketplace "Wayfair Promotions") and gets filled in
// place (JSZip XML edit), never rebuilt. When Wayfair issues a new file
// (new SKU list / processId), replace it in the Templates page.
//
// Fill rule (confirmed against the July submission):
//   K (B2C Promotion Discount %)   = 0
//   L (B2C Promotion Base Cost USD) = the promotion's wayfair_ca_usd cost
//   M (Promotional MAP USD)         = left empty (Canada supplier)
// Rows whose SKU isn't in the promotion stay untouched.

import { supabase } from '@/lib/supabase';
import {
  openTemplate,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  mergeRows,
  downloadZip,
  templateExt,
} from '@/features/syndication/exports/templateFiller';
import { getPromotionPrices } from '@/features/pricing/api/promotions';
import { logActivity } from '@/features/activity/api/activityLog';

const HEADER_ROW = 2; // technical names: SupplierPartNumber, ..., PromotionalDiscountPercent
const FIRST_DATA_ROW = 5;

export async function generateWayfairPromoFile(promotion) {
  const { data: templates, error: tErr } = await supabase
    .from('marketplace_templates')
    .select('storage_path, file_name')
    .eq('marketplace', 'Wayfair Promotions')
    .order('uploaded_at', { ascending: false })
    .limit(1);
  if (tErr) throw tErr;
  if (!templates?.length) {
    throw new Error('No "Wayfair Promotions" template uploaded — add it in the Templates page first.');
  }
  const template = templates[0];

  const { zip, shared } = await openTemplate(template.storage_path);

  const path = await sheetPathByName(zip, 'Promotions');
  if (!path) {
    throw new Error('The stored template has no "Promotions" sheet — replace it in the Templates page with the file from Wayfair Partner Home.');
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
  const baseName = `Wayfair_Promotions_${String(promotion.period).slice(0, 7)}`;
  await downloadZip(zip, baseName, templateExt(template.storage_path));

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
