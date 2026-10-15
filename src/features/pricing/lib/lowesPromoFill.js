// Fill Lowe's "Monthly Promotion" workbook (Vendor Offer template, XLSM)
// from a PIM promotion. Only the sheet "Discounted Pricing" is touched:
// headers on row 6, one row per product from row 7. Rules given by the
// user 2026-09-24:
//
//   D  Offer #                      1
//   E  Stock or SOS                 SOS
//   F  Offer Start Date             first day of the promotion (USA window)
//   G  Offer End Date               last day
//   H  Offer Name                   "10.1-10.31 October Monthly Promotion Kitchen Sinks"
//                                   (short dates, month, kind, category; 50 chars max)
//   K  Division                     by category (KITCHENS.AND.BATH.35 …)
//   M  Sub-Division                 by category (KITCHEN.SINKS.AND.DISPOSERS.188 …)
//   O  Description                  the Lowe's name on the product's alias
//   P  Item Number                  the product's Lowe's alias (item number)
//   R  Current price (Was price)    MAP Blue (map_usd)
//   S  Discount Type                Fixed Price
//   T  Value                        MAP of the level: Orange (monthly) / Purple
//                                   (flash, event); the promotion's own promo
//                                   price wins when it has one
//   W  Comments                     our part number (SKU) — for checking the
//                                   file; the user deletes it before sending
//                                   (2026-10-15)
//   X  Funding Calculation          Per Unit $
//   Y  What is the amount?          R - T
//   AA Collection method            Debit Memo
//   AB HOVBU? / AC remit number     108653
//   AD Vendor Sub-Division          the sub-division again
//   AF Vendor Contact               Jessica Flores
//   AG Vendor Contract Signer       Jessica Flores
//   AH Merchant Contract Signer     ann-catherine.begley@lowes.com (for now);
//                                   bath sinks: mike.norris@lowes.com
//   AI AJ                           No
//   AL                              Yes
//   AO Cost                         WC Lowe's Blue (cost_usd_lowes_sod_bbb)
//
// Lowe's creates one Offer ID per Offer # in a file, and the offer name
// carries the category. Files (user rule 2026-10-09, every promotion kind):
// Kitchen Sinks and Kitchen Faucets share ONE file — Offer # 1 the sinks,
// Offer # 2 the faucets, each with its own name and sub-division — and every
// other group has a file of its own (bath faucets, bath sinks, drains,
// accessories). Several files download together as a ZIP. Products without a
// Lowe's item number are left out and reported. Cells take the column's own
// format (dates, prices) so the sheet's dropdowns and macros keep working.

import { supabase } from '@/lib/supabase';
import {
  loadJSZip,
  openTemplate,
  listSheetNames,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  excelSerial,
  injectRows,
  downloadZip,
  indexToCol,
} from '@/features/syndication/exports/templateFiller';
import { accessoryKind } from '@/features/templates/api/templates';
import { channelCategory } from '@/features/products/lib/categories';
import { promotionMembersFor, PROMOTION_KINDS, promotionLevel } from '@/features/pricing/api/promotions';
import { promoWindow } from '@/features/pricing/lib/promoCalendar';
import { logActivity } from '@/features/activity/api/activityLog';

export const LOWES_CONSTANTS = {
  offerNumber: 1,
  stockOrSos: 'SOS',
  discountType: 'Fixed Price',
  fundingCalculation: 'Per Unit $',
  collectionMethod: 'Debit Memo',
  hovbu: '108653',
  remitNumber: '108653',
  vendorContact: 'Jessica Flores',
  vendorSigner: 'Jessica Flores',
  merchantSignerEmail: 'ann-catherine.begley@lowes.com',
  otherAgreement: 'No',
  contingency: 'No',
  soldDirectly: 'Yes',
};

