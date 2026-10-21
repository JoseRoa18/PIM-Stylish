// The Where to Buy Excel (user, 2026-10-21: "un export en Where to Buy … de
// cuáles están broken, missing, y así poder subirlos in bulk"), in the PIM
// Excel's look (sectionedXlsx: a colored band per section, frozen headers,
// filters). One row per product and store — the product's link and what the
// audit last found on it, or a store most products link and this one does
// not ("Link to add"):
//   Summary       counts by status and by store
//   To fix        Broken and Wrong product links
//   Links to add  the stores a product's pages do not link yet
//   All links     every row
//   How to use    the statuses and the upload steps
// The three link sheets have the same columns; a person writes the new
// address in "New Link" (green), REMOVE takes a link off, and the file comes
// back through Listing Health → Where to Buy → Import links
// (planWhereToBuyImport). Both Stylish pages are built from one list per
// product, so a row holds for both sites.

import { CATEGORY_OPTIONS } from '@/features/products/lib/categories';
import { WTB_RETAILERS, cleanWtbUrl, wtbUrlProblem } from '@/features/products/lib/whereToBuy';
import { WTB_VERDICTS, WRONG_PRODUCT, OTHER_FINISH, WTB_VIA, linkStatus } from './whereToBuy';

const CATEGORY = new Map(CATEGORY_OPTIONS.map((c) => [c.value, c.label]));
const STORE_ORDER = new Map(WTB_RETAILERS.map((r, i) => [r.key, i]));
const COUNTRY = { ca: 'Canada', us: 'USA' };
export const NOT_CHECKED = 'Not checked yet';
export const LINK_TO_ADD = 'Link to add';

// The statuses in the order they are counted and explained.
export const STATUS_ORDER = [
  { label: WTB_VERDICTS.ok.label, fill: 'E6F4EA', hint: WTB_VERDICTS.ok.hint },
  { label: WTB_VERDICTS.broken.label, fill: 'FCE8E6', hint: `${WTB_VERDICTS.broken.hint} Not shown on the Stylish websites.` },
  { label: WRONG_PRODUCT.label, fill: 'FEF3C7', hint: 'The link opens another product, or another option of it (finish, size). Not shown on the Stylish websites until it is fixed.' },
  { label: OTHER_FINISH.label, fill: 'E8EEF7', hint: OTHER_FINISH.hint },
  { label: NOT_CHECKED, fill: 'F1F3F4', hint: WTB_VERDICTS.pending.hint },
  { label: WTB_VERDICTS.manual.label, fill: 'F1F3F4', hint: WTB_VERDICTS.manual.hint },
  { label: LINK_TO_ADD, fill: 'FFF1DC', hint: 'Most products have a link to this store; this one has none yet.' },
];
const STATUS_FILL = new Map(STATUS_ORDER.map((s) => [s.label, s.fill]));
const NEW_LINK_FILL = 'EAF5EC';

// The link sheets' columns, by section. The import reads SKU, Store and New Link.
const SECTIONS = [
  { title: 'Product', color: '1F3864', headers: ['SKU', 'Model Name', 'Category'] },
  { title: 'Store', color: '01579B', headers: ['Store', 'Country'] },
  { title: 'Status', color: '455A64', headers: ['Status', 'Why'] },
  { title: 'Link on the Stylish pages', color: '0B5394', headers: ['Current Link'] },
  { title: 'Your change — fill in to upload', color: '1E5631', headers: ['New Link'] },
  { title: 'What the store page showed', color: '4E342E', headers: ['Page Shows', 'Price', 'Was', 'Currency', 'In Stock', 'Read', 'Last Check', 'Checked Via'] },
  { title: 'Suggested by the PIM', color: '6A1B9A', headers: ['Suggested Link'] },
];
const HEADERS = SECTIONS.flatMap((s) => s.headers);
const col = (h) => HEADERS.indexOf(h);
const FORMATS = HEADERS.map((h) => ({ 'Current Link': 'link', 'Suggested Link': 'link', Price: 'money', Was: 'money' }[h] ?? null));

