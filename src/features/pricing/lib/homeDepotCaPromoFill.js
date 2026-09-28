// Fill Home Depot Canada's NLP (promotion) workbook from a PIM promotion —
// one file per category the template was uploaded for (today: Kitchen
// Sinks, sheet "D29K"). Rules given by the user 2026-09-28, for monthly
// promotions and flash deals alike:
//
//   A Fiscal Week            left for whoever uploads the file
//   B Merchant               "Wendy Chan"
//   C Article #              Home Depot Canada's id (Aliases, "Home Depot CA")
//   D Article Description    the alias' listing title
//   E Unit of Measure        "EA"
//   F NLP Forecast           the Canada stock in the PIM (product_inventory)
//   G WAS Price              MAP Blue (map_cad)
//   H NLP Price              promo MAP of the promotion's level (Orange for a
//                            monthly promotion / flash deal, Purple for a
//                            special event); a price on the promotion's own
//                            list (promo_price_cad) wins
//   I Automatic Price-Up?    "Yes"
//   J Price Change %         the template's own formula, untouched
//   K Applicable Market      "ALL"
//   L NLP Duration           "30 Days"
//   M Funding Type           "Cost Reduction"
//   N Credit Per Unit        empty
//   O Old Cost               WC Blue (cost_cad_rona_hd)
//   P New Cost               WC of the level (cost_cad_rona_hd_<level>); a
//                            cost on the promotion's list
//                            (promo_costs.rona_hd_cad) wins
//   Q… everything else       empty
//
// The workbook ships every data row pre-formatted (J carries the formula),
// so lines are merged into the first empty rows under the header; new cells
// take the sheet's column styles (<cols>) so the formats survive. Members
// outside the template's categories (marketplace_templates.categories) are
// left out and reported, as are those without a Home Depot Canada id or
// without a promo price below MAP. The dropdown values are the sheet's own
// (EA / Yes / ALL / 30 Days / Cost Reduction).

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
import { promotionMembersFor, promotionLevel, levelLabel } from '@/features/pricing/api/promotions';
import { getStockFor } from '@/features/pricing/api/inventory';
import { logActivity } from '@/features/activity/api/activityLog';

const ALIAS_MARKETPLACE = 'Home Depot CA';
export const HDCA_CONSTANTS = {
  merchant: 'Wendy Chan',
  unit: 'EA',
  priceUp: 'Yes',
  market: 'ALL',
  duration: '30 Days',
  funding: 'Cost Reduction',
};

// Header recognizers on normalized text (lower-case, letters and digits).
const HEADERS = {
  merchant: /^merchant$/,
  article: /^article$/,
  description: /^articledescription/,
  unit: /^unitofmeasure/,
  forecast: /^nlpforecast/,
  wasPrice: /^wasprice/,
  nlpPrice: /^nlpprice/,
  priceUp: /^automaticpriceup/,
  market: /^applicablemarket/,
  duration: /^nlpduration$/,
  funding: /^fundingtype/,
  oldCost: /^oldcost/,
  newCost: /^newcost/,
};

function locate(grid) {
  for (let r = 0; r < Math.min(10, grid.length); r++) {
    const row = (grid[r] ?? []).map((v) => norm(v ?? ''));
    const cols = {};
    for (const [role, re] of Object.entries(HEADERS)) {
      const c = row.findIndex((h) => h && re.test(h));
      if (c !== -1) cols[role] = c;
    }
    if (cols.article != null && cols.nlpPrice != null && cols.wasPrice != null) return { headerRow: r, cols };
  }
  return null;
}

// The style each column gives its new cells (<cols> of the sheet), so a
// value written into an empty cell keeps the template's format.
function columnStyles(xml) {
  const styles = new Map();
  const cols = xml.match(/<cols>[\s\S]*?<\/cols>/)?.[0] ?? '';
  for (const m of cols.matchAll(/<col\b([^>]*)\/?>/g)) {
    const a = m[1];
    const min = Number((a.match(/\bmin="(\d+)"/) || [])[1]);
    const max = Number((a.match(/\bmax="(\d+)"/) || [])[1]);
    const style = (a.match(/\bstyle="(\d+)"/) || [])[1];
    if (!min || !max || !style) continue;
    for (let c = min; c <= max; c++) styles.set(c, style);
  }
  return styles;
}

const CATEGORY_LABELS = { kitchen_sink: 'Kitchen Sinks', bathroom_sink: 'Bath Sinks', kitchen_faucet: 'Kitchen Faucets', bathroom_faucet: 'Bath Faucets', accessory: 'Accessories', bar_prep_sink: 'Bar Sinks', laundry_sink: 'Laundry Sinks', outdoor_sink: 'Outdoor Sinks', colander_drying_rack: 'Colanders' };