// Lowe's merchandising division / sub-division per PIM category (the
// dropdown values of the workbook's hidden MDV MSD sheet). Strainers and
// drains sit under Rough Plumbing; every other accessory keeps the kitchen
// sinks sub-division. `file` is the file the group goes in (FILES).
const KB = 'KITCHENS.AND.BATH.35';
const SINKS_188 = 'KITCHEN.SINKS.AND.DISPOSERS.188';
const FAUCETS_225 = 'FAUCETS.SHOWERHEADS.AND.BATH.DECOR.225';
const GROUPS = {
  kitchen_sinks: { division: KB, subdivision: SINKS_188, label: 'Kitchen Sinks', file: 'kitchen' },
  kitchen_faucets: { division: KB, subdivision: FAUCETS_225, label: 'Kitchen Faucets', file: 'kitchen' },
  bath_faucets: { division: KB, subdivision: FAUCETS_225, label: 'Bath Faucets', file: 'bath_faucets' },
  // Bath sinks have their own Lowe's merchant (user 2026-09-24).
  bath_sinks: { division: KB, subdivision: 'TOILETS.AND.BATHING.130', label: 'Bath Sinks', file: 'bath_sinks', merchantSignerEmail: 'mike.norris@lowes.com' },
  drains: { division: 'ROUGH.PLUMBING.22', subdivision: 'PLUMBING.REPAIR.208', label: 'Drains', file: 'drains' },
  accessories: { division: KB, subdivision: SINKS_188, label: 'Accessories', file: 'accessories' },
};
// The order of the groups is the order of their Offer # inside a file.
const GROUP_ORDER = Object.keys(GROUPS);
const groupKey = (group) => GROUP_ORDER.find((k) => GROUPS[k] === group);
const FILES = {
  kitchen: { label: 'Kitchen Sinks & Faucets', name: 'Kitchen_Sinks_188_Faucets_225' },
  bath_faucets: { label: 'Bath Faucets', name: 'Bath_Faucets_225' },
  bath_sinks: { label: 'Bath Sinks', name: 'Bath_Sinks_130' },
  drains: { label: 'Drains', name: 'Drains_208' },
  accessories: { label: 'Accessories', name: 'Accessories_188' },
};
export function lowesGroupFor(product) {
  switch (channelCategory(product)) {
    case 'kitchen_sink': case 'bar_prep_sink': case 'laundry_sink': case 'outdoor_sink': return GROUPS.kitchen_sinks;
    case 'kitchen_faucet': case 'pot_filler': return GROUPS.kitchen_faucets;
    case 'bathroom_faucet': return GROUPS.bath_faucets;
    case 'bathroom_sink': return GROUPS.bath_sinks;
    case 'accessory': {
      const kind = accessoryKind(product);
      return kind === 'strainer' || kind === 'drain' ? GROUPS.drains : GROUPS.accessories;
    }
    default: return GROUPS.accessories; // colanders and racks
  }
}

const HEADERS = {
  offerNumber: /^offer#$/,
  stockOrSos: /^stockorsos$/,
  start: /^offerstartdate$/,
  end: /^offerenddate$/,
  offerName: /^offername$/,
  division: /^division$/,
  subdivision: /^subdivision$/,
  description: /^description$/,
  itemNumber: /^itemnumber$/,
  currentPrice: /^currentprice/,
  discountType: /^discounttype$/,
  value: /^value$/,
  comments: /^comments$/,
  fundingCalculation: /^fundingcalculation$/,
  amount: /^whatistheamount/,
  collectionMethod: /^whatisthecollectionmethod/,
  hovbu: /^hovbu/,
  remitNumber: /^whatisthevendorremitnumber/,
  vendorSubdivision: /^vendorsubdivision$/,
  vendorContact: /^vendorcontact$/,
  vendorSigner: /^vendorcontractsigner$/,
  merchantSignerEmail: /^merchantcontractsigneremail$/,
  otherAgreement: /^arethesefundspartofanothernegotiated/,
  contingency: /^arethesefundssubjecttoacontingency/,
  soldDirectly: /^aretheitemsreferencedinthisrequestsolddirectly/,
  cost: /^cost$/,
};
const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9#]/g, '');

