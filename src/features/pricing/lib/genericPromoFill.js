// Fill a marketplace's PROMOTIONS template (uploaded in /templates with the
// purpose "Promotions") from a PIM promotion, without a hand-written mapping
// per marketplace: the header row is found by scanning every sheet, and the
// columns are recognized by what their headers say (SKU, promo price, promo
// cost, start, end, regular MAP). Anything the template asks for beyond
// those stays blank and is reported, so a new file's real layout can be
// mapped precisely once it has been seen.
//
// Rows: rows that already carry a SKU are filled in place; promotion members
// the file does not list are appended below the last row.

import { supabase } from '@/lib/supabase';
import {
  openTemplate,
  listSheetNames,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  mergeRows,
  injectRows,
  downloadZip,
  templateExt,
  indexToCol,
  norm,
} from '@/features/syndication/exports/templateFiller';
import { getPromotionPrices } from '@/features/pricing/api/promotions';
import { promoWindow } from '@/features/pricing/lib/promoCalendar';
import { logActivity } from '@/features/activity/api/activityLog';

const HEADER_SCAN_ROWS = 15;

// Header recognizers, on normalized text (lower-case, letters and digits only).
const RULES = {
  sku: (h) => /^(partner|supplier|vendor|seller|merchant|shop|manufacturer)?(sku|skuid|partnumber|partno|itemnumber|itemno|itemid|item|mpn|modelnumber|modelno|productid|vendorpartnumber|supplierpartnumber)$/.test(h),
  promoPrice: (h) => /promo.*(price|map)|(sale|event|deal|special|discounted|promotional|promotion)(price|map)|promotionalmap|dealprice|eventmap/.test(h) && !/cost/.test(h),
  cost: (h) => /(promo|event|promotional|promotion|sale|deal|discount)(base)?(cost|firstcost|wholesale)|basecost|firstcost|promocost/.test(h),
  start: (h) => /(start|begin|effective|from)(date|day)|(date|day).*(start|begin)|startdate/.test(h),
  end: (h) => /(end|expir|through|thru|until|to)(date|day)|(date|day).*(end|expir)|enddate|expirationdate/.test(h),
  map: (h) => /^(current|regular|list|standard)?(map|mapprice|regularprice|listprice|currentmap|retailprice)$/.test(h),
};
const ROLE_ORDER = ['sku', 'promoPrice', 'cost', 'start', 'end', 'map'];

function mapHeader(row) {
  const cols = {};
  const taken = new Set();
  for (const role of ROLE_ORDER) {
    for (let c = 0; c < row.length; c++) {
      if (taken.has(c)) continue;
      const h = norm(row[c] ?? '');
      if (!h) continue;
      if (RULES[role](h)) { cols[role] = c; taken.add(c); break; }
    }
  }
  return cols;
}

function findHeader(grid) {
  for (let r = 0; r < Math.min(HEADER_SCAN_ROWS, grid.length); r++) {
    const cols = mapHeader(grid[r] ?? []);
    if (cols.sku != null && (cols.promoPrice != null || cols.cost != null)) return { row: r, cols };
  }
  return null;
}

const fmtDate = (iso, style) => {
  if (style === 'mdy') { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; }
  return iso;
};

/**
 * @param template  marketplace_templates row (purpose "promotions")
 * @param promotion promotions row
 * @param channel   PROMO_CHANNELS entry (market, costSlug, label, key)
 */
