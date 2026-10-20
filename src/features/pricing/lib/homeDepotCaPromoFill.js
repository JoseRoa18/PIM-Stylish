// Fill Home Depot Canada's promotion workbooks from a PIM promotion. Home
// Depot hands out one workbook per product family, in two layouts; Generate
// fills EVERY promotions template uploaded for Home Depot CA in one go (a
// ZIP when there are several), each with the members of its categories.
// The layout is told by the header row, the members by the template's
// categories in Templates (a template tagged kitchen_sink also takes bar /
// prep, laundry and outdoor sinks — Home Depot files sinks by family).
//
// NLP workbook — sheet "D29K" (Kitchen Sinks), rules 2026-09-28:
//   A Fiscal Week            the Launch Week of Home Depot's FY 2026 Monthly
//                            NLP Launch Schedule whose NLP start is nearest the
//                            promotion's month (its 1st; a deal's first day)
//                            (user 2026-10-16:
//                            the monthly table, not the off-cycle one) — Oct
//                            35, Nov 40, Dec 44; empty past the schedule
//   B Merchant               "Wendy Chan"
//   C Article #              Home Depot Canada's id (Aliases, "Home Depot CA")
//   D Article Description    the alias' listing title
//   E Unit of Measure        "Ea"
//   F NLP Forecast           the Canada stock in the PIM (product_inventory);
//                            5 where that is 0 or not tracked (user 2026-10-16)
//   G WAS Price              MAP Blue (map_cad)
//   H NLP Price              the product's promo MAP of the promotion's level
//                            (map_orange_cad for a monthly promotion / flash
//                            deal, map_purple_cad for a special event)
//   I Automatic Price-Up?    "YES"
//   J Price Change %         the template's own formula, untouched
//   K Applicable Market      "ALL"
//   L NLP Duration           "30 Days"
//   M Funding Type           "Cost Reduction"
//   (a product under Home Depot's 5% NLP minimum — the J formula's
//   ROUNDDOWN((G - H) / G, 4) below 0.05 — is left out and reported, user
//   2026-10-16)
//   O Old Cost               WC Blue (cost_cad_rona_hd)
//   P New Cost               the product's WC of the level (cost_cad_rona_hd_<level>)
//   Q Notes                  our SKU (user 2026-10-16: "en notes agreguemos los SKUs")
//   N, R… everything else    empty
//
// Event / NLP submission — sheet "Vendor Submission" (Faucets & Porcelain:
// kitchen and bathroom faucets, bathroom sinks), rules 2026-09-28:
//   B Quarter                Home Depot's fiscal quarter of the promotion's
//                            month (a monthly promotion's own month, a deal's
//                            first day: Feb–Apr Q1, May–Jul Q2, Aug–Oct Q3,
//                            Nov–Jan Q4)
//   C Vendor Name            "Stylish WAREHOUSE"
//   D THD Article #          the alias        E Article Description  its title
//   G WAS Price              MAP Blue         H Now Price   promo MAP of the level
//   I Retail Change %        empty (user 2026-09-28)
//   J NLP Funding Type       "Cost Reduction"
//   L Old Cost               WC Blue          M New Cost    WC of the level
//   N NLP Forecast           60% of the Canada stock, rounded; 5 where that is 0
//   Q Retail Change %        the template's formula, untouched
//   W Notes                  "<Month> Promotion", the monthly promotion's own
//                            month (flash deal / special event: their kind,
//                            the month of their first day)
//   X (no header)            our SKU (user 2026-10-16: Notes holds only the
//                            promotion; the SKU goes in X)
//   I, K, P, S, T, U, everything else  empty
//
// The products' levels are the truth (user 2026-09-28): the promotion's own
// rows only fill a level the product lacks, and the SKUs where the two differ
// are reported. Every promo member with an article id and a promo MAP goes in;
// a WAS price missing or a promo MAP not below it is reported, not dropped.
// Both workbooks ship every data row pre-formatted, so lines are merged into
// the first empty rows under the header and every value keeps the style of
// the cell it replaces (a row the template does not carry falls back to the
// sheet's column styles). Article ids go in as numbers (the NLP sheet
// validates them as such); the dropdown spellings are the sheets' own. The
// workbook is flagged to recalculate on open so the % formulas show.