function locate(grid) {
  for (let r = 0; r < Math.min(12, grid.length); r++) {
    const row = (grid[r] ?? []).map(norm);
    const cols = {};
    for (const [key, re] of Object.entries(HEADERS)) {
      const idx = row.findIndex((h, i) => h && re.test(h) && !Object.values(cols).includes(i));
      if (idx !== -1) cols[key] = idx;
    }
    if (cols.itemNumber != null && cols.value != null && cols.offerName != null) return { headerRow: r, cols };
  }
  return null;
}

// The default style of each column (<col … style="n">), so injected cells
// render with the sheet's date / price formats.
function columnStyles(xml) {
  const styles = new Map();
  for (const m of xml.matchAll(/<col min="(\d+)" max="(\d+)"[^>]*?style="(\d+)"/g)) {
    const lo = Number(m[1]);
    const hi = Math.min(Number(m[2]), 60);
    for (let c = lo; c <= hi; c++) styles.set(c, m[3]);
  }
  return styles;
}

// Short dates use a dot, never a slash (user 2026-09-24): "10.1-10.31".
const shortDate = (ymd) => { const [, m, d] = ymd.split('-').map(Number); return `${m}.${d}`; };
const monthName = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { month: 'long' });

/**
 * @param template  marketplace_templates row (Lowe's US, purpose "promotions" or "flash_deals")
 * @param promotion promotions row (kind decides the level: monthly and flash → Orange, special event → Purple; see KIND_LEVEL)
 * @param channel   PROMO_CHANNELS entry for Lowe's USA
 */
