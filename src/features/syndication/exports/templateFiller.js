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

export function buildCell(ref, value) {
  if (value === '' || value == null) return '';
  if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
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
      return 'xl/' + target.replace(/^\//, '');
    }
  }
  return null;
}

// All worksheet names, in workbook order.
export function listSheetNames(workbookXml) {
  return [...workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((m) => m[1]);
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
      .select('sku, storage_path, is_primary, display_order')
      .in('sku', skus.slice(i, i + 40))
      .eq('media_type', 'image');
    for (const m of data ?? []) (bySku[m.sku] = bySku[m.sku] || []).push(m);
  }
  for (const k in bySku) bySku[k].sort((a, b) => (b.is_primary - a.is_primary) || (a.display_order - b.display_order));
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
