import {
  loadJSZip,
  openTemplate,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  columnStyles,
  indexToCol,
  injectRows,
  listSheetNames,
  fetchImagesBySku,
  downloadMediaZip,
  labelTask,
} from './templateFiller';
import {
  MENARDS_IMAGE_CELL,
  menardsColumns,
  menardsGallery,
  menardsImageName,
  menardsNotes,
  menardsRow,
  readMenardsReference,
} from '../lib/menardsFile';

// Menards (Syndigo) exporter.
//
// Menards' new product file is Syndigo's "Menards Product Content" workbook:
//   "Attributes"  rows 1-5 the columns (their ids, source, locale, Required /
//                 Conditional / Optional, their names), one product a row from row 6;
//   "Reference"   every column again: what it takes and, for a list, its entries.
// The file kept in Templates is that workbook without a product row. An older
// download for one category (requirement set 30: the same columns, the
// category's own after them, and a small "Containers" workbook per dimension)
// fills by the same rules — whatever Templates holds for Menards is what goes out.
//
// What goes in each column, and why, is in ../lib/menardsFile.js: the file
// Vladimir completed for C234L (2026-11-25). Until then a row left the account's
// columns empty (vendor, merchant, cost, terms, master pack) and answered in
// words the lists do not have ("Yes" where the list says "Y", "inch" for
// "inches", "year" for "month", the retail pack's "Box"), with the box's width
// and depth the wrong way round.

const START = 6; // rows 1-5 are Syndigo's header block
const HEADER_SHEETS = new Set(['Summary', 'Reference']);

/**
 * Fill one Menards workbook. Returns it as a blob under its own name plus what
 * the caller reports. `task` (optional taskProgress reporter): the template
 * 40%, the rows 10%, writing the file the rest.
 */