export async function fillLowesPromoTemplate(template, promotion, channel) {
  const tier = promotionLevel(promotion, channel);
  const tierLabel = tier === 'orange' ? 'Orange' : 'Purple';
  const mapField = `map_${tier}_usd`;
  const { rows: members, excluded } = await promotionMembersFor(promotion, channel.key);
  if (!members.length) throw new Error('This promotion has no products.');
  const skus = members.map((m) => m.sku);

  const pim = new Map();
  const alias = new Map();
  for (let i = 0; i < skus.length; i += 100) {
    const chunk = skus.slice(i, i + 100);
    const [{ data: prods, error: pErr }, { data: aliases, error: aErr }] = await Promise.all([
      supabase.from('products').select(`sku, category, product_type, model_name, attributes, map_usd, ${mapField}, cost_usd_lowes_sod_bbb`).in('sku', chunk),
      supabase.from('product_aliases').select('sku, alias, listing_title').eq('marketplace', "Lowe's US").in('sku', chunk),
    ]);
    if (pErr) throw pErr;
    if (aErr) throw aErr;
    for (const p of prods ?? []) pim.set(p.sku, p);
    for (const a of aliases ?? []) alias.set(a.sku, a);
  }

  const window = promoWindow(promotion, 'us');
  const kindLabel = (promotion.kind ?? 'monthly') === 'monthly' ? 'Monthly Promotion' : PROMOTION_KINDS[promotion.kind] ?? 'Promotion';
  const noAlias = [];
  const noName = [];
  const noMap = [];
  const noPromo = [];
  const atOrAbove = [];
  const noCost = [];
  let fromList = 0;
  const byFile = new Map(); // FILES key → { file, lines }
  for (const m of members) {
    const a = alias.get(m.sku);
    if (!a) { noAlias.push(m.sku); continue; }
    const p = pim.get(m.sku) ?? {};
    const map = p.map_usd != null ? Number(p.map_usd) : null;
    const promo = m.promo_price_usd != null ? Number(m.promo_price_usd) : p[mapField] != null ? Number(p[mapField]) : null;
    if (map == null) { noMap.push(m.sku); continue; }
    if (promo == null) { noPromo.push(m.sku); continue; }
    if (promo >= map) { atOrAbove.push(m.sku); continue; }
    if (m.promo_price_usd != null) fromList += 1;
    if (!a.listing_title) noName.push(m.sku);
    const cost = p.cost_usd_lowes_sod_bbb != null ? Number(p.cost_usd_lowes_sod_bbb) : null;
    if (cost == null) noCost.push(m.sku);
    const group = lowesGroupFor(p);
    if (!byFile.has(group.file)) byFile.set(group.file, { file: FILES[group.file], lines: [] });
    byFile.get(group.file).lines.push({ group, sku: m.sku, itemNumber: a.alias, name: a.listing_title ?? null, map, promo, amount: Math.round((map - promo) * 100) / 100, cost });
  }
  if (!byFile.size) throw new Error("Nothing to write: no product has a Lowe's item number with a promo price below its MAP.");

  // "10.1-10.31 October Monthly Promotion Kitchen Sinks" — 50 characters at
  // most: the month goes first when it does not fit (the dates say it), then
  // the end is cut at a word.
  const offerName = (group) => {
    const dates = `${shortDate(window.start)}-${shortDate(window.end)}`;
    const full = `${dates} ${monthName(window.start)} ${kindLabel} ${group.label}`;
    if (full.length <= 50) return full;
    const short = `${dates} ${kindLabel} ${group.label}`;
    if (short.length <= 50) return short;
    return short.slice(0, 51).replace(/\s+\S*$/, '').slice(0, 50);
  };
  const period = String(promotion.period).slice(0, 7);
  const files = [];
  const fileOrder = Object.keys(FILES);
  for (const { file, lines: unsorted } of [...byFile.entries()].sort((x, y) => fileOrder.indexOf(x[0]) - fileOrder.indexOf(y[0])).map(([, v]) => v)) {
    // One Offer # per group of the file, in GROUP_ORDER: the kitchen file is
    // Offer # 1 Kitchen Sinks, Offer # 2 Kitchen Faucets.
    const lines = [...unsorted].sort((x, y) => GROUP_ORDER.indexOf(groupKey(x.group)) - GROUP_ORDER.indexOf(groupKey(y.group)));
    const offerOf = new Map();
    for (const l of lines) if (!offerOf.has(l.group)) offerOf.set(l.group, offerOf.size + 1);
    const { zip, shared } = await openTemplate(template.storage_path);
    const workbookXml = await zip.file('xl/workbook.xml').async('string');
    const name = listSheetNames(workbookXml).find((n) => /^discounted pricing$/i.test(n));
    if (!name) throw new Error(`"${template.file_name}" has no "Discounted Pricing" sheet.`);
    const path = await sheetPathByName(zip, name);
    const xml = await zip.file(path).async('string');
    const grid = sheetToGrid(xml, shared);
    const loc = locate(grid);
    if (!loc) throw new Error('The "Discounted Pricing" sheet has no Offer Name / Item Number / Value headers on its first rows.');
    const { cols } = loc;
    const styles = columnStyles(xml);
    // Rows already carrying an item number stay; ours go after them.
    let lastUsed = loc.headerRow;
    for (let i = loc.headerRow + 1; i < grid.length; i++) if ((grid[i] ?? []).some((v) => String(v ?? '').trim())) lastUsed = i;
    const priceStyle = styles.get(cols.currentPrice + 1) ?? null; // the "Value" column is text-formatted; prices go as 0.00
    let rowsXml = '';
    for (const [idx, l] of lines.entries()) {
      const rn = lastUsed + 2 + idx;
      const cells = new Map();
      const put = (key, v, style) => {
        const c = cols[key];
        if (c == null || v == null || v === '') return;
        cells.set(c + 1, buildCell(`${indexToCol(c + 1)}${rn}`, v, style ?? styles.get(c + 1) ?? null));
      };
      const { group } = l;
      put('offerNumber', LOWES_CONSTANTS.offerNumber - 1 + offerOf.get(group));
      put('stockOrSos', LOWES_CONSTANTS.stockOrSos);
      put('start', excelSerial(window.start));
      put('end', excelSerial(window.end));
      put('offerName', offerName(group));
      put('division', group.division);
      put('subdivision', group.subdivision);
      put('description', l.name);
      put('itemNumber', l.itemNumber);
      put('currentPrice', l.map);
      put('discountType', LOWES_CONSTANTS.discountType);
      put('value', l.promo, priceStyle);
      put('comments', l.sku);
      put('fundingCalculation', LOWES_CONSTANTS.fundingCalculation);
      put('amount', l.amount);
      put('collectionMethod', LOWES_CONSTANTS.collectionMethod);
      put('hovbu', LOWES_CONSTANTS.hovbu);
      put('remitNumber', LOWES_CONSTANTS.remitNumber);
      put('vendorSubdivision', group.subdivision);
      put('vendorContact', LOWES_CONSTANTS.vendorContact);
      put('vendorSigner', LOWES_CONSTANTS.vendorSigner);
      put('merchantSignerEmail', group.merchantSignerEmail ?? LOWES_CONSTANTS.merchantSignerEmail);
      put('otherAgreement', LOWES_CONSTANTS.otherAgreement);
      put('contingency', LOWES_CONSTANTS.contingency);
      put('soldDirectly', LOWES_CONSTANTS.soldDirectly);
      put('cost', l.cost, priceStyle);
      rowsXml += `<row r="${rn}">` + [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('') + '</row>';
    }
    zip.file(path, injectRows(xml, rowsXml, lastUsed + 1 + lines.length));
    const offers = [...offerOf.keys()].map((g) => ({ label: g.label, subdivision: g.subdivision, rows: lines.filter((l) => l.group === g).length }));
    files.push({ name: `Lowes_Promo_${period}_${file.name}.xlsm`, zip, label: file.label, offers, rows: lines.length });
  }

  if (files.length === 1) {
    await downloadZip(files[0].zip, files[0].name.replace(/\.xlsm$/, ''), 'xlsm');
  } else {
    const JSZip = await loadJSZip();
    const bundle = new JSZip();
    for (const f of files) bundle.file(f.name, await f.zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }));
    const out = await bundle.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const url = URL.createObjectURL(out);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Lowes_Promo_${period}_${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  const rows = files.reduce((n, f) => n + f.rows, 0);
  const report = { rows, tier, tierLabel, fromList, files: files.map((f) => ({ name: f.name, label: f.label, offers: f.offers, rows: f.rows })), noAlias, noName, noMap, noPromo, atOrAbove, noCost, excluded, window };
  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: channel.key,
    summary: `Filled Lowe's promotion file${files.length > 1 ? 's' : ''} for "${promotion.name}" (${rows} products, MAP ${tierLabel}, ${files.length} file${files.length > 1 ? 's' : ''})`,
    metadata: { template: template.file_name, rows, tier, files: report.files, noAlias: noAlias.length, noMap: noMap.length, noPromo: noPromo.length, atOrAbove: atOrAbove.length, window },
  });
  return report;
}