import { supabase } from '@/lib/supabase';
import {
  loadJSZip,
  openTemplate,
  listSheetNames,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  mergeRows,
  injectRows,
  recalcOnOpen,
  downloadZip,
  templateExt,
  indexToCol,
  norm,
} from '@/features/syndication/exports/templateFiller';
import { promotionMembersFor, promotionLevel, levelLabel, PROMOTION_KINDS } from '@/features/pricing/api/promotions';
import { getStockFor } from '@/features/pricing/api/inventory';
import { channelCategory } from '@/features/products/lib/categories';
import { promoWindow } from '@/features/pricing/lib/promoCalendar';
import { NLP_MIN_DISCOUNT, nlpDiscount, CATEGORY_FAMILY } from '@/features/pricing/lib/homeDepotCaNlp';
import { logActivity } from '@/features/activity/api/activityLog';

const ALIAS_MARKETPLACE = 'Home Depot CA';

// The two layouts: header recognizers on normalized text (lower-case,
// letters and digits), the roles that must be there, and the family's rules.
const LAYOUTS = {
  nlp: {
    label: 'NLP workbook',
    required: ['article', 'wasPrice', 'nlpPrice'],
    headers: {
      week: /^fiscalweek$/, merchant: /^merchant$/, article: /^article$/, description: /^articledescription/, unit: /^unitofmeasure/,
      forecast: /^nlpforecast/, wasPrice: /^wasprice/, nlpPrice: /^nlpprice/, priceUp: /^automaticpriceup/,
      market: /^applicablemarket/, duration: /^nlpduration$/, funding: /^fundingtype/, oldCost: /^oldcost/, newCost: /^newcost/,
      notes: /^notes$/,
    },
    forecastShare: 1,
    constants: { merchant: 'Wendy Chan', unit: 'Ea', priceUp: 'YES', market: 'ALL', duration: '30 Days', funding: 'Cost Reduction' },
  },
  event: {
    label: 'Vendor Submission',
    required: ['article', 'wasPrice', 'nowPrice'],
    headers: {
      quarter: /^quarter/, vendor: /^vendorname/, article: /^thdarticle/, description: /^articledescription/,
      wasPrice: /^wasprice/, nowPrice: /^nowprice/, funding: /^nlpfundingtype/,
      oldCost: /^oldcost/, newCost: /^newcost/, forecast: /^nlpforecast/, notes: /^notes$/,
    },
    forecastShare: 0.6,
    constants: { vendor: 'Stylish WAREHOUSE', funding: 'Cost Reduction' },
  },
};

function locate(grid) {
  for (let r = 0; r < Math.min(10, grid.length); r++) {
    const row = (grid[r] ?? []).map((v) => norm(v ?? ''));
    for (const [key, layout] of Object.entries(LAYOUTS)) {
      const cols = {};
      for (const [role, re] of Object.entries(layout.headers)) {
        const c = row.findIndex((h) => h && re.test(h));
        if (c !== -1) cols[role] = c;
      }
      if (layout.required.every((role) => cols[role] != null)) return { layout: key, headerRow: r, cols };
    }
  }
  return null;
}

// The style each column gives its new cells (<cols> of the sheet), for rows
// the template does not carry.
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


