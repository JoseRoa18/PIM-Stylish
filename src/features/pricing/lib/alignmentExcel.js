// Price Alignment's Excel (user, 2026-11-13: "una función para poder descargar
// la lista con todos los datos detallados"), in the PIM Excel's look
// (sectionedXlsx: a colored band per section, frozen headers, filters). It is
// the list of the channel on screen with everything the PIM knows about each
// row — nothing is pulled or computed again:
//   Summary      the tiles, the problems above and below, what was left out
//   Problems     the table on screen, every problem whatever the filter shows
//   All prices   every product compared, the aligned ones too
//   Left out     the products the comparison leaves out, each with its reason
//   Notes        what each status and column means
// A row carries the product's own code on that marketplace where the PIM has
// one (MARKETPLACE_CODES), the store's price and the expected one, their difference,
// where the expected price comes from (the regular price, or the promotion
// running on that store with its name and days), the product's price levels,
// our own stock and sales in the store's country and, for a store read from
// its pages, what the page showed. Pure: the reads are in api/alignmentExcel.js.

import { alignmentSummary } from './alignmentSummary.js';
import { alignTiles, priceSide, PRICE_SIDE_LABEL, regularPriceName } from './alignmentTiles.js';
import { TOLERANCE_FROM, TOLERANCE_HIGH, TOLERANCE_LOW } from './priceTolerance.js';

export const NOT_TRACKED = 'Not tracked';

// The product's own code on the channel (user, 2026-11-19: "que cuando se
// descargue traiga el SKU del marketplace"): one column right after our SKU,
// named for what that marketplace calls it. Where it comes from:
//   alias    the product's Aliases in the PIM (product_aliases.marketplace);
//   amazon   the Seller SKU of amazon_links for that market;
//   bestbuy  the product ID of our offer (the latest Best Buy snapshot);
//   page     the code the store's own page showed when it was read
//            (where_to_buy_links.page_item_id) — the only source where the
//            PIM keeps no alias, a fallback where the page shows the very
//            number the alias is (Home Depot, Rona). Lowe's and BB&B /
//            Overstock have no fallback: their pages show another number.
// A channel that is not here has no code of its own in the PIM and gets no
// column: our own stores (the SKU there is ours), Menards and the dealers
// (their pages give only an internal id).
export const MARKETPLACE_CODES = {
  homedepot_ca: { header: 'Home Depot Item #', alias: 'Home Depot CA', page: true, meaning: 'Home Depot Canada\'s item number for the product: the one in its Aliases in the PIM, else the one its page shows.' },
  homedepot_us: { header: 'Home Depot Item #', alias: 'Home Depot US', page: true, meaning: 'Home Depot USA\'s item number for the product: the one in its Aliases in the PIM, else the one its page shows.' },
  rona: { header: 'Rona Article #', alias: 'Rona', page: true, meaning: 'Rona\'s article number for the product: the one in its Aliases in the PIM, else the one its page shows.' },
  lowes_us: { header: "Lowe's Item #", alias: "Lowe's US", meaning: 'Lowe\'s item number for the product, from its Aliases in the PIM.' },
  bbb_us: { header: 'BB&B SKU', alias: 'BB&B / Overstock', meaning: 'The SKU the product has on Bed Bath & Beyond / Overstock, from its Aliases in the PIM.' },
  overstock_us: { header: 'Overstock SKU', alias: 'BB&B / Overstock', meaning: 'The SKU the product has on Bed Bath & Beyond / Overstock, from its Aliases in the PIM.' },
  walmart_ca: { header: 'Walmart SKU', alias: 'Walmart CA', meaning: 'The SKU the product is listed under on Walmart Canada, from its Aliases in the PIM. On some products it is not our own (A-801B is A-801B-1 there).' },
  walmart_us: { header: 'Walmart Item ID', page: true, retailer: 'walmart_us', meaning: 'Walmart\'s item ID, the number in the product\'s walmart.com address. On Walmart USA the product is listed under our own SKU.' },
  bestbuy: { header: 'Best Buy Product ID', bestbuy: true, meaning: 'Best Buy\'s product ID of our offer, the number in its bestbuy.ca address. The offer is listed under our own SKU.' },
  amazon_ca: { header: 'Amazon Seller SKU', amazon: 'ca', meaning: 'The Seller SKU the product is listed under on Amazon Canada, from its Aliases in the PIM.' },
  amazon_us: { header: 'ASIN', page: true, meaning: 'The ASIN the product\'s Amazon.com page shows. The PIM keeps no Seller SKU for Amazon USA.' },
  wayfair_ca: { header: 'Wayfair SKU', page: true, linkPart: true, meaning: 'The Wayfair SKU the product\'s page shows (a listing\'s finishes and sizes share it).' },
  wayfair_us: { header: 'Wayfair SKU', page: true, linkPart: true, meaning: 'The Wayfair SKU the product\'s page shows (a listing\'s finishes and sizes share it).' },
};
// The Wayfair SKU at the end of a Wayfair address ("…-tkjs1111.html").
const WAYFAIR_PART = /-([a-z]{2,6}\d{3,7})\.html/i;