async function fillOne(template, products, galleries, task = null) {
  const { zip, shared } = await openTemplate(template.storage_path, { task: task?.part(0, 0.4) });
  const sheetNames = listSheetNames(await zip.file('xl/workbook.xml').async('string'));

  // The data sheet is the one whose row 5 carries the columns' names:
  // "Attributes", or a dimension's own sheet in a Containers workbook.
  let dataPath = null;
  let dataSheet = null;
  let grid = null;
  for (const name of sheetNames.filter((n) => !HEADER_SHEETS.has(n))) {
    const path = await sheetPathByName(zip, name);
    if (!path) continue;
    const g = sheetToGrid(await zip.file(path).async('string'), shared);
    if ((g[4] || []).filter(Boolean).length > 0) { dataPath = path; dataSheet = name; grid = g; break; }
  }
  if (!dataPath) throw new Error(`${template.file_name} is not a Menards file: no sheet has the columns' names on row 5.`);

  const referencePath = await sheetPathByName(zip, 'Reference');
  const reference = readMenardsReference(referencePath ? sheetToGrid(await zip.file(referencePath).async('string'), shared) : []);
  const names = grid[4] || [];
  const columns = menardsColumns(names, grid[3] || [], reference);
  const ncols = names.length;

  if (task) {
    task.progress(0.4);
    await task.step(`Filling ${products.length} row${products.length === 1 ? '' : 's'}…`);
  }
  // A file that still holds a product's row (a download with one filled in)
  // gives its place to the rows written now.
  let sheetXml = (await zip.file(dataPath).async('string'))
    .replace(/<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g, (row, r) => (Number(r) >= START ? '' : row));
  const styles = columnStyles(sheetXml);
  const report = { offList: new Map(), cut: [], bad: [] };
  const rows = products.map((p) => menardsRow(p, columns, { gallery: galleries[p.sku] ?? [], imageCell: MENARDS_IMAGE_CELL }, report));

  // Every cell a text in the column's own format, as Menards' files hold them.
  const rowsXml = rows.map((cells, i) => {
    const rowNum = START + i;
    const body = [...cells].sort((a, b) => a[0] - b[0])
      .map(([ci, value]) => buildCell(`${indexToCol(ci + 1)}${rowNum}`, value, styles.get(ci + 1) ?? null)).join('');
    return `<row r="${rowNum}" spans="1:${ncols}">${body}</row>`;
  }).join('');
  sheetXml = injectRows(sheetXml, rowsXml, START - 1 + products.length);
  zip.file(dataPath, sheetXml);

  // The pictures the rows name, to hand over beside the workbook.
  const pictures = [];
  rows.forEach((cells, i) => {
    const gallery = galleries[products[i].sku] ?? [];
    for (const c of columns) {
      if (c && c.picture !== null && cells.has(c.ci) && gallery[c.picture]) pictures.push({ name: menardsImageName(gallery[c.picture]), url: gallery[c.picture] });
    }
  });

  const writing = task?.part(0.5, 1);
  writing?.progress(0, 'Writing the file…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }, writing ? (meta) => writing.progress(meta.percent / 100) : undefined);
  const required = columns.filter((c) => c?.required);
  return {
    file: template.file_name,
    blob,
    dataSheet,
    columns: ncols,
    pictures,
    notes: menardsNotes({ columns, rows, products, report }),
    fillReport: { rows: products.length, columns: required.map((c) => ({ label: c.name, filled: rows.filter((r) => r.has(c.ci)).length })) },
  };
}

/**
 * Fill the Menards files Templates holds for these products and download them
 * as one ZIP: the workbook(s) under their own names and, in an "Images"
 * folder, every picture the rows name, under the very name written in its cell.
 * @param {Object[]} templates  marketplace_templates rows (the Menards files that apply)
 * @param {Object[]} products   full product rows
 * @param {{ task?: object }} [options]  `task`: a taskProgress reporter
 * @returns {{ files, count, images, imagesFailed, missingData, results }}
 */
export async function generateMenardsFromTemplates(templates, products, { task = null } = {}) {
  if (!templates?.length) throw new Error('No Menards template is uploaded: add the Menards Product Content file in Templates.');
  if (!products?.length) throw new Error('No products to export.');

  task?.step(`Reading the images of ${products.length} product${products.length === 1 ? '' : 's'}…`);
  const images = await fetchImagesBySku(products.map((p) => p.sku));
  const galleries = Object.fromEntries(products.map((p) => [p.sku, menardsGallery(images[p.sku])]));
  task?.progress(0.05);

  // The same workbook uploaded twice is told by its data sheet: each Containers
  // file has its dimension's own sheet, a content file "Attributes".
  const withImages = MENARDS_IMAGE_CELL === 'name';
  const filesShare = withImages ? 0.3 : 0.85;
  const results = [];
  const seenSheets = new Set();
  for (const [i, t] of templates.entries()) {
    const slice = labelTask(task?.part(0.05 + (filesShare * i) / templates.length, 0.05 + (filesShare * (i + 1)) / templates.length), templates.length > 1 ? `File ${i + 1} of ${templates.length}` : '');
    const r = await fillOne(t, products, galleries, slice);
    if (seenSheets.has(r.dataSheet)) continue;
    seenSheets.add(r.dataSheet);
    results.push(r);
  }

  const JSZip = await loadJSZip();
  const bundle = new JSZip();
  for (const r of results) bundle.file(r.file, r.blob);
  const day = new Date().toISOString().slice(0, 10);
  const categories = new Set(products.map((p) => p.category));
  const label = (products.length === 1 ? products[0].sku : categories.size === 1 ? [...categories][0] : `${products.length}_products`).replace(/[^\w-]+/g, '_');
  const baseName = `Menards_${label}`;

  // The pictures once each: several files of a set name the same ones.
  const entries = withImages ? [...new Map(results.flatMap((r) => r.pictures).map((e) => [e.name, e])).values()] : [];
  const downloaded = await downloadMediaZip(entries, baseName, {
    task: task?.part(0.05 + filesShare, 1),
    into: bundle,
    root: 'Images',
    partName: (part, only) => `${baseName}${only ? '' : `_part${part}`}_${day}.zip`,
  });

  // A set's files say the same of the columns they share: each note once.
  const missingData = [...new Set(results.flatMap((r) => r.notes))];
  if (downloaded.failed.length) missingData.push(`${downloaded.failed.length} image${downloaded.failed.length === 1 ? '' : 's'} could not be downloaded (listed in the ZIP)`);
  if (missingData.length) console.warn('[Menards export] To look at:', missingData);
  return {
    files: results.length,
    count: products.length,
    images: downloaded.files,
    imagesFailed: downloaded.failed.length,
    missingData,
    results,
  };
}