// "2026-10-21 08:04" in the reader's own time.
const stamp = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Why a link has its status, in a few words.
function whyOf(status, check) {
  if (!check) return status === LINK_TO_ADD ? 'No link to this store yet' : 'Saved in the PIM; checked within the hour';
  if (status === WRONG_PRODUCT.label) {
    return [`The page shows ${check.page_model ?? 'another product'}${check.sku_check === 'variant' ? ' (another option of the same product)' : ''}`, check.page_note].filter(Boolean).join(' · ');
  }
  if (status === OTHER_FINISH.label) return `The store preselects ${check.page_model ?? 'another finish'}; use the option's own address`;
  return [check.note, check.page_note].filter(Boolean).join(' · ');
}

/**
 * One row per product and store, from the PIM's lists and the audit's rows:
 * data = { products: [{ sku, model_name, category, brand }], pim: [{ sku, retailer, url }],
 *          audit: [where_to_buy_links rows of both Stylish sites], suggestions: [{ sku, retailer, url, checked_at }] }.
 * Azuni is never on the Stylish websites, so its products are left out.
 */
export function whereToBuyRows({ products, pim, audit, suggestions }) {
  const product = new Map(products.map((p) => [p.sku, p]));
  const stylish = (sku) => product.has(sku) && !/azuni/i.test(product.get(sku).brand ?? '');
  const linkOf = new Map(pim.map((l) => [`${l.sku}|${l.retailer}`, l.url]));
  // The audit's answer on the PIM's address (newest of the two sites), and
  // the stores either page reports missing.
  const checkOf = new Map();
  const missing = new Set();
  for (const a of audit) {
    const k = `${a.sku}|${a.retailer}`;
    if (a.verdict === 'missing') { if (!a.url) missing.add(k); continue; }
    if (!a.url || linkOf.get(k) !== a.url) continue;
    const prev = checkOf.get(k);
    if (!prev || (a.checked_at ?? '') > (prev.checked_at ?? '')) checkOf.set(k, a);
  }
  const suggestionOf = new Map();
  for (const s of [...suggestions].sort((a, b) => (b.checked_at ?? '').localeCompare(a.checked_at ?? ''))) {
    const k = `${s.sku}|${s.retailer}`;
    if (!suggestionOf.has(k)) suggestionOf.set(k, s.url);
  }
  const keys = new Set([...linkOf.keys(), ...[...missing].filter((k) => !linkOf.has(k))]);
  const rows = [];
  for (const k of keys) {
    const [sku, retailer] = k.split('|');
    const store = WTB_RETAILERS.find((r) => r.key === retailer);
    if (!store || !stylish(sku)) continue;
    const url = linkOf.get(k) ?? '';
    const check = checkOf.get(k) ?? null;
    const status = !url ? LINK_TO_ADD : check ? linkStatus(check).label : NOT_CHECKED;
    const p = product.get(sku);
    rows.push({
      sku, retailer, store: store.label, country: COUNTRY[store.market] ?? store.market, status,
      model: p.model_name ?? '', category: CATEGORY.get(p.category) ?? p.category ?? '', url,
      why: whyOf(status, check), check, suggested: suggestionOf.get(k) ?? '',
    });
  }
  return rows.sort((a, b) => a.sku.localeCompare(b.sku) || (STORE_ORDER.get(a.retailer) ?? 99) - (STORE_ORDER.get(b.retailer) ?? 99));
}

const sheetRow = (r) => {
  const c = r.check;
  const read = c?.read_at ? c : null;
  return [
    r.sku, r.model, r.category, r.store, r.country, r.status, r.why, r.url, '',
    read?.page_model ?? '', read?.price != null ? Number(read.price) : '', read?.was_price != null ? Number(read.was_price) : '',
    read?.currency ?? '', read ? ({ true: 'Yes', false: 'No' }[String(read.in_stock)] ?? '') : '', stamp(read?.read_at),
    stamp(c?.checked_at), c?.checked_via ? (WTB_VIA[c.checked_via] ?? c.checked_via) : '', r.suggested,
  ];
};

// The status cell takes its status color; New Link is tinted as the column to fill in.
const cellColor = (values, c) => {
  if (c === col('Status')) return STATUS_FILL.has(values[c]) ? { fill: STATUS_FILL.get(values[c]), bold: true } : null;
  if (c === col('New Link')) return NEW_LINK_FILL;
  return null;
};

