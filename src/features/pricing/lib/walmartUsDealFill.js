// Fill Walmart USA's MK events file from a PIM deal (user, 2026-11-17: on
// Walmart USA an MK event is not sent through the API — "la idea es que no se
// programe, sino que genere el archivo y ese sí sería el que subimos").
//
// The file ("DEAL_ITEM.xlsx", Templates → Walmart US, purpose "MK events"):
// sheet "Upload Template", section titles on row 1, headers on row 2, data
// from row 3; the columns are found by their headers.
//
//   SKU (Mandatory)          the product's Walmart USA alias, or our SKU when
//                            it has none (Walmart USA lists us under our SKU)
//   Promo Price (Mandatory)  the event's own price for the product in USD,
//                            else the MAP of the event's level
//   Flash Deal Type          a list of the file's own (Weekly Deal / Limited
//                            Time Deal): left for the person to choose in the
//                            file — Walmart's guides do not say what tells
//                            one from the other, so the PIM writes neither
//                            until the user says which
//   Suggested Price,         "Informational Only": never filled
//   Comparison Price,
//   Promo Referral Price
//   Regular Price            only if a later file brings the column back:
//                            MAP Blue USD
//
// A product without a MAP Blue USD above its promo price is left out and
// named. The dates are not in the file: they go in the portal.

import { supabase } from '@/lib/supabase';
import {
  openTemplate,
  listSheetNames,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  injectRows,
  downloadZip,
  templateExt,
  indexToCol,
} from '@/features/syndication/exports/templateFiller';
import { promotionMembersFor, promotionLevel } from '@/features/pricing/api/promotions';
import { promoWindow } from '@/features/pricing/lib/promoCalendar';
import { logActivity } from '@/features/activity/api/activityLog';
import { batchTicker, blockingStep } from '@/features/pricing/lib/fileProgress';

const norm = (v) => String(v ?? '').trim().toLowerCase();

function locate(grid) {
  for (let r = 0; r < Math.min(12, grid.length); r++) {
    const row = (grid[r] ?? []).map(norm);
    const sku = row.findIndex((h) => /^sku\b/.test(h));
    const promo = row.findIndex((h) => /^promo ?price\b/.test(h));
    if (sku === -1 || promo === -1) continue;
    return {
      headerRow: r,
      cols: { sku, promo, regular: row.findIndex((h) => /^regular ?price\b/.test(h)), type: row.findIndex((h) => /^flash ?deal ?type\b/.test(h)) },
    };
  }
  return null;
}