/**
 * @param template  marketplace_templates row (Home Depot CA, purpose "promotions" or "flash_deals"; its categories pick the members)
 * @param promotion promotions row (kind decides the level: monthly and flash → Orange, special event → Purple)
 * @param channel   PROMO_CHANNELS entry for Home Depot Canada (key, label, market 'ca')
 */
export async function fillHomeDepotCaPromoTemplate(template, promotion, channel) {
  const { zip, shared } = await openTemplate(template.storage_path);
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  let hit = null;
  for (const name of listSheetNames(workbookXml)) {
    const path = await sheetPathByName(zip, name);
    if (!path) continue;
    const xml = await zip.file(path).async('string');
    const grid = sheetToGrid(xml, shared);
    const loc = locate(grid);
    if (loc) { hit = { name, path, xml, grid, ...loc }; break; }
  }
  if (!hit) throw new Error(`No sheet in "${template.file_name}" has the Home Depot Canada NLP columns (Article #, WAS Price, NLP Price). Send me the file and I map it.`);

  const tier = promotionLevel(promotion, channel);
  const promoMapField = `map_${tier}_cad`;
  const promoCostField = `cost_cad_rona_hd_${tier}`;
  const categories = new Set(template.categories ?? []);
  const { rows: members, excluded } = await promotionMembersFor(promotion, channel.key);
  if (!members.length) throw new Error('This promotion has no products.');
  const skus = members.map((r) => r.sku);

  const pim = new Map();
  const alias = new Map();
  for (let i = 0; i < skus.length; i += 100) {
    const chunk = skus.slice(i, i + 100);
    const [{ data: prods, error: pErr }, { data: aliases, error: aErr }] = await Promise.all([
      supabase.from('products').select(`sku, category, map_cad, ${promoMapField}, cost_cad_rona_hd, ${promoCostField}`).in('sku', chunk),
      supabase.from('product_aliases').select('sku, alias, listing_title').eq('marketplace', ALIAS_MARKETPLACE).in('sku', chunk),
    ]);
    if (pErr) throw pErr;
    if (aErr) throw aErr;
    for (const p of prods ?? []) pim.set(p.sku, p);
    for (const a of aliases ?? []) alias.set(a.sku, a);
  }
  const stock = (await getStockFor(skus)).ca ?? {};

  const lines = [];
  const otherCategory = [];
  const noAlias = [];
  const noMap = [];
  const noPromoMap = [];
  const atOrAbove = [];
  const under5 = [];
  const noCost = [];
  const noPromoCost = [];
  const noStock = [];
  let fromList = 0;
  for (const m of members) {
    const p = pim.get(m.sku) ?? {};
    if (categories.size && !categories.has(p.category)) { otherCategory.push(m.sku); continue; }
    const a = alias.get(m.sku);
    if (!a) { noAlias.push(m.sku); continue; }
    const map = p.map_cad != null ? Number(p.map_cad) : null;
    if (map == null) { noMap.push(m.sku); continue; }
    const listed = m.promo_price_cad != null ? Number(m.promo_price_cad) : null;
    const promoMap = listed ?? (p[promoMapField] != null ? Number(p[promoMapField]) : null);
    if (promoMap == null) { noPromoMap.push(m.sku); continue; }
    if (promoMap >= map) { atOrAbove.push(m.sku); continue; }
    if (listed != null) fromList += 1;
    if ((map - promoMap) / map < 0.05) under5.push(m.sku);
    const regularCost = p.cost_cad_rona_hd != null ? Number(p.cost_cad_rona_hd) : null;
    const listedCost = m.promo_costs?.rona_hd_cad;
    const promoCost = listedCost != null ? Number(listedCost) : p[promoCostField] != null ? Number(p[promoCostField]) : null;
    if (regularCost == null) noCost.push(m.sku);
    if (promoCost == null) noPromoCost.push(m.sku);
    const tracked = stock[m.sku];
    if (!tracked) noStock.push(m.sku);
    lines.push({
      sku: m.sku,
      article: a.alias,
      description: a.listing_title ?? null,
      forecast: tracked ? Number(tracked.available) : 0,
      map,
      promoMap,
      regularCost,
      promoCost,
    });
  }
  if (!lines.length) throw new Error(`Nothing to write: no ${categories.size ? [...categories].map((c) => CATEGORY_LABELS[c] ?? c).join(' / ') + ' ' : ''}product of this promotion has a Home Depot Canada id and a promo MAP below its MAP.`);

  // Rows already carrying an article stay; ours go on the first empty rows
  // after them (the template ships thousands of pre-formatted rows, J with
  // its formula, which merging leaves in place).
  const { cols } = hit;
  let lastUsed = hit.headerRow;
  for (let i = hit.headerRow + 1; i < hit.grid.length; i++) if ((hit.grid[i] ?? []).some((v) => String(v ?? '').trim())) lastUsed = i;
  const firstRow = lastUsed + 2; // 1-based row number of the first line we write
  const existingRows = new Set([...hit.xml.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1])));
  const styles = columnStyles(hit.xml);

  const cellsByRow = new Map();
  let appended = '';
  for (const [idx, l] of lines.entries()) {
    const rn = firstRow + idx;
    const cells = new Map();
    const put = (c, v) => { if (c != null && v != null && v !== '') cells.set(c + 1, buildCell(`${indexToCol(c + 1)}${rn}`, v, styles.get(c + 1) ?? null)); };
    put(cols.merchant, HDCA_CONSTANTS.merchant);
    put(cols.article, l.article);
    put(cols.description, l.description);
    put(cols.unit, HDCA_CONSTANTS.unit);
    put(cols.forecast, l.forecast);
    put(cols.wasPrice, l.map);
    put(cols.nlpPrice, l.promoMap);
    put(cols.priceUp, HDCA_CONSTANTS.priceUp);
    put(cols.market, HDCA_CONSTANTS.market);
    put(cols.duration, HDCA_CONSTANTS.duration);
    put(cols.funding, HDCA_CONSTANTS.funding);
    put(cols.oldCost, l.regularCost);
    put(cols.newCost, l.promoCost);
    if (existingRows.has(rn)) cellsByRow.set(rn, cells);
    else appended += `<row r="${rn}">` + [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('') + '</row>';
  }
  let xml = cellsByRow.size ? mergeRows(hit.xml, cellsByRow, true) : hit.xml;
  if (appended) xml = injectRows(xml, appended, firstRow + lines.length - 1);
  zip.file(hit.path, xml);

  const period = String(promotion.period).slice(0, 7);
  const catLabel = [...categories].map((c) => CATEGORY_LABELS[c] ?? c).join('_').replace(/[^\w]+/g, '_');
  await downloadZip(zip, `HomeDepotCA_${catLabel || 'Promo'}_${period}`, templateExt(template.storage_path));

  const report = {
    rows: lines.length, tier, fromList, categories: [...categories], otherCategory, noAlias, noMap, noPromoMap, atOrAbove, under5, noCost, noPromoCost, noStock,
    atZero: lines.filter((l) => l.forecast === 0 && stock[l.sku]).length, excluded, sheet: hit.name, firstRow,
  };
  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: channel.key,
    summary: `Filled Home Depot Canada NLP file for "${promotion.name}" (${lines.length} articles, ${levelLabel(tier)} level, forecast = Canada stock)`,
    metadata: { template: template.file_name, ...report, otherCategory: otherCategory.length, noAlias: noAlias.length, noMap: noMap.length, noPromoMap: noPromoMap.length, atOrAbove: atOrAbove.length, under5: under5.length, noCost: noCost.length, noPromoCost: noPromoCost.length, noStock: noStock.length },
  });
  return report;
}

