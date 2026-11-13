// Price Alignment → Export (user, 2026-11-13): the channel's list on screen as
// an Excel, with every detail the PIM has on each row. Loaded on click from
// the Pricing page; the sheets are in lib/alignmentExcel.js. The report itself
// is the one on screen — nothing is pulled from the store again: only the
// products' own data, the promotions' names, and our stock and sales are read.

import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { buildSectionedWorkbook } from '@/features/import/lib/sectionedXlsx';
import { CATEGORY_OPTIONS } from '@/features/products/lib/categories';
import { PROMOTION_KINDS } from './promotions';
import { loadExpectedPrices } from './expectedPrices';
import { alignmentSheets, alignmentFileName } from '../lib/alignmentExcel';

const PAGE = 1000;
const CATEGORY = new Map(CATEGORY_OPTIONS.map((c) => [c.value, c.label]));

// Every row of a query, page after page (the API returns at most 1,000), in a
// unique order so no row is read twice or skipped.
async function readAll(table, columns, { filter = (q) => q, order }) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = filter(supabase.from(table).select(columns));
    for (const o of order) q = q.order(o);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// Several reads at once; `task` (optional taskProgress reporter) counts the
// settled ones.
function settleAll(reads, task, detail) {
  let done = 0;
  task?.count(0, reads.length, detail);
  return Promise.all(reads.map((p) => p.then((rows) => {
    done += 1;
    task?.count(done, reads.length, detail);
    return rows;
  })));
}

async function loadDetails(cfg, task = null) {
  // The channel's own currency: the price levels shown are the ones it is compared with.
  const cur = cfg.priceField.endsWith('usd') ? 'usd' : 'cad';
  const market = cfg.market === 'us' ? 'us' : 'ca';
  const followsPromos = cfg.promoAware !== false;
  const [products, expected, monthly, stock, sales] = await settleAll([
    readAll('products', `sku, model_name, brand, category, is_obsolete, upc:attributes->>upc, map:map_${cur}, map_orange:map_orange_${cur}, map_purple:map_purple_${cur}, msrp:msrp_${cur}`, { order: ['sku'] }),
    // The promotion behind each expected price (its kind, name and days in this market).
    followsPromos ? loadExpectedPrices(cfg) : Promise.resolve({ promoBySku: new Map() }),
    followsPromos
      ? readAll('promotions', 'id, name, period', { filter: (q) => q.eq('kind', 'monthly').eq('status', 'active'), order: ['id'] })
      : Promise.resolve([]),
    readAll('product_inventory', 'sku, available', { filter: (q) => q.eq('market', market), order: ['sku'] }),
    readAll('product_sales', 'sku, units_30, units_90', { filter: (q) => q.eq('market', market), order: ['sku'] }),
  ], task, 'Reading the products, the promotions, our stock and sales…');
  return {
    products,
    promoBySku: expected.promoBySku,
    monthlyNames: new Map(monthly.map((p) => [p.period, p.name])),
    stock: new Map(stock.map((r) => [r.sku, Number(r.available ?? 0)])),
    sales: new Map(sales.map((r) => [r.sku, r])),
  };
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Build and download the Price Alignment Excel of one channel from the report
 * on screen; returns { problems, compared, leftOut, fileName }. `task`
 * (optional taskProgress reporter): the reads 50%, the sheets 5%, writing the
 * workbook the rest.
 */
export async function downloadAlignmentExcel(cfg, report, { task = null } = {}) {
  if (!report || report.legacy) throw new Error('There is no report to export yet — run the analysis first.');
  const data = await loadDetails(cfg, task?.part(0, 0.5));
  if (task) await task.step('Building the sheets…');
  const date = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, the person's own day
  const sheets = alignmentSheets({ cfg, report, data, labels: { category: (key) => CATEGORY.get(key) ?? key, kind: PROMOTION_KINDS }, date });
  task?.progress(0.55);
  const blob = await buildSectionedWorkbook(sheets, { task: task?.part(0.55, 1) });
  const fileName = alignmentFileName(cfg, date);
  downloadBlob(blob, fileName);
  // The page's own numbers: "Problems (N)" and the products compared.
  const result = {
    problems: report.problems?.length ?? 0,
    compared: report.total ?? 0,
    leftOut: report.leftOut?.length ?? 0,
    fileName,
  };
  logActivity({
    action: 'export',
    entityType: 'channel',
    entityId: cfg.key ?? cfg.channel ?? null,
    target: 'pim',
    summary: `Price Alignment Excel: ${cfg.label} — ${result.problems} problem${result.problems === 1 ? '' : 's'} of ${result.compared} products`,
    metadata: { problems: result.problems, compared: result.compared, left_out: result.leftOut },
  });
  return result;
}