const WIDTHS = {
  SKU: 13, 'Model Name': 30, Category: 16, Store: 20, Country: 9, Status: 15, Why: 40, 'Current Link': 46, 'New Link': 46,
  'Page Shows': 13, Price: 10, Was: 10, Currency: 9, 'In Stock': 8, Read: 16, 'Last Check': 16, 'Checked Via': 12, 'Suggested Link': 40,
};

// New Link is wide enough to paste an address, and its empty cells keep the
// current link from spilling over them.
const linkSheet = (name, rows) => ({
  name, sections: SECTIONS, rows: rows.map(sheetRow), formats: FORMATS, cellColor,
  widths: HEADERS.map((h) => WIDTHS[h] ?? null), emptyText: [col('New Link')],
});

/** The workbook's sheets (buildSectionedWorkbook), from whereToBuyRows. */
export function whereToBuySheets(rows, date) {
  const toFix = rows.filter((r) => r.status === WTB_VERDICTS.broken.label || r.status === WRONG_PRODUCT.label)
    .sort((a, b) => a.status.localeCompare(b.status) || a.sku.localeCompare(b.sku) || (STORE_ORDER.get(a.retailer) ?? 99) - (STORE_ORDER.get(b.retailer) ?? 99));
  const toAdd = rows.filter((r) => r.status === LINK_TO_ADD)
    .sort((a, b) => (STORE_ORDER.get(a.retailer) ?? 99) - (STORE_ORDER.get(b.retailer) ?? 99) || a.sku.localeCompare(b.sku));

  const count = (list, label) => list.filter((r) => r.status === label).length;
  const products = new Set(rows.map((r) => r.sku)).size;
  const links = rows.filter((r) => r.url).length;
  const byStore = WTB_RETAILERS.map((s) => ({ s, list: rows.filter((r) => r.retailer === s.key) })).filter((x) => x.list.length);
  const statusCols = STATUS_ORDER.map((s) => s.label);
  const summary = {
    name: 'Summary',
    title: 'Stylish — Where to Buy links',
    subtitle: `${products} products, ${links} links · exported ${date}. Both Stylish websites (Canada and USA) are built from one list per product, so each row holds for both.`,
    widths: [26, 11, 11, 11, 11, 13, 11, 13, 12, 12],
    blocks: [
      {
        title: 'By status',
        headers: ['Status', 'Links'],
        formats: ['topic', 'count'],
        rows: STATUS_ORDER.map((s) => [s.label, count(rows, s.label)]),
        total: ['All', rows.length],
      },
      {
        title: 'By store',
        note: 'Links to add: the stores most products link and this product does not.',
        headers: ['Store', 'Country', ...statusCols],
        formats: ['topic', 'center', ...statusCols.map(() => 'count')],
        rows: byStore.map(({ s, list }) => [s.label, COUNTRY[s.market], ...statusCols.map((l) => count(list, l))]),
        total: ['All stores', '', ...statusCols.map((l) => count(rows, l))],
      },
    ],
  };
  const howTo = {
    name: 'How to use',
    title: 'How to read and upload this file',
    subtitle: 'Listing Health → Where to Buy → Export / Import links',
    widths: [26, 110],
    blocks: [
      {
        title: 'What each status means',
        headers: ['Status', 'Meaning'],
        formats: ['topic', 'wrap'],
        rows: STATUS_ORDER.map((s) => [s.label, s.hint]),
      },
      {
        title: 'Upload changes in bulk',
        headers: ['Step', 'What to do'],
        formats: ['topic', 'wrap'],
        rows: [
          ['1. Write the address', 'On "To fix", "Links to add" or "All links", write the store page of the product in the green "New Link" column. A "Suggested Link" is an address the PIM already opened and found right.'],
          ['2. Remove a link', 'Write REMOVE in "New Link": the link leaves the product\'s list and both Stylish pages.'],
          ['3. Keep a link', 'Leave "New Link" empty. Nothing else in the row is read, so the other columns can stay as they are.'],
          ['4. A store not listed', 'Add a row at the end of "All links" with the SKU, the Store (pick it from the list) and the New Link.'],
          ['5. Upload', 'Listing Health → Where to Buy → Import links, choose this file and review the changes. "Save and publish" writes them into each product\'s list and both Stylish pages; the new links are opened within minutes, and a broken one leaves the pages by itself.'],
          ['Note', 'An address must be a page of that store (a Wayfair.ca link on the Wayfair.ca row). Azuni products are never on the Stylish websites and are not in this file.'],
        ],
      },
    ],
  };
  return [summary, linkSheet('To fix', toFix), linkSheet('Links to add', toAdd), linkSheet('All links', rows), howTo];
}