const few = (list, n = 8) => `${list.slice(0, n).join(', ')}${list.length > n ? ` and ${list.length - n} more` : ''}`;

export function summarizeLowesFill(channel, r) {
  const fileText = (f) => (f.offers.length > 1 ? `${f.label} (${f.offers.map((o, i) => `offer ${i + 1} ${o.label} ${o.rows}`).join(', ')})` : `${f.label} ${f.rows}`);
  const parts = [`${channel.label} ${r.files.length > 1 ? `${r.files.length} files (ZIP)` : 'file'} ready. ${r.rows} products, ${r.window.start} to ${r.window.end}, value = MAP ${r.tierLabel}${r.fromList ? ` (${r.fromList} from the promotion's own list)` : ''}: ${r.files.map(fileText).join(', ')}`];
  if (r.noAlias.length) parts.push(`no Lowe's item number in Aliases, left out: ${few(r.noAlias)}`);
  if (r.noMap.length) parts.push(`no MAP USD in the PIM, left out: ${few(r.noMap)}`);
  if (r.noPromo.length) parts.push(`no MAP ${r.tierLabel} in the PIM, left out: ${few(r.noPromo)}`);
  if (r.atOrAbove.length) parts.push(`promo not below the MAP, left out: ${few(r.atOrAbove)}`);
  if (r.noName.length) parts.push(`${r.noName.length} without a Lowe's name (Description empty): ${few(r.noName, 5)}`);
  if (r.noCost.length) parts.push(`${r.noCost.length} without WC Lowe's (Cost empty): ${few(r.noCost, 5)}`);
  if (r.excluded?.length) parts.push(`${r.excluded.length} excluded from ${channel.label}: ${few(r.excluded)}`);
  return parts.join(' · ');
}