/**
 * Map(sku → the product's code on the channel), from the rows the channel's
 * entry in MARKETPLACE_CODES asks for. A page's code counts only when the page
 * read is this product's own: not a broken link, not another product or
 * another option of it — the newest reading first.
 * @param raw { aliases: [{ sku, alias }], amazon: [{ sku, seller_sku, asin }], bestBuy: [{ sku, bb_product_id }],
 *              pages: [{ sku, page_item_id, url, verdict, sku_check, read_at }] }
 */
export function marketplaceCodes(cfg, { aliases = [], amazon = [], bestBuy = [], pages = [] } = {}) {
  const spec = MARKETPLACE_CODES[cfg?.key];
  const codes = new Map();
  if (!spec) return codes;
  const put = (sku, code) => {
    const text = String(code ?? '').trim();
    if (sku && text && !codes.has(sku)) codes.set(sku, text);
  };
  for (const a of aliases) put(a.sku, a.alias);
  for (const a of amazon) put(a.sku, a.seller_sku || a.asin);
  for (const o of bestBuy) put(o.sku, o.bb_product_id);
  const own = pages
    .filter((p) => p.verdict !== 'broken' && p.sku_check !== 'other' && p.sku_check !== 'variant')
    .sort((a, b) => String(b.read_at ?? '').localeCompare(String(a.read_at ?? '')));
  for (const p of own) put(p.sku, p.page_item_id || (spec.linkPart ? String(p.url ?? '').match(WAYFAIR_PART)?.[1]?.toUpperCase() : null));
  return codes;
}

const STATUS_FILL = { promo_ok: 'E6F4EA', map_ok: 'E6F4EA', promo_missing: 'FEF3C7', misaligned: 'FCE8E6', no_map: 'F1F3F4' };
const BELOW_FILL = 'FCE8E6';

// Why a product is left out of the comparison (the page's own counters), in a
// few words for the sheets and in full for the Notes.
const REASONS = [
  {
    key: 'not_on_store',
    label: (cfg) => (cfg.kind === 'page' ? 'Broken link: not on the store' : 'Linked in the PIM, no longer on the store'),
    meaning: (cfg) => (cfg.kind === 'page'
      ? 'The Where to Buy check found the product\'s link broken: the store does not carry it, so there is no price to compare.'
      : 'The PIM links the product to this store, and the store no longer has it. A product the store does not carry is not a price problem.'),
  },
  { key: 'other_product', label: () => 'The link opens another product or finish', meaning: () => 'The page shows another product, or another option of this one (finish, size): its price is not this product\'s.' },
  { key: 'other_currency', label: () => 'Shown in another currency', meaning: () => 'The page showed its price in another currency than this channel\'s.' },
  { key: 'read_before_change', label: () => 'Read before the expected price changed', meaning: () => 'A promotion started or ended for the product after its page was last read, so that reading says nothing about today\'s expected price. Left out until the page is read again.' },
  { key: 'sold_out', label: () => 'Sold out, no price on the page', meaning: () => 'The store shows the product sold out, without a price.' },
  { key: 'sold_out_no_stock', label: () => 'Sold out on the store, none in our warehouse', meaning: (cfg) => `The store shows the product sold out and our own warehouse in ${countryOf(cfg)} has no units either: there is nothing to sell, so its price is not compared. A product sold out on the store while we have units still counts.` },
  { key: 'no_price', label: () => 'Read without a price', meaning: () => 'The page showed no price when it was read, or it has not been read yet.' },
];