/** The Store column's dropdown: the stores' labels. */
export const whereToBuyValidation = (header) => (header === 'Store' ? { type: 'list', values: WTB_RETAILERS.map((r) => r.label), strict: true } : null);

// The parser finds the header row by the columns it knows.
const KNOWN = new Set(['sku', 'store', 'new link', 'current link', 'status']);
export const scoreWhereToBuyHeader = (cells) => cells.filter((c) => KNOWN.has(String(c ?? '').trim().toLowerCase())).length;

const REMOVE_RE = /^(remove|delete)$/i;
const storeByName = new Map(WTB_RETAILERS.flatMap((r) => [[r.label.toLowerCase(), r], [r.key, r]]));

/**
 * What an uploaded file changes. `rows` = parseSpreadsheetFile's rows (keyed by
 * header, `__row` / `__sheet`); `products` = [{ sku, brand }], `current` =
 * product_where_to_buy rows. Returns { changes: [{ sku, retailer, store,
 * action: 'add' | 'replace' | 'remove', from, to, where }], problems: [{ where,
 * sku, store, problem }], unchanged, rowsRead }. A row with an empty New Link
 * changes nothing; the same product and store set two ways is a problem.
 */
export function planWhereToBuyImport(rows, { products, current }) {
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const byUpper = new Map(products.map((p) => [p.sku.toUpperCase(), p]));
  const linkOf = new Map(current.map((l) => [`${l.sku}|${l.retailer}`, l.url]));
  const value = (row, name) => {
    const key = Object.keys(row).find((h) => h.trim().toLowerCase() === name);
    return key ? String(row[key] ?? '').trim() : '';
  };
  const planned = new Map(); // sku|retailer → change
  const problems = [];
  const conflicted = new Set();
  let unchanged = 0;
  let rowsRead = 0;
  for (const row of rows) {
    const raw = value(row, 'new link');
    if (!raw) continue;
    rowsRead += 1;
    const where = `${row.__sheet ? `${row.__sheet} · ` : ''}row ${row.__row ?? '?'}`;
    const skuText = value(row, 'sku');
    const storeText = value(row, 'store');
    const product = bySku.get(skuText) ?? byUpper.get(skuText.toUpperCase());
    const store = storeByName.get(storeText.toLowerCase());
    const problem = (p) => problems.push({ where, sku: skuText, store: storeText, problem: p });
    if (!skuText) { problem('No SKU'); continue; }
    if (!product) { problem('Not a SKU of the PIM'); continue; }
    if (/azuni/i.test(product.brand ?? '')) { problem('Azuni products are never on the Stylish websites'); continue; }
    if (!store) { problem(storeText ? 'Not a store of the list' : 'No store'); continue; }
    const k = `${product.sku}|${store.key}`;
    const from = linkOf.get(k) ?? '';
    let change;
    if (REMOVE_RE.test(raw)) {
      if (!from) { unchanged += 1; continue; }
      change = { sku: product.sku, retailer: store.key, store: store.label, action: 'remove', from, to: '', where };
    } else {
      const url = cleanWtbUrl(raw);
      const bad = wtbUrlProblem(store.key, url);
      if (bad) { problem(bad); continue; }
      if (url === from) { unchanged += 1; continue; }
      change = { sku: product.sku, retailer: store.key, store: store.label, action: from ? 'replace' : 'add', from, to: url, where };
    }
    const prev = planned.get(k);
    if (prev && (prev.action !== change.action || prev.to !== change.to)) {
      if (!conflicted.has(k)) problem(`Set two ways in the file (also ${prev.where}): neither is used`);
      conflicted.add(k);
      continue;
    }
    planned.set(k, change);
  }
  for (const k of conflicted) planned.delete(k);
  const changes = [...planned.values()].sort((a, b) => a.sku.localeCompare(b.sku) || (STORE_ORDER.get(a.retailer) ?? 99) - (STORE_ORDER.get(b.retailer) ?? 99));
  return { changes, problems, unchanged, rowsRead };
}