// Home Depot Canada's fiscal quarters start in February.
function fiscalQuarter(day) {
  const month = Number(String(day).slice(5, 7));
  if (month >= 2 && month <= 4) return 'Q1';
  if (month >= 5 && month <= 7) return 'Q2';
  if (month >= 8 && month <= 10) return 'Q3';
  return 'Q4';
}
// Home Depot Canada's FY 2026 Monthly NLP Launch Schedule (user, 2026-10-16:
// "toma los datos de arriba" — the monthly table, not the off-cycle one):
// launch week and NLP effective start. A monthly promotion takes the launch
// week whose start is nearest the 1st of its month (Oct → 35, Nov → 40), a
// deal the one nearest its first day; past the table's reach the week stays
// empty — the next fiscal year's schedule goes here.
const NLP_LAUNCH_WEEKS = [
  [1, '2026-02-03'], [5, '2026-03-03'], [9, '2026-03-31'], [14, '2026-05-05'],
  [18, '2026-06-02'], [22, '2026-06-30'], [27, '2026-08-04'], [31, '2026-09-01'],
  [35, '2026-09-29'], [40, '2026-11-03'], [44, '2026-12-01'], [48, '2026-12-29'],
];
const DAY_MS = 86400000;
function nlpLaunchWeek(day) {
  const at = Date.parse(`${day}T12:00:00Z`);
  let best = null;
  for (const [week, start] of NLP_LAUNCH_WEEKS) {
    const gap = Math.abs(Date.parse(`${start}T12:00:00Z`) - at) / DAY_MS;
    if (!best || gap < best.gap) best = { week, gap };
  }
  // more than about half a launch cycle away: outside this schedule
  return best && best.gap <= 20 ? best.week : null;
}

// Home Depot's NLP minimum: "Minimum discount for NLPs is 5%" (the NLP
// workbook's own note). Below it a product stays out of that sheet (user,
// 2026-10-16) — measured as its J formula does: ROUNDDOWN((WAS - NLP) / WAS, 4)
// (homeDepotCaNlp.js, shared with Price Alignment).
// The forecast Home Depot gets when the stock gives 0 (user, 2026-10-16: "si
// hay 0, que por default le coloque 5").
const FORECAST_FLOOR = 5;

const monthName = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('en-CA', { month: 'long' });

const few = (list, n = 8) => `${list.slice(0, n).join(', ')}${list.length > n ? ` and ${list.length - n} more` : ''}`;
const labelOf = (c) => CATEGORY_LABELS[c] ?? c;

/**
 * One template → one filled workbook (not downloaded). Returns
 * { zip, name, ext, report } or throws when nothing can be written.
 */