// The values a column's dropdown takes, read from the file itself (a list
// written inline: "Weekly Deal,Limited Time Deal").
function dropdownOf(sheetXml, colIndex) {
  const col = indexToCol(colIndex + 1);
  for (const m of sheetXml.matchAll(/<dataValidation\b([^>]*)>([\s\S]*?)<\/dataValidation>/g)) {
    if (!/type="list"/.test(m[1])) continue;
    const ref = m[1].match(/sqref="([^"]*)"/)?.[1] ?? '';
    if (!ref.split(/\s+/).some((r) => new RegExp(`^${col}\\d+(:${col}\\d+)?$`).test(r))) continue;
    const list = m[2].match(/<formula1>\s*(?:&quot;|")([\s\S]*?)(?:&quot;|")\s*<\/formula1>/)?.[1];
    if (list) return list.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

/**
 * @param template  marketplace_templates row (Walmart US, purpose "mk_events")
 * @param promotion promotions row (an MK event with Walmart USA among its portals)
 * @param channel   PROMO_CHANNELS entry for Walmart USA
 * @param task      optional taskProgress reporter: template 20%, members,
 *                  products and aliases in batches of 100, fill, the file
 */
export async function fillWalmartUsDealTemplate(template, promotion, channel, { task = null } = {}) {
  task?.step('Downloading the template…');
  const { zip, shared } = await openTemplate(template.storage_path);
  task?.progress(0.2, 'Reading the template…');
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  let hit = null;
  for (const name of listSheetNames(workbookXml)) {
    if (/^hidden/i.test(name)) continue;
    const path = await sheetPathByName(zip, name);
    if (!path) continue;
    const xml = await zip.file(path).async('string');
    const grid = sheetToGrid(xml, shared);
    const loc = locate(grid);
    if (loc) { hit = { name, path, xml, grid, ...loc }; break; }
  }
  if (!hit) throw new Error(`No sheet in "${template.file_name}" has Walmart's deal columns (SKU, Promo Price). Send me the file and I map it.`);

  const tier = promotionLevel(promotion, channel);
  const tierLabel = tier === 'orange' ? 'Orange' : 'Purple';
  const promoMapField = `map_${tier}_usd`;
  task?.progress(0.25, "Reading the event's products…");
  const { rows: members, excluded } = await promotionMembersFor(promotion, 'walmart_us');
  task?.progress(0.35);
  if (!members.length) throw new Error('This event has no products on its USA list.');
  const skus = members.map((m) => m.sku);

  const pim = new Map();
  const alias = new Map();
  const tick = batchTicker(task?.part(0.35, 0.75), skus.length, 100, 'Reading the products and Walmart SKUs');
  for (let i = 0; i < skus.length; i += 100) {
    tick(i);
    const chunk = skus.slice(i, i + 100);
    const [{ data: prods, error: pErr }, { data: aliases, error: aErr }] = await Promise.all([
      supabase.from('products').select(`sku, map_usd, ${promoMapField}`).in('sku', chunk),
      supabase.from('product_aliases').select('sku, alias').eq('marketplace', 'Walmart US').in('sku', chunk),
    ]);
    if (pErr) throw pErr;
    if (aErr) throw aErr;
    for (const p of prods ?? []) pim.set(p.sku, p);
    for (const a of aliases ?? []) alias.set(a.sku, a.alias);
  }

  const window = promoWindow(promotion, 'us');
  const lines = [];
  const noMap = [];
  const noPromo = [];
  const atOrAbove = [];
  let aliased = 0;
  let fromList = 0;
  for (const m of members) {
    const p = pim.get(m.sku) ?? {};
    const regular = p.map_usd != null ? Number(p.map_usd) : null;
    const promo = m.promo_price_usd != null ? Number(m.promo_price_usd) : p[promoMapField] != null ? Number(p[promoMapField]) : null;
    if (promo == null) { noPromo.push(m.sku); continue; }
    if (regular == null) { noMap.push(m.sku); continue; }
    if (promo >= regular) { atOrAbove.push(m.sku); continue; }
    if (m.promo_price_usd != null) fromList += 1;
    if (alias.has(m.sku)) aliased += 1;
    lines.push({ sku: m.sku, walmartSku: alias.get(m.sku) ?? m.sku, regular, promo });
  }
  if (!lines.length) throw new Error('Nothing to write: no product has a promo price below its MAP Blue USD.');
  await blockingStep(task, 0.8, `Filling the sheet · ${lines.length} products…`);

  const { cols } = hit;
  let lastUsed = hit.headerRow;
  for (let i = hit.headerRow + 1; i < hit.grid.length; i++) if ((hit.grid[i] ?? []).some((v) => String(v ?? '').trim())) lastUsed = i;
  let rowsXml = '';
  for (const [idx, l] of lines.entries()) {
    const rn = lastUsed + 2 + idx;
    // a row's cells go in column order, wherever the file puts each column
    const cells = [[cols.sku, l.walmartSku], [cols.regular, l.regular], [cols.promo, l.promo]]
      .filter(([c]) => c !== -1)
      .sort((a, b) => a[0] - b[0]);
    rowsXml += `<row r="${rn}">` + cells.map(([c, v]) => buildCell(`${indexToCol(c + 1)}${rn}`, v)).join('') + '</row>';
  }
  zip.file(hit.path, injectRows(hit.xml, rowsXml, lastUsed + 1 + lines.length));

  const period = String(promotion.period).slice(0, 7);
  await blockingStep(task, 0.85, 'Writing the file…');
  await downloadZip(zip, `Walmart_USA_MK_Event_${period}`, templateExt(template.storage_path));
  task?.progress(1);

  const dealTypes = cols.type !== -1 ? dropdownOf(hit.xml, cols.type) : [];
  const report = {
    rows: lines.length, tier, tierLabel, aliased, fromList, noMap, noPromo, atOrAbove, excluded, window, sheet: hit.name,
    dealTypes, dealTypeColumn: cols.type !== -1 ? indexToCol(cols.type + 1) : null,
  };
  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: channel.key,
    summary: `Filled Walmart USA MK events file for "${promotion.name}" (${lines.length} products, promo MAP ${tierLabel})`,
    metadata: { template: template.file_name, rows: lines.length, tier, fromList, aliased, noMap: noMap.length, noPromo: noPromo.length, atOrAbove: atOrAbove.length, window },
  });
  return report;
}

const few = (list, n = 8) => `${list.slice(0, n).join(', ')}${list.length > n ? ` and ${list.length - n} more` : ''}`;

export function summarizeWalmartUsDealFill(channel, r) {
  const parts = [`${channel.label} MK events file ready. ${r.rows} products (SKU + promo price = MAP ${r.tierLabel}${r.fromList ? `, ${r.fromList} from the event's own list` : ''})${r.aliased ? `, ${r.aliased} under their Walmart SKU` : ''}.${r.dealTypeColumn ? ` Flash Deal Type is left for you to choose in column ${r.dealTypeColumn}${r.dealTypes.length ? ` (${r.dealTypes.join(' or ')})` : ''}.` : ''} Upload it in Seller Center; the dates go in the portal: ${r.window.start} to ${r.window.end}`];
  if (r.noMap.length) parts.push(`no MAP USD in the PIM, left out: ${few(r.noMap)}`);
  if (r.noPromo.length) parts.push(`no MAP ${r.tierLabel} USD in the PIM, left out: ${few(r.noPromo)}`);
  if (r.atOrAbove.length) parts.push(`promo not below the MAP Blue, left out: ${few(r.atOrAbove)}`);
  if (r.excluded?.length) parts.push(`${r.excluded.length} switched off for ${channel.label}: ${few(r.excluded)}`);
  return parts.join(' · ');
}
