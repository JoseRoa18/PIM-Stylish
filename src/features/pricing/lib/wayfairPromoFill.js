// Fill Wayfair's Partner Home PROMOTIONS file from a PIM promotion.
//
// The monthly file is uploaded fresh from Partner Home (chosen flow: it
// carries Wayfair's complete "Current" info for its rows plus the tracking
// processId) and gets filled in place (JSZip XML edit), never rebuilt:
//   - rows already in the file get their promo columns filled
//   - promotion members missing from the file are APPENDED, validated
//     against what Wayfair actually lists (latest API audit snapshot),
//     carrying the PIM's MAP/MSRP (the API exposes no pricing)
//   - members Wayfair doesn't carry are skipped and reported
//
// Fill rule (confirmed against the July submission):
//   A = SKU · K (B2C Promotion Discount %) = 0
//   L (B2C Promotion Base Cost USD) = the promotion's wayfair_ca_usd cost
//   M (Promotional MAP USD) = left empty (Canada supplier)

import { supabase } from '@/lib/supabase';
import {
  loadJSZip,
  parseSharedStrings,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  mergeRows,
  injectRows,
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
    throw new Error('No "Promotions" sheet found — upload the promotions file downloaded from Wayfair Partner Home.');
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

  let merged = mergeRows(xml, cellsByRow);

  // Members missing from the template: append them as new rows — but only
  // those Wayfair actually lists (latest API audit snapshot, 2×/day); a SKU
  // Wayfair doesn't carry has no business in the event file.
  const notInTemplate = [...costBySku.keys()].filter((s) => !templateSkus.has(s)).sort();
  let toAppend = notInTemplate;
  let notOnWayfair = [];
  const { data: snaps } = await supabase
    .from('channel_health')
    .select('results')
    .eq('channel', 'wayfair')
    .order('run_at', { ascending: false })
    .limit(1);
  if (snaps?.length) {
    const listed = new Set((snaps[0].results ?? []).map((r) => r.sku));
    toAppend = notInTemplate.filter((s) => listed.has(s));
    notOnWayfair = notInTemplate.filter((s) => !listed.has(s));
  }

  let lastRow = FIRST_DATA_ROW - 1;
  for (let i = grid.length - 1; i >= 0; i--) {
    if (String(grid[i]?.[0] ?? '').trim()) { lastRow = i + 1; break; }
  }
  if (toAppend.length) {
    // Wayfair's API exposes no pricing, so the "Current" info columns of
    // appended rows come from the PIM — the source of truth those values
    // are supposed to mirror anyway: H = Current MAP (CAD), I = Current
    // MSRP (CAD). Status/base-cost/B2B stay blank (Wayfair-side data).
    const { data: pimRows } = await supabase
      .from('products')
      .select('sku, map_cad, msrp_cad')
      .in('sku', toAppend);
    const pimBySku = new Map((pimRows ?? []).map((p) => [p.sku, p]));

    let rowsXml = '';
    for (const [idx, sku] of toAppend.entries()) {
      const rn = lastRow + 1 + idx;
      const pim = pimBySku.get(sku);
      rowsXml += `<row r="${rn}">` +
        buildCell(`A${rn}`, sku) +
        (pim?.map_cad != null ? buildCell(`H${rn}`, Number(pim.map_cad)) : '') +
        (pim?.msrp_cad != null ? buildCell(`I${rn}`, Number(pim.msrp_cad)) : '') +
        buildCell(`K${rn}`, 0) +
        buildCell(`L${rn}`, costBySku.get(sku)) +
        '</row>';
    }
    merged = injectRows(merged, rowsXml, lastRow + toAppend.length);
  }
  zip.file(path, merged);

  const baseName = `Wayfair_Promotions_${String(promotion.period).slice(0, 7)}`;
  await downloadZip(zip, baseName, /\.xlsm$/i.test(file.name) ? 'xlsm' : 'xlsx');

  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: 'wayfair',
    summary: `Filled Wayfair promotions template for "${promotion.name}" (${filled} rows)`,
    metadata: {
      filled,
      appended: toAppend.length,
      template_rows: templateSkus.size,
      not_on_wayfair: notOnWayfair.length,
    },
  });

  return { filled, appended: toAppend, templateRows: templateSkus.size, notOnWayfair };
}