async function buildWorkbook(template, promotion, channel) {
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
  if (!hit) throw new Error(`No sheet in "${template.file_name}" has the Home Depot Canada columns (Article # / THD Article #, WAS Price, NLP or Now Price). Send me the file and I map it.`);
  const layout = LAYOUTS[hit.layout];

  const tier = promotionLevel(promotion, channel);
  const promoMapField = `map_${tier}_cad`;
  const promoCostField = `cost_cad_rona_hd_${tier}`;
  const tagged = template.categories ?? [];
  const categories = new Set(tagged.flatMap((c) => CATEGORY_FAMILY[c] ?? [c]));
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
  const belowMin = []; // NLP workbook: under the 5% minimum, left out
  const noCost = [];
  const noPromoCost = [];
  const noStock = [];
  const listDiffers = [];
  let fromList = 0;
  for (const m of members) {
    const p = pim.get(m.sku) ?? {};
    if (categories.size && !categories.has(p.category) && !categories.has(channelCategory(p))) { otherCategory.push(m.sku); continue; }
    const a = alias.get(m.sku);
    if (!a) { noAlias.push(m.sku); continue; }
    // The promotion's row is the truth — the file's price, or the level where
    // the file left it blank (rule 2026-09-30); the level only fills a gap.
    const listed = m.promo_price_cad != null ? Number(m.promo_price_cad) : null;
    const level = p[promoMapField] != null ? Number(p[promoMapField]) : null;
    const promoMap = listed ?? level;
    if (promoMap == null) { noPromoMap.push(m.sku); continue; }
    if (listed != null) fromList += 1;
    if (listed != null && level != null && listed !== level) listDiffers.push(`${m.sku} (list ${listed}, ${levelLabel(tier)} ${level})`);
    const map = p.map_cad != null ? Number(p.map_cad) : null;
    if (map == null) noMap.push(m.sku);
    else if (hit.layout === 'nlp' && nlpDiscount(map, promoMap) < NLP_MIN_DISCOUNT) {
      belowMin.push(`${m.sku} (${(nlpDiscount(map, promoMap) * 100).toFixed(2)}%)`);
      continue;
    } else if (promoMap >= map) atOrAbove.push(m.sku);
    const regularCost = p.cost_cad_rona_hd != null ? Number(p.cost_cad_rona_hd) : null;
    const listedCost = m.promo_costs?.rona_hd_cad;
    const promoCost = listedCost != null ? Number(listedCost) : p[promoCostField] != null ? Number(p[promoCostField]) : null;
    if (regularCost == null) noCost.push(m.sku);
    if (promoCost == null) noPromoCost.push(m.sku);
    const tracked = stock[m.sku];
    if (!tracked) noStock.push(m.sku);
    const available = tracked ? Number(tracked.available) : 0;
    lines.push({
      sku: m.sku,
      article: /^\d+$/.test(String(a.alias).trim()) ? Number(a.alias) : a.alias,
      description: a.listing_title ?? null,
      // a forecast of 0 (no stock, or not in the inventory file) goes as 5
      forecast: Math.max(0, Math.round(available * layout.forecastShare)) || FORECAST_FLOOR,
      available,
      stocked: Boolean(tracked),
      map,
      promoMap,
      regularCost,
      promoCost,
    });
  }
  if (!lines.length) throw new Error(`no ${tagged.length ? tagged.map(labelOf).join(' / ') + ' ' : ''}product of this promotion has a Home Depot Canada id and a promo MAP`);

  // Rows already carrying an article stay; ours go on the first empty rows
  // after them. Both templates ship their data rows pre-formatted (formula
  // cells included), which merging leaves in place.
  const { cols } = hit;
  const window = promoWindow(promotion, 'ca');
  const kind = promotion.kind ?? 'monthly';
  // The day the labels go by: a monthly promotion is its own month (the
  // November one opens in Canada on Oct 22 and is still "November Promotion",
  // Q4 — user 2026-10-16); a flash deal / special event its first day.
  const labelDay = kind === 'monthly' && promotion.period ? String(promotion.period).slice(0, 10) : window.start;
  const notes = `${monthName(labelDay)} ${kind === 'monthly' ? 'Promotion' : PROMOTION_KINDS[kind] ?? 'Promotion'}`;
  const quarter = fiscalQuarter(labelDay);
  const fiscalWeek = nlpLaunchWeek(labelDay);
  let lastUsed = hit.headerRow;
  for (let i = hit.headerRow + 1; i < hit.grid.length; i++) if ((hit.grid[i] ?? []).some((v) => String(v ?? '').trim())) lastUsed = i;
  const firstRow = lastUsed + 2; // 1-based row number of the first line we write
  const existingRows = new Set([...hit.xml.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1])));
  const styles = columnStyles(hit.xml);
  const col = (c) => indexToCol(c + 1);

  const cellsByRow = new Map();
  let appended = '';
  for (const [idx, l] of lines.entries()) {
    const rn = firstRow + idx;
    const cells = new Map();
    // In a row the template carries, the merge (keepStyle) hands each value
    // the style of the empty cell it replaces; elsewhere the column style.
    const inTemplate = existingRows.has(rn);
    const styleFor = (c) => (inTemplate ? null : styles.get(c + 1) ?? null);
    const put = (c, v) => { if (c != null && v != null && v !== '') cells.set(c + 1, buildCell(`${col(c)}${rn}`, v, styleFor(c))); };
    const k = layout.constants;
    if (hit.layout === 'nlp') {
      put(cols.week, fiscalWeek);
      put(cols.merchant, k.merchant);
      put(cols.article, l.article);
      put(cols.description, l.description);
      put(cols.unit, k.unit);
      put(cols.forecast, l.forecast);
      put(cols.wasPrice, l.map);
      put(cols.nlpPrice, l.promoMap);
      put(cols.priceUp, k.priceUp);
      put(cols.market, k.market);
      put(cols.duration, k.duration);
      put(cols.funding, k.funding);
      put(cols.oldCost, l.regularCost);
      put(cols.newCost, l.promoCost);
      put(cols.notes, l.sku);
    } else {
      put(cols.quarter, quarter);
      put(cols.vendor, k.vendor);
      put(cols.article, l.article);
      put(cols.description, l.description);
      put(cols.wasPrice, l.map);
      put(cols.nowPrice, l.promoMap);
      put(cols.funding, k.funding);
      put(cols.oldCost, l.regularCost);
      put(cols.newCost, l.promoCost);
      put(cols.forecast, l.forecast);
      put(cols.notes, notes);
      // our SKU in the next column (X, no header there), never in Notes (user, 2026-10-16)
      if (cols.notes != null) put(cols.notes + 1, l.sku);
    }
    if (inTemplate) cellsByRow.set(rn, cells);
    else appended += `<row r="${rn}">` + [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('') + '</row>';
  }
  let xml = cellsByRow.size ? mergeRows(hit.xml, cellsByRow, true) : hit.xml;
  if (appended) xml = injectRows(xml, appended, firstRow + lines.length - 1);
  zip.file(hit.path, xml);
  await recalcOnOpen(zip); // the % formulas have no cached value until Excel computes them

  const period = String(promotion.period).slice(0, 7);
  const catLabel = tagged.map(labelOf).join('_').replace(/[^\w]+/g, '_');
  const report = {
    template: template.file_name, layout: layout.label, sheet: hit.name, firstRow,
    rows: lines.length, tier, fromList, listDiffers, categories: tagged, family: [...categories],
    forecastShare: layout.forecastShare, notes: hit.layout === 'event' ? notes : null, quarter: hit.layout === 'event' ? quarter : null,
    week: hit.layout === 'nlp' && cols.week != null ? fiscalWeek : undefined, windowStart: labelDay,
    otherCategory, noAlias, noMap, noPromoMap, atOrAbove, belowMin, noCost, noPromoCost, noStock,
    atZero: lines.filter((l) => l.stocked && Math.max(0, Math.round(l.available * layout.forecastShare)) === 0).length, excluded,
  };
  return { zip, name: `HomeDepotCA_${catLabel || 'Promo'}_${period}`, ext: templateExt(template.storage_path), report };
}