export async function fillPromoTemplate(template, promotion, channel) {
  if (/\.csv$/i.test(template.file_name ?? '')) {
    throw new Error('CSV promotion templates are not supported yet. Upload the marketplace\'s XLSX version.');
  }
  const { zip, shared } = await openTemplate(template.storage_path);
  const workbookXml = await zip.file('xl/workbook.xml').async('string');

  let hit = null;
  for (const name of listSheetNames(workbookXml)) {
    const path = await sheetPathByName(zip, name);
    if (!path) continue;
    const xml = await zip.file(path).async('string');
    const grid = sheetToGrid(xml, shared);
    const h = findHeader(grid);
    if (h) { hit = { name, path, xml, grid, ...h }; break; }
  }
  if (!hit) {
    throw new Error(`No sheet in "${template.file_name}" has a SKU column next to a promo price or promo cost column. Send me the file and I map its columns.`);
  }

  const priceKey = channel.market === 'us' ? 'promo_price_usd' : 'promo_price_cad';
  const mapKey = channel.market === 'us' ? 'map_usd' : 'map_cad';
  const prices = await getPromotionPrices(promotion.id);
  const members = prices
    .map((r) => ({ sku: r.sku, price: r[priceKey] ?? null, cost: channel.costSlug ? r.promo_costs?.[channel.costSlug] ?? null : null }))
    .filter((m) => m.price != null || m.cost != null);
  if (!members.length) {
    throw new Error(`This promotion has no ${channel.market === 'us' ? 'USA' : 'Canada'} prices${channel.costSlug ? ' or costs' : ''} loaded.`);
  }
  const bySku = new Map(members.map((m) => [m.sku, m]));

  const mapBySku = new Map();
  if (hit.cols.map != null) {
    const skus = members.map((m) => m.sku);
    for (let i = 0; i < skus.length; i += 100) {
      const { data } = await supabase.from('products').select(`sku, map:${mapKey}`).in('sku', skus.slice(i, i + 100));
      for (const p of data ?? []) mapBySku.set(p.sku, p.map);
    }
  }
  const window = promoWindow(promotion, channel.market);
  const dateStyle = channel.dateStyle ?? 'iso';

  const cellsFor = (rowNum, m) => {
    const cells = new Map();
    const put = (role, value) => {
      const c = hit.cols[role];
      if (c == null || value == null || value === '') return;
      cells.set(c + 1, buildCell(`${indexToCol(c + 1)}${rowNum}`, value));
    };
    put('promoPrice', m.price);
    put('cost', m.cost);
    put('start', fmtDate(window.start, dateStyle));
    put('end', fmtDate(window.end, dateStyle));
    put('map', mapBySku.get(m.sku) ?? null);
    return cells;
  };

  // Rows already in the file: fill the ones that are promo members.
  const cellsByRow = new Map();
  const fileSkus = new Set();
  let lastRow = hit.row + 1;
  for (let i = hit.row + 1; i < hit.grid.length; i++) {
    const sku = String(hit.grid[i]?.[hit.cols.sku] ?? '').trim();
    if (!sku) continue;
    lastRow = i + 1;
    fileSkus.add(sku);
    const m = bySku.get(sku);
    if (!m) continue;
    cellsByRow.set(i + 1, cellsFor(i + 1, m));
  }
  let merged = cellsByRow.size ? mergeRows(hit.xml, cellsByRow) : hit.xml;

  // Members the file does not carry: append them.
  const toAppend = members.filter((m) => !fileSkus.has(m.sku));
  if (toAppend.length) {
    let rowsXml = '';
    for (const [idx, m] of toAppend.entries()) {
      const rn = lastRow + 1 + idx;
      const cells = cellsFor(rn, m);
      cells.set(hit.cols.sku + 1, buildCell(`${indexToCol(hit.cols.sku + 1)}${rn}`, m.sku));
      rowsXml += `<row r="${rn}">` + [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('') + '</row>';
    }
    merged = injectRows(merged, rowsXml, lastRow + toAppend.length);
  }
  zip.file(hit.path, merged);

  const period = String(promotion.period).slice(0, 7);
  const baseName = `${channel.label.replace(/[^\w]+/g, '_')}_Promo_${period}`;
  await downloadZip(zip, baseName, templateExt(template.storage_path));

  const columns = Object.fromEntries(Object.entries(hit.cols).map(([role, c]) => [role, indexToCol(c + 1)]));
  const wanted = ['promoPrice', ...(channel.costSlug ? ['cost'] : []), 'start', 'end'];
  const missing = wanted.filter((role) => hit.cols[role] == null);
  const report = { sheet: hit.name, columns, missing, filled: cellsByRow.size, appended: toAppend.length, fileRows: fileSkus.size };

  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: channel.key,
    summary: `Filled ${channel.label} promotions template for "${promotion.name}" (${report.filled} rows filled, ${report.appended} added)`,
    metadata: { template: template.file_name, ...report },
  });
  return report;
}

/** One-line result for the promo card. */
export function summarizePromoFill(channel, r) {
  const parts = [`${channel.label} file ready. ${r.filled} rows filled, ${r.appended} added, sheet "${r.sheet}"`];
  const names = { promoPrice: 'promo price', cost: 'promo cost', start: 'start date', end: 'end date', map: 'regular MAP', sku: 'SKU' };
  parts.push('columns: ' + Object.entries(r.columns).map(([role, col]) => `${names[role]} ${col}`).join(', '));
  if (r.missing.length) parts.push(`not found in the template: ${r.missing.map((m) => names[m]).join(', ')}`);
  return parts.join(' · ');
}