const currencyOf = (cfg) => cfg.currency ?? (cfg.priceField.endsWith('usd') ? 'USD' : 'CAD');
const countryOf = (cfg) => (cfg.market === 'us' ? 'USA' : 'Canada');
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v));
const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;
const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '');

// When a price was read or pulled is written nowhere in the file (user,
// 2026-11-16: no reading dates, on the screens or in the Excel files).

// "November 2026" from a promotion's period ('2026-11-01').
const monthName = (period) => {
  const [y, m] = String(period ?? '').split('-').map(Number);
  return y && m ? new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '';
};

/** "Stylish_Price_Alignment_Sinks_Direct_Canada_2026-11-13.xlsx" */
export const alignmentFileName = (cfg, date) => `Stylish_Price_Alignment_${String(cfg.label).replace(/['’]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${date}.xlsx`;

const PAGE_HEADERS = ['Page', 'SKU Confirmed', 'In Stock on the Store', 'Page Note'];
const WIDTHS = {
  SKU: 14, 'Model Name': 30, Brand: 10, Category: 20, UPC: 15, Obsolete: 10,
  Status: 21, 'Above / Below': 11, Expected: 12, Difference: 12, 'Difference %': 11,
  'Expected From': 20, Promotion: 32, 'Promotion Starts': 12, 'Promotion Ends': 12,
  'MAP Blue': 11, 'MAP Orange': 11, 'MAP Purple': 11, MSRP: 11,
  'Our Stock': 11, 'Sold 30 d': 9, 'Sold 90 d': 9,
  Page: 46, 'SKU Confirmed': 11, 'In Stock on the Store': 12, 'Page Note': 38,
  Reason: 42, 'Page Shows': 16, 'Price Read': 11, Currency: 9,
};

/**
 * The workbook's sheets (buildSectionedWorkbook).
 * @param cfg     the target (ALIGN_TARGETS[key])
 * @param report  the report on screen (loadLatestAlignment / runPriceAlignment)
 * @param data    { products: [{ sku, model_name, brand, category, upc, is_obsolete, map, map_orange, map_purple, msrp }],
 *                  promoBySku: Map(sku → { kind, name?, period, windowStart, windowEnd }) — loadExpectedPrices,
 *                  monthlyNames: Map(period → the monthly promotion's name),
 *                  stock: Map(sku → units available in the store's country; no entry = not tracked),
 *                  sales: Map(sku → { units_30, units_90 }),
 *                  codes: Map(sku → the product's code on the channel) — marketplaceCodes }
 * @param labels  { category: (key) → label, kind: { monthly: 'Monthly promotion', flash: … } }
 * @param date    'YYYY-MM-DD', the day of the export
 */