/**
 * Fill every Home Depot Canada promotions template (one per product family)
 * for a promotion: one download when there is one file, a ZIP otherwise. A
 * template with nothing to write (no member of its categories) is reported
 * and skipped; the others still go out.
 * @param templates marketplace_templates rows (Home Depot CA, purpose "promotions" or "flash_deals")
 */
export async function fillHomeDepotCaPromoTemplates(templates, promotion, channel) {
  const list = (Array.isArray(templates) ? templates : [templates]).filter(Boolean);
  if (!list.length) throw new Error('No Home Depot Canada promotions template is uploaded in Templates.');
  const files = [];
  const skipped = [];
  for (const t of list) {
    try {
      files.push(await buildWorkbook(t, promotion, channel));
    } catch (err) {
      skipped.push({ template: t.file_name, error: err.message });
    }
  }
  if (!files.length) throw new Error(`Nothing to write: ${skipped.map((s) => `${s.template} — ${s.error}`).join(' · ')}.`);

  const period = String(promotion.period).slice(0, 7);
  if (files.length === 1) {
    await downloadZip(files[0].zip, files[0].name, files[0].ext);
  } else {
    const JSZip = await loadJSZip();
    const bundle = new JSZip();
    for (const f of files) bundle.file(`${f.name}.${f.ext}`, await f.zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }));
    const out = await bundle.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const url = URL.createObjectURL(out);
    const link = document.createElement('a');
    link.href = url;
    link.download = `HomeDepotCA_Promo_${period}.zip`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const reports = files.map((f) => f.report);
  logActivity({
    action: 'export',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: channel.key,
    summary: `Filled Home Depot Canada promotion file${files.length > 1 ? 's' : ''} for "${promotion.name}": ${reports.map((r) => `${r.categories.map(labelOf).join(' / ') || r.layout} ${r.rows}`).join(', ')} (${levelLabel(reports[0].tier)} level, forecast = Canada stock)`,
    metadata: {
      files: reports.map((r) => ({ template: r.template, layout: r.layout, rows: r.rows, categories: r.categories, otherCategory: r.otherCategory.length, noAlias: r.noAlias.length, noMap: r.noMap.length, noPromoMap: r.noPromoMap.length, atOrAbove: r.atOrAbove.length, belowMin: r.belowMin.length, listDiffers: r.listDiffers.length, noCost: r.noCost.length, noPromoCost: r.noPromoCost.length, noStock: r.noStock.length, atZero: r.atZero })),
      skipped,
    },
  });
  return { files: reports, skipped, zipped: files.length > 1, period };
}

