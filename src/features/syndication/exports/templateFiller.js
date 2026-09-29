import { supabase } from '@/lib/supabase';

// Marketplace-agnostic machinery for filling marketplace XLSX templates
// WITHOUT altering them: we edit the worksheet XML in place (JSZip) and inject
// data rows, so all formatting, data validations (dropdowns), helper sheets and
// Valid Values survive exactly as uploaded. (SheetJS would reconstruct the file
// and drop all of it.)
//
// Each marketplace exporter (wayfairExport, bbbExport, …) supplies its own
// header location, row-building rules and download flow on top of these pieces.

export async function loadJSZip() {
  const mod = await import('jszip');
  return mod.default;
}

export const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
export const escapeXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export const colToIndex = (col) => { let n = 0; for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
export const indexToCol = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

export function buildCell(ref, value, style = null) {
  if (value === '' || value == null) return '';
  const s = style ? ` s="${style}"` : '';
  if (typeof value === 'number') return `<c r="${ref}"${s}><v>${value}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

// A formula cell (no cached value: Excel computes it on open).
export function buildFormulaCell(ref, formula, style = null) {
  const s = style ? ` s="${style}"` : '';
  return `<c r="${ref}"${s}><f>${escapeXml(formula)}</f></c>`;
}

// Excel serial number for a calendar day "YYYY-MM-DD" (1900 date system).
export function excelSerial(day) {
  const [y, m, d] = String(day).slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

export function parse(xml) {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

export function parseSharedStrings(xml) {
  if (!xml) return [];
  const doc = parse(xml);
  const sis = doc.getElementsByTagNameNS(NS, 'si');
  const out = [];
  for (let i = 0; i < sis.length; i++) {
    const ts = sis[i].getElementsByTagNameNS(NS, 't');
    let txt = '';
    for (let j = 0; j < ts.length; j++) txt += ts[j].textContent ?? '';
    out.push(txt);
  }
  return out;
}

// worksheet name → "xl/worksheets/sheetN.xml"
export async function sheetPathByName(zip, name) {
  const wb = parse(await zip.file('xl/workbook.xml').async('string'));
  const rels = parse(await zip.file('xl/_rels/workbook.xml.rels').async('string'));
  const relMap = {};
  const relEls = rels.getElementsByTagName('Relationship');
  for (let i = 0; i < relEls.length; i++) relMap[relEls[i].getAttribute('Id')] = relEls[i].getAttribute('Target');
  const sheets = wb.getElementsByTagNameNS(NS, 'sheet');
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getAttribute('name') === name) {
      const rid =
        sheets[i].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ||
        sheets[i].getAttribute('r:id');
      const target = relMap[rid] || '';
      // Rel targets are usually relative to xl/ ("worksheets/sheet1.xml"),
      // but some writers (openpyxl among them) emit absolute targets
      // ("/xl/worksheets/sheet1.xml") — those already carry the full path.
      return target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    }
  }
  return null;
}

// All worksheet names, in workbook order. Names are XML-entity decoded so
// they compare equal to what sheetPathByName (DOM-based) sees — sheet names
// with "&" (e.g. Walmart's "Home Decor, Kitchen, & Other") arrive encoded.
export function listSheetNames(workbookXml) {
  return [...workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((m) =>
    m[1]
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'),
  );
}

// Read a worksheet into a 2D array [rowIdx][colIdx] of text (resolving shared strings).
export function sheetToGrid(xml, shared) {
  const doc = parse(xml);
  const rows = doc.getElementsByTagNameNS(NS, 'row');
  const grid = [];
  for (let r = 0; r < rows.length; r++) {
    const rowNum = parseInt(rows[r].getAttribute('r') ?? String(r + 1), 10);
    const cells = rows[r].getElementsByTagNameNS(NS, 'c');
    const arr = [];
    for (let c = 0; c < cells.length; c++) {
      const ref = cells[c].getAttribute('r') || '';
      const col = (ref.match(/^[A-Z]+/) || ['A'])[0];
      const ci = colToIndex(col) - 1;
      const t = cells[c].getAttribute('t');
      let val = '';
      if (t === 'inlineStr') {
        const isEl = cells[c].getElementsByTagNameNS(NS, 'is')[0];
        if (isEl) { const ts = isEl.getElementsByTagNameNS(NS, 't'); for (let k = 0; k < ts.length; k++) val += ts[k].textContent ?? ''; }
      } else {
        const v = cells[c].getElementsByTagNameNS(NS, 'v')[0];
        const raw = v ? v.textContent ?? '' : '';
        val = t === 's' ? shared[parseInt(raw, 10)] ?? '' : raw;
      }
      arr[ci] = val;
    }
    grid[rowNum - 1] = arr;
  }
  return grid;
}

// Valid Values sheet → { fieldName: Map(normalizedOption → exactOption) }
export function buildValidMaps(vvGrid) {
  const maps = {};
  if (!vvGrid.length) return maps;
  (vvGrid[0] || []).forEach((h, ci) => {
    if (!h) return;
    const m = new Map();
    for (let r = 1; r < vvGrid.length; r++) {
      const v = vvGrid[r] && vvGrid[r][ci];
      if (v != null && v !== '') m.set(norm(v), v);
    }
    maps[h] = m;
  });
  return maps;
}

// Snap a (possibly "a; b; c" multi-)value onto the template's exact options.
export function snap(value, validMap) {
  if (!validMap || value === '' || value == null) return value;
  return String(value)
    .split(';')
    .map((part) => { const t = part.trim(); return t ? validMap.get(norm(t)) ?? t : ''; })
    .filter(Boolean)
    .join('; ');
}

// Download a template from the `templates` bucket and open it as a zip.
export async function openTemplate(templateStoragePath) {
  const JSZip = await loadJSZip();
  const { data: blob, error } = await supabase.storage.from('templates').download(templateStoragePath);
  if (error) throw new Error(`Failed to download template: ${error.message}`);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const sharedFile = zip.file('xl/sharedStrings.xml');
  const shared = parseSharedStrings(sharedFile ? await sharedFile.async('string') : '');
  return { zip, shared };
}

// Merge new cells into an existing <row> element: cells we write replace the
// originals at the same ref, everything else (styles, defaults, formulas) is
// kept, and the result stays in column order as OOXML requires. Keys of
// newCellsByCol are 1-based column indexes (same as colToIndex).
// With keepStyle, a new cell that carries no style takes the style (s="…")
// of the cell it replaces, so a template's pre-formatted empty rows keep
// their date and currency formats.
export function mergeRowXml(rowXml, newCellsByCol, keepStyle = false) {
  const open = rowXml.match(/^<row ([^>]*?)\/?>/);
  const attrs = open[1].replace(/\/\s*$/, '').trim();
  const cells = new Map();
  for (const m of rowXml.matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
    cells.set(colToIndex(m[1]), m[0]);
  }
  for (const [ci, xml] of newCellsByCol) {
    let cell = xml;
    if (keepStyle && !/^<c [^>]*\ss="/.test(cell)) {
      const style = cells.get(ci)?.match(/^<c [^>]*\ss="(\d+)"/)?.[1];
      if (style) cell = cell.replace(/^<c r="([A-Z]+\d+)"/, `<c r="$1" s="${style}"`);
    }
    cells.set(ci, cell);
  }
  const body = [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('');
  return `<row ${attrs}>${body}</row>`;
}

// Walk a sheet's XML once, splicing merged rows in ascending order. For
// templates that ship with every data row already present (Lowe's, Home Depot
// Canada) — injecting rows there would duplicate row numbers.
export function mergeRows(sheetXml, cellsByRow, keepStyle = false) {
  let out = '';
  let cursor = 0;
  for (const rn of [...cellsByRow.keys()].sort((a, b) => a - b)) {
    const start = sheetXml.indexOf(`<row r="${rn}"`, cursor);
    if (start === -1) continue;
    const tagClose = sheetXml.indexOf('>', start);
    const end = sheetXml[tagClose - 1] === '/' ? tagClose + 1 : sheetXml.indexOf('</row>', tagClose) + '</row>'.length;
    out += sheetXml.slice(cursor, start) + mergeRowXml(sheetXml.slice(start, end), cellsByRow.get(rn), keepStyle);
    cursor = end;
  }
  return out + sheetXml.slice(cursor);
}

// Take rows out of a sheet and close the gaps: every row below a removed one
// moves up (its r attribute and its cells' refs are renumbered), and the
// dimension shrinks. Formulas or merged ranges pointing at moved rows are
// not rewritten — meant for plain list files (marketplace promo files).
export function removeRows(sheetXml, rowNums) {
  const gone = new Set(rowNums.map(Number));
  if (!gone.size) return sheetXml;
  let shift = 0;
  const out = sheetXml.replace(/<row r="(\d+)"([^>]*?)(\/>|>[\s\S]*?<\/row>)/g, (whole, r, attrs, rest) => {
    const rn = Number(r);
    if (gone.has(rn)) { shift += 1; return ''; }
    if (!shift) return whole;
    const nn = rn - shift;
    const body = rest.replace(/<c r="([A-Z]+)\d+"/g, `<c r="$1${nn}"`);
    return `<row r="${nn}"${attrs}${body}`;
  });
  const last = [...out.matchAll(/<row r="(\d+)"/g)].reduce((m, x) => Math.max(m, Number(x[1])), 1);
  return out.replace(/(<dimension ref="[A-Z]+\d+:[A-Z]+)\d+("\s*\/>)/, `$1${last}$2`);
}

// Keep only the data rows in `keep` (1-based numbers, all ≥ fromRow): the
// others are dropped and the kept ones renumbered consecutively from fromRow,
// cell refs included; the rows above fromRow (header, labels, instructions)
// stay as they are. Only for sheets without formulas, merges or validations
// below fromRow (Wayfair's Partner Home files) — nothing else is shifted.
export function keepOnlyRows(xml, fromRow, keep) {
  let next = fromRow;
  let removed = 0;
  const out = xml.replace(/<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g, (row, n) => {
    if (Number(n) < fromRow) return row;
    if (!keep.has(Number(n))) { removed += 1; return ''; }
    const to = next++;
    return row.replace(/^<row r="\d+"/, `<row r="${to}"`).replace(/(<c r="[A-Z]+)\d+"/g, `$1${to}"`);
  });
  const lastRow = next - 1;
  return { xml: out.replace(/(<dimension ref="[A-Z]+1:[A-Z]+)\d+/, `$1${lastRow}`), removed, lastRow };
}

// Remove the given rows (1-based numbers) and pull the rows below them up,
// cell refs, the dimension and an autoFilter range included. For files whose
// layout we don't control (Menards'): it refuses — returns null, the sheet
// untouched — when the sheet has formulas, merged cells, validations,
// conditional formats or hyperlinks, which shifting rows would break.
export function removeRowsSafely(xml, drop) {
  if (!drop?.size) return { xml, removed: 0 };
  if (/<f[ >]|<mergeCell |<dataValidation |<conditionalFormatting|<hyperlink /.test(xml)) return null;
  const sorted = [...drop].sort((a, b) => a - b);
  const shiftAt = (n) => { let k = 0; while (k < sorted.length && sorted[k] < n) k += 1; return k; };
  let removed = 0;
  const out = xml.replace(/<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g, (row, n) => {
    const r = Number(n);
    if (drop.has(r)) { removed += 1; return ''; }
    const shift = shiftAt(r);
    if (!shift) return row;
    const to = r - shift;
    return row.replace(/^<row r="\d+"/, `<row r="${to}"`).replace(/(<c r="[A-Z]+)\d+"/g, `$1${to}"`);
  });
  const shrink = (m, head, end) => `${head}${Math.max(1, Number(end) - shiftAt(Number(end) + 1))}`;
  return {
    xml: out
      .replace(/(<dimension ref="[A-Z]+\d+:[A-Z]+)(\d+)/, shrink)
      .replace(/(<autoFilter ref="[A-Z]+\d+:[A-Z]+)(\d+)/, shrink),
    removed,
  };
}

// A cell style with a number format the template lacks (e.g. "$"#,##0.00 for
// a cost Wayfair wants shown as $80.00): the format and an <xf> cloned from
// `baseXf` (the fill / border / font of the cells it replaces) are added to
// styles.xml once — an identical pair already there is reused. Returns the xf
// index to pass to buildCell, or null when the workbook has no styles part.
export async function ensureNumberFormat(zip, formatCode, baseXf = 0) {
  const file = zip.file('xl/styles.xml');
  if (!file) return null;
  let xml = await file.async('string');
  const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  let id = null;
  for (const m of xml.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"\s*\/>/g)) {
    if (unescape(m[2]) === formatCode) { id = Number(m[1]); break; }
  }
  if (id == null) {
    const ids = [...xml.matchAll(/<numFmt numFmtId="(\d+)"/g)].map((m) => Number(m[1]));
    id = Math.max(163, ...ids) + 1;
    const tag = `<numFmt numFmtId="${id}" formatCode="${escapeXml(formatCode)}"/>`;
    xml = /<numFmts\b/.test(xml)
      ? xml.replace(/<numFmts count="(\d+)">/, (m, n) => `<numFmts count="${Number(n) + 1}">`).replace('</numFmts>', `${tag}</numFmts>`)
      : xml.replace(/<styleSheet\b[^>]*>/, (m) => `${m}<numFmts count="1">${tag}</numFmts>`); // numFmts is the first child
  }

  const block = xml.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
  if (!block) return null;
  const xfs = [...block[2].matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)];
  const base = xfs[baseXf] ?? xfs[0];
  const inner = base[2] ?? '';
  const attrs = `${base[1].replace(/\s*numFmtId="\d+"/, '').replace(/\s*applyNumberFormat="\d+"/, '')} numFmtId="${id}" applyNumberFormat="1"`;
  const key = (a) => a.trim().split(/\s+/).sort().join(' ');
  const existing = xfs.findIndex((x) => key(x[1]) === key(attrs) && (x[2] ?? '') === inner);
  if (existing !== -1) { zip.file('xl/styles.xml', xml); return existing; }
  const newXf = inner ? `<xf${attrs}>${inner}</xf>` : `<xf${attrs}/>`;
  xml = xml.replace(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/, (m, n, body) => `<cellXfs count="${Number(n) + 1}">${body}${newXf}</cellXfs>`);
  zip.file('xl/styles.xml', xml);
  return xfs.length;
}

// Make Excel recalculate every formula when the file is opened. Formula cells
// we write (or a template's pre-formatted formula rows) carry no cached
// value, and Excel shows them blank until something triggers a recalc —
// fullCalcOnLoad on the workbook's calcPr is that trigger.
export async function recalcOnOpen(zip) {
  const file = zip.file('xl/workbook.xml');
  if (!file) return;
  let xml = await file.async('string');
  if (/<calcPr\b[^>]*\bfullCalcOnLoad="1"/.test(xml)) return;
  xml = /<calcPr\b/.test(xml)
    ? xml.replace(/<calcPr\b([^>]*?)\s*\/?>/, (m, attrs) => `<calcPr${attrs.replace(/\s*fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`)
    : xml.replace(/<\/workbook>\s*$/, '<calcPr fullCalcOnLoad="1"/></workbook>');
  zip.file('xl/workbook.xml', xml);
}

// Inject prebuilt <row> XML before </sheetData> and bump the sheet dimension.
export function injectRows(sheetXml, rowsXml, lastRowNum) {
  let newXml = sheetXml.replace('</sheetData>', `${rowsXml}</sheetData>`);
  newXml = newXml.replace(/(<dimension ref="[A-Z]+1:[A-Z]+)\d+("\s*\/>)/, `$1${lastRowNum}$2`);
  return newXml;
}

const MIME_BY_EXT = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // Macro-enabled workbooks (Amazon templates). The macros survive untouched —
  // we edit worksheet XML in place — but the download must keep the .xlsm
  // extension and mime or Excel refuses to open it.
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
};

// File extension of the source template ("xlsx" unless it's macro-enabled).
export function templateExt(storagePath) {
  const m = String(storagePath).toLowerCase().match(/\.(xlsx|xlsm)$/);
  return m ? m[1] : 'xlsx';
}

// Serialize the zip and hand it to the browser as a download.
export async function downloadZip(zip, fileName, ext = 'xlsx') {
  const out = await zip.generateAsync({
    type: 'blob',
    mimeType: MIME_BY_EXT[ext] ?? MIME_BY_EXT.xlsx,
    compression: 'DEFLATE',
  });
  const url = URL.createObjectURL(out);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${fileName}_${new Date().toISOString().slice(0, 10)}.${ext}`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---- PIM media lookups shared by all exporters -------------------------------

export async function fetchImagesBySku(skus) {
  const bySku = {};
  for (let i = 0; i < skus.length; i += 40) {
    const { data } = await supabase
      .from('product_media')
      .select('sku, storage_path, is_primary, display_order, image_role')
      .in('sku', skus.slice(i, i + 40))
      .eq('media_type', 'image');
    for (const m of data ?? []) {
      // The gray-background SinksDirect hero never goes to other marketplaces.
      if (m.image_role === 'sinksdirect_main') continue;
      (bySku[m.sku] = bySku[m.sku] || []).push(m);
    }
  }
  for (const k in bySku) bySku[k].sort((a, b) => (b.is_primary - a.is_primary) || (a.display_order - b.display_order));
  return bySku;
}

// Video URLs per SKU, in display order. Only direct video files (uploaded to
// Storage or direct links) — page links (YouTube/Vimeo) aren't ingestible as
// marketplace video files.
const VIDEO_FILE_RE = /\.(mp4|webm|mov|m4v)(\?|#|$)|\/storage\/v1\/object\/public\//i;
export async function fetchVideosBySku(skus) {
  const bySku = {};
  for (let i = 0; i < skus.length; i += 40) {
    const { data } = await supabase
      .from('product_media')
      .select('sku, storage_path, display_order')
      .in('sku', skus.slice(i, i + 40))
      .eq('media_type', 'video');
    for (const m of data ?? []) {
      if (!VIDEO_FILE_RE.test(m.storage_path ?? '')) continue;
      (bySku[m.sku] = bySku[m.sku] || []).push(m);
    }
  }
  for (const k in bySku) bySku[k].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  return bySku;
}

// Documents per SKU. `typeMap` translates PIM document_type → marketplace label;
// `priority` orders them (first match wins the low slots).
export async function fetchDocsBySku(skus, typeMap, priority = []) {
  const bySku = {};
  for (let i = 0; i < skus.length; i += 40) {
    const { data } = await supabase
      .from('product_media')
      .select('sku, storage_path, document_type')
      .in('sku', skus.slice(i, i + 40))
      .eq('media_type', 'document');
    for (const m of data ?? []) {
      const mapped = typeMap[m.document_type];
      if (mapped) (bySku[m.sku] = bySku[m.sku] || []).push({ url: m.storage_path, type: mapped, raw: m.document_type });
    }
  }
  const rank = (t) => { const i = priority.indexOf(t); return i === -1 ? 99 : i; };
  for (const k in bySku) bySku[k].sort((a, b) => rank(a.raw) - rank(b.raw));
  return bySku;
}

// Column fill counts for the post-export readiness report. Exporters call
// hit(ci, value) wherever they write a cell, then attach report(labels, rows)
// to their result so the UI can list which columns came out empty or partial
// without the user opening the XLSX.
export function createFillTracker() {
  const filled = new Map();
  return {
    hit(ci, value) {
      if (value === '' || value == null) return;
      filled.set(ci, (filled.get(ci) ?? 0) + 1);
    },
    report(labels, rows) {
      const columns = [];
      for (let ci = 0; ci < labels.length; ci++) {
        const label = labels[ci];
        if (!label) continue;
        columns.push({ label: String(label).trim(), filled: filled.get(ci) ?? 0 });
      }
      return { rows, columns };
    },
  };
}