const few = (list, n = 8) => `${list.slice(0, n).join(', ')}${list.length > n ? ` and ${list.length - n} more` : ''}`;

export function summarizeHomeDepotCaFill(channel, r) {
  const cats = r.categories.length ? r.categories.map((c) => CATEGORY_LABELS[c] ?? c).join(' / ') : 'every category';
  const parts = [`${channel.label} file ready. ${r.rows} articles (${cats}) from row ${r.firstRow} of sheet "${r.sheet}": NLP price = MAP ${levelLabel(r.tier)}, new cost = WC ${levelLabel(r.tier)}${r.fromList ? ` (${r.fromList} prices from the promotion's own list)` : ''}, forecast = Canada stock${r.atZero ? ` (${r.atZero} at 0)` : ''}. Fiscal Week (column A) is yours to fill`];
  if (r.otherCategory.length) parts.push(`${r.otherCategory.length} promo products of other categories left out (this template is ${cats})`);
  if (r.noAlias.length) parts.push(`no Home Depot Canada id in Aliases, left out: ${few(r.noAlias)}`);
  if (r.noMap.length) parts.push(`no MAP CAD in the PIM, left out: ${few(r.noMap)}`);
  if (r.noPromoMap.length) parts.push(`no MAP ${levelLabel(r.tier)} in the PIM, left out: ${few(r.noPromoMap)}`);
  if (r.atOrAbove.length) parts.push(`promo MAP not below MAP, left out: ${few(r.atOrAbove)}`);
  if (r.under5.length) parts.push(`discount under Home Depot's 5% minimum: ${few(r.under5)}`);
  if (r.noCost.length) parts.push(`${r.noCost.length} without WC Rona / Home Depot (column O empty): ${few(r.noCost, 5)}`);
  if (r.noPromoCost.length) parts.push(`${r.noPromoCost.length} without WC ${levelLabel(r.tier)} (column P empty): ${few(r.noPromoCost, 5)}`);
  if (r.noStock.length) parts.push(`${r.noStock.length} not in the Canada inventory file, forecast 0: ${few(r.noStock, 5)}`);
  if (r.excluded?.length) parts.push(`${r.excluded.length} excluded from ${channel.label}: ${few(r.excluded)}`);
  return parts.join(' · ');
}