function describeFile(r) {
  const extra = (r.family ?? []).filter((c) => !r.categories.includes(c)).map((c) => labelOf(c).toLowerCase());
  const cats = r.categories.length ? r.categories.map(labelOf).join(' / ') + (extra.length ? ` incl. ${extra.join(', ')}` : '') : 'every category';
  const parts = [`${cats}: ${r.rows} articles from row ${r.firstRow} of "${r.sheet}" (${r.layout}${r.quarter ? `, ${r.quarter}, notes "${r.notes}"` : ''}${r.week ? `, Fiscal Week ${r.week}` : ''}); prices = the promotion's promo MAP / WC (the file's values; the ${levelLabel(r.tier)} level where it has none), forecast = ${r.forecastShare === 1 ? 'the Canada stock' : `${Math.round(r.forecastShare * 100)}% of the Canada stock`}, ${FORECAST_FLOOR} where that is 0${r.atZero ? ` (${r.atZero} at 0 stock)` : ''}`];
  if (r.listDiffers?.length) parts.push(`${r.listDiffers.length} where the promotion's list differs from the ${levelLabel(r.tier)} level (the promotion's price went in): ${few(r.listDiffers, 4)}`);
  if (r.otherCategory.length) parts.push(`${r.otherCategory.length} promo products of other categories left out`);
  if (r.noAlias.length) parts.push(`no Home Depot Canada id in Aliases, left out: ${few(r.noAlias)}`);
  if (r.noPromoMap.length) parts.push(`no MAP ${levelLabel(r.tier)} in the PIM, left out: ${few(r.noPromoMap)}`);
  if (r.noMap.length) parts.push(`${r.noMap.length} without MAP CAD (WAS price empty): ${few(r.noMap, 5)}`);
  if (r.belowMin?.length) parts.push(`${r.belowMin.length} under Home Depot's 5% NLP minimum, left out: ${few(r.belowMin, 6)}`);
  if (r.atOrAbove.length) parts.push(`${r.atOrAbove.length} with the promo MAP not below MAP, check them: ${few(r.atOrAbove, 5)}`);
  if (r.noCost.length) parts.push(`${r.noCost.length} without WC Rona / Home Depot (old cost empty): ${few(r.noCost, 5)}`);
  if (r.noPromoCost.length) parts.push(`${r.noPromoCost.length} without WC ${levelLabel(r.tier)} (new cost empty): ${few(r.noPromoCost, 5)}`);
  if (r.noStock.length) parts.push(`${r.noStock.length} not in the Canada inventory file, forecast ${FORECAST_FLOOR}: ${few(r.noStock, 5)}`);
  if (r.excluded?.length) parts.push(`${r.excluded.length} excluded from Home Depot Canada: ${few(r.excluded)}`);
  if (r.week === null) parts.push(`no NLP launch week near ${r.windowStart} in the FY 2026 schedule — fill Fiscal Week by hand`);
  return parts.join(' · ');
}

export function summarizeHomeDepotCaFill(channel, r) {
  const head = r.zipped ? `${channel.label}: ${r.files.length} files in one ZIP.` : `${channel.label} file ready.`;
  const parts = [head, ...r.files.map(describeFile)];
  if (r.skipped?.length) parts.push(`skipped: ${r.skipped.map((s) => `${s.template} — ${s.error}`).join(' · ')}`);
  parts.push('anything else the sheet leaves to the vendor is yours to fill');
  return parts.join(' · ');
}