export function alignmentSheets({ cfg, report, data, labels, date }) {
  const priceName = regularPriceName(cfg);
  const currency = currencyOf(cfg);
  const country = countryOf(cfg);
  const isPage = cfg.kind === 'page';
  const tiles = alignTiles(cfg);
  const statusLabel = { promo_ok: 'At promo price', promo_missing: 'Missing promo price', ...Object.fromEntries(tiles.map((t) => [t.key, t.label])) };
  const statusKey = new Map(Object.entries(statusLabel).map(([key, label]) => [label, key]));
  const product = new Map((data.products ?? []).map((p) => [p.sku, p]));
  const liveHeader = `On ${cfg.short}`;
  // The product's own code on this channel, right after our SKU — where the PIM has one (MARKETPLACE_CODES).
  const code = MARKETPLACE_CODES[cfg.key] ?? null;
  const PRODUCT = { title: 'Product', color: '1F3864', headers: ['SKU', ...(code ? [code.header] : []), 'Model Name', 'Brand', 'Category', 'UPC', 'Obsolete'] };
  const widthOf = (h) => WIDTHS[h] ?? (code && h === code.header ? 20 : null);

  const productCells = (sku) => {
    const p = product.get(sku) ?? {};
    return [sku, ...(code ? [data.codes?.get(sku) ?? ''] : []), p.model_name ?? '', p.brand ?? '', p.category ? labels.category(p.category) : '', p.upc ?? '', p.is_obsolete ? 'Yes' : ''];
  };
  const pageCells = (e) => [e.url ?? '', e.url ? (e.unconfirmed ? 'No' : 'Yes') : '', yesNo(e.in_stock), e.page_note ?? ''];

  // ---- the price sheets ----
  const sections = [
    PRODUCT,
    { title: `Price on ${cfg.label} (${currency})`, color: '01579B', headers: ['Status', 'Above / Below', liveHeader, 'Expected', 'Difference', 'Difference %'] },
    { title: 'Where the expected price comes from', color: '455A64', headers: ['Expected From', 'Promotion', 'Promotion Starts', 'Promotion Ends'] },
    { title: `Prices in the PIM (${currency})`, color: '1E5631', headers: ['MAP Blue', 'MAP Orange', 'MAP Purple', 'MSRP'] },
    { title: `Our stock and sales — ${country}`, color: '4E342E', headers: ['Our Stock', 'Sold 30 d', 'Sold 90 d'] },
    ...(isPage ? [{ title: 'What the store page showed', color: '6A1B9A', headers: PAGE_HEADERS }] : []),
  ];
  const headers = sections.flatMap((s) => s.headers);
  const col = (h) => headers.indexOf(h);
  const MONEY = new Set([liveHeader, 'Expected', 'Difference', 'MAP Blue', 'MAP Orange', 'MAP Purple', 'MSRP']);
  const formats = headers.map((h) => (MONEY.has(h) ? 'money' : h === 'Difference %' ? 'percent' : h === 'Page' ? 'link' : null));
  const widths = headers.map((h) => (h === liveHeader ? 14 : widthOf(h)));

  // One row: a problem (its own status, and its side) or an aligned product.
  const priceRow = (e, key, problem) => {
    const p = product.get(e.sku) ?? {};
    const both = e.live != null && e.expected != null;
    // The promotion behind the expected price — only when that price IS a promotion's.
    const promo = e.source === 'promo' ? data.promoBySku?.get(e.sku) ?? null : null;
    const kind = e.source === 'promo' ? (e.promo_kind ?? promo?.kind ?? 'monthly') : null;
    const from = e.expected == null ? '' : kind ? (labels.kind[kind] ?? 'Promotion') : `Regular ${priceName}`;
    const promoName = promo ? (promo.name ?? data.monthlyNames?.get(promo.period) ?? monthName(promo.period)) : '';
    const sales = data.sales?.get(e.sku);
    return [
      ...productCells(e.sku),
      statusLabel[key] ?? key,
      problem ? PRICE_SIDE_LABEL[priceSide(e)] : '',
      num(e.live), num(e.expected),
      both ? round(e.live - e.expected, 2) : '',
      both && Number(e.expected) ? round((e.live - e.expected) / e.expected, 4) : '',
      from, promoName, promo?.windowStart ?? '', promo?.windowEnd ?? '',
      num(p.map), num(p.map_orange), num(p.map_purple), num(p.msrp),
      data.stock?.has(e.sku) ? Number(data.stock.get(e.sku)) : NOT_TRACKED,
      Number(sales?.units_30) || 0, Number(sales?.units_90) || 0,
      ...(isPage ? pageCells(e) : []),
    ];
  };
  const bySku = (a, b) => String(a[0]).localeCompare(String(b[0]));
  const problemRows = (report.problems ?? []).map((e) => priceRow(e, e.status, true)).sort(bySku);
  // The file holds what the page counts and lists. On BB&B and Overstock a page
  // read sold out or with its SKU not confirmed is in no tile (`unsureUncounted`,
  // user 2026-11-06): listed when it is a problem, as on the page, and left out
  // when it is not — nothing here or on the page says so ("no lo indiques").
  const counted = (e) => !(cfg.unsureUncounted && (e.in_stock === false || e.unconfirmed));
  const alignedRows = (report.aligned ?? []).filter(counted).map((e) => priceRow(e, e.source === 'promo' ? 'promo_ok' : 'map_ok', false));
  const allRows = [...problemRows, ...alignedRows].sort(bySku);

  // The status takes its color; Below — a store under the expected price — is the red one.
  const cellColor = (values, c) => {
    if (c === col('Status')) { const fill = STATUS_FILL[statusKey.get(values[c])]; return fill ? { fill, bold: true } : null; }
    if (c === col('Above / Below')) return values[c] === PRICE_SIDE_LABEL.below ? { fill: BELOW_FILL, bold: true } : null;
    return null;
  };
  const priceSheet = (name, rows) => ({ name, sections, rows, formats, widths, cellColor });

  // ---- left out ----
  const leftSections = [
    PRODUCT,
    { title: 'Left out of the comparison', color: '455A64', headers: ['Reason'] },
    ...(isPage ? [{ title: 'What the store page showed', color: '6A1B9A', headers: ['Page', 'Page Shows', 'Price Read', 'Currency', 'In Stock on the Store', 'Page Note'] }] : []),
  ];
  const leftHeaders = leftSections.flatMap((s) => s.headers);
  const reasonLabel = Object.fromEntries(REASONS.map((r) => [r.key, r.label(cfg)]));
  const reasonOrder = new Map(REASONS.map((r, i) => [r.key, i]));
  const leftOut = [...(report.leftOut ?? [])].sort((a, b) => (reasonOrder.get(a.reason) ?? 99) - (reasonOrder.get(b.reason) ?? 99) || a.sku.localeCompare(b.sku));
  const leftRows = leftOut.map((e) => [
    ...productCells(e.sku),
    reasonLabel[e.reason] ?? e.reason,
    ...(isPage ? [e.url ?? '', e.page_model ?? '', num(e.price), e.currency ?? '', yesNo(e.in_stock), e.page_note ?? ''] : []),
  ]);
  const leftSheet = {
    name: 'Left out', sections: leftSections, rows: leftRows,
    formats: leftHeaders.map((h) => (h === 'Page' ? 'link' : h === 'Price Read' ? 'money' : null)),
    widths: leftHeaders.map(widthOf),
  };

  // ---- summary ----
  const { pct, aligned, comparable } = alignmentSummary(report);
  const counts = report.counts ?? {};
  const total = report.total ?? 0;
  const sides = { above: 0, below: 0, none: 0 };
  for (const p of report.problems ?? []) sides[priceSide(p)] += 1;
  const when = isPage ? "prices read on the store's pages" : `live prices pulled from ${cfg.short}`;
  const summary = {
    name: 'Summary',
    title: `Price Alignment — ${cfg.label}`,
    subtitle: `${cfg.priceShort} · ${when} · expected prices as the PIM had them when the list was loaded · exported ${date}`,
    widths: [46, 13, 11],
    blocks: [
      {
        title: 'Result',
        note: pct != null ? `${aligned} of the ${comparable} products with a price in the PIM are at their expected price (${pct}%).` : undefined,
        headers: ['Status', 'Products', 'Share'],
        formats: ['topic', 'count', 'percent'],
        rows: tiles.map((t) => [t.label, counts[t.key] ?? 0, total ? round((counts[t.key] ?? 0) / total, 4) : '']),
        total: ['Products compared', total, total ? 1 : ''],
      },
      ...(problemRows.length ? [{
        title: 'Problems, above or below the expected price',
        note: 'Below = the store sells under the expected price.',
        headers: ['Side', 'Problems'],
        formats: ['topic', 'count'],
        rows: [
          [PRICE_SIDE_LABEL.above, sides.above],
          [PRICE_SIDE_LABEL.below, sides.below],
          ...(sides.none ? [[`${PRICE_SIDE_LABEL.none} to compare`, sides.none]] : []),
        ],
        total: ['All problems', problemRows.length],
      }] : []),
      ...(leftRows.length ? [{
        title: 'Left out of the comparison',
        note: 'Not price problems: they are in no count above. Each product is on the "Left out" sheet.',
        headers: ['Reason', 'Products'],
        formats: ['topic', 'count'],
        rows: REASONS.map((r) => [reasonLabel[r.key], leftOut.filter((e) => e.reason === r.key).length]).filter((r) => r[1] > 0),
        total: ['All left out', leftRows.length],
      }] : []),
    ],
  };

  // ---- notes ----
  const margin = `within ±${TOLERANCE_HIGH} of an expected price of ${TOLERANCE_FROM} or more, or ±${TOLERANCE_LOW} under ${TOLERANCE_FROM}`;
  const STATUS_MEANING = {
    promo_ok: 'The store sells it at the price of the promotion running there.',
    map_ok: `The store sells it at the PIM's ${priceName}.`,
    promo_missing: 'The product is in a promotion running on this store, and the store still shows the regular price — or no promotion at all.',
    misaligned: 'The store shows a price that is neither the promotion\'s nor the regular one.',
    no_map: `The PIM has no ${priceName} in ${currency} for it, so there is nothing to compare.`,
  };
  const notes = {
    name: 'Notes',
    title: 'How to read this file',
    subtitle: `Pricing → Price Alignment → ${cfg.label} → Export`,
    widths: [42, 112],
    blocks: [
      {
        title: 'The sheets',
        headers: ['Sheet', 'What it holds'],
        formats: ['topic', 'wrap'],
        rows: [
          ['Summary', 'The counts of the Price Alignment page for this channel.'],
          ...(problemRows.length ? [['Problems', 'The page\'s problems table: every problem, whatever filter (All / Above / Below) the page was showing.']] : []),
          ['All prices', 'Every product compared: the problems and the products at their expected price.'],
          ...(leftRows.length ? [['Left out', 'The products the comparison leaves out, each with its reason.']] : []),
        ],
      },
      {
        title: 'What each status means',
        headers: ['Status', 'Meaning'],
        formats: ['topic', 'wrap'],
        rows: tiles.map((t) => [t.label, STATUS_MEANING[t.key] ?? '']),
      },
      ...(leftRows.length ? [{
        title: 'Why a product is left out of the comparison',
        headers: ['Reason', 'Meaning'],
        formats: ['topic', 'wrap'],
        rows: REASONS.filter((r) => leftOut.some((e) => e.reason === r.key)).map((r) => [r.label(cfg), r.meaning(cfg)]),
      }] : []),
      {
        title: 'The columns',
        headers: ['Column', 'What it holds'],
        formats: ['topic', 'wrap'],
        rows: [
          ...(code ? [[code.header, `${code.meaning} Empty where the PIM has none for the product.`]] : []),
          [liveHeader, cfg.promoAware === false
            ? `The store's base price, in ${currency}: this store runs its own sales, so only the base price is compared.`
            : `The price the store sells at, in ${currency} (the discounted one while a discount runs).`],
          ['Expected', `What the PIM says the store should sell at that day: the promotion running on this store for the product, else its ${priceName}.`],
          ['Difference', `The store's price minus the expected one. A price ${margin} counts as aligned, so an aligned row can show a small difference.`],
          ['Above / Below', 'On a problem: which side of the expected price the store is on.'],
          ['Expected From', `Regular ${priceName}, or the kind of promotion; its name and its days in this country are in the next three columns.`],
          [`Prices in the PIM (${currency})`, 'The product\'s price levels as they are in the PIM at the export, to see what the store\'s price is closest to.'],
          ['Our Stock', `Our own units available in ${country} (Odoo); "${NOT_TRACKED}" = Odoo does not have the product.`],
          ['Sold 30 d / 90 d', `Units sold in ${country} over the last 30 and 90 days, every marketplace together (Odoo).`],
          ...(isPage ? [
            ['Page', 'The store page the price was read on.'],
            ['SKU Confirmed', 'No = the page names no model the PIM can match to this SKU: the price is compared, but look at the page.'],
            ['In Stock on the Store', 'What the page said when it was read.'],
          ] : []),
        ],
      },
    ],
  };

  return [
    summary,
    ...(problemRows.length ? [priceSheet('Problems', problemRows)] : []),
    priceSheet('All prices', allRows),
    ...(leftRows.length ? [leftSheet] : []),
    notes,
  ];
}
