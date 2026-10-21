// The PIM's own Excel (user, 2026-10-15: "seccionalo"): the bulk-upload
// template and the PIM export, one sheet per category. Row 1 is a colored
// band per section (Identity, Pricing, Shipping…), row 2 the column headers
// on the section's light tint, data from row 3. The two header rows and the
// SKU column stay frozen, and row 2 carries the filter. Built straight as
// OOXML with JSZip (loaded on demand) — no spreadsheet library.
//
// sheets: [{ name, kind?, sections: [{ title, color, headers }], rows: [[value…]], formats? }]
// A row lists its values in the sections' column order; a number is written
// as a number, anything else as text, '' / null as an empty cell. `formats`
// (optional, one per column) shows a column as 'money' (#,##0.00), 'percent'
// (a fraction shown 0%) or 'link' (a clickable URL).
//
// `widths` (optional, one per column, null = by its content) sets column
// widths; `emptyText` (column indexes) writes an empty cell there as empty
// text, so a long value in the cell to its left does not spill over it.
// `cellColor(values, column)` (optional) colors single cells: it returns
// { fill: 'E6F4EA', bold? } (or a bare hex) for a cell to tint, else null —
// the Where to Buy export tints each link's status and the column to fill in.
//
// A sheet with `blocks` instead is a report page (the full PIM report's
// Summary and Notes): { name, title, subtitle, widths: [B, C…], blocks: [{
// title, note?, headers, rows, total?, formats: ['text' | 'center' | 'count' |
// 'percent' | 'wrap' | 'topic'…], rowFormats?: { [row index]: formats } }] }
// — stacked tables from column B.

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 refuses most control characters (a stray \u0002 in a description)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

export const colLetter = (index) => {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

// The header row's fill: the band color mixed 82% toward white.
const tint = (hex, amount = 0.82) => {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return c.map((v) => Math.round(v + (255 - v) * amount).toString(16).padStart(2, '0')).join('').toUpperCase();
};

// A sheet name Excel accepts: ≤ 31 characters, none of []:*?/\ , unique.
function sheetNames(names) {
  const used = new Set();
  return names.map((raw) => {
    const base = String(raw || 'Sheet').replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
    used.add(name.toLowerCase());
    return name;
  });
}

// Wide columns for long text; the others fit their header (wrapped on two
// lines) and their longest value, within bounds.
const LONG = /description|bullet|marketing|keywords|warranty text|product care|title/i;
const columnWidth = (header, values) => {
  if (LONG.test(header)) return 48;
  const longest = values.reduce((m, v) => Math.max(m, v == null ? 0 : String(v).length), 0);
  // two lines of header, and never a word split ("Manufacturer")
  const longestWord = Math.max(...String(header).split(/\s+/).map((w) => w.length));
  const fromHeader = Math.max(Math.ceil(String(header).length / 2), longestWord) + 3;
  return Math.min(36, Math.max(11, fromHeader, Math.round(longest * 1.05) + 2));
};

// The styles past the per-section pairs, by name: data formats, links and the
// report pages' title, tables and totals. Their index is 2 + 2 × colors + the
// position here. Fonts: 3 link, 4 title, 5 gray, 6 block title, 7 bold,
// 8 white bold 10, 9 gray italic; fills `navy` and `total` follow the
// sections' fills.
const EXTRA_STYLES = [
  ['money', () => '<xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>'],
  ['percent', () => '<xf numFmtId="9" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>'],
  ['link', () => '<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>'],
  ['title', () => '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>'],
  ['subtitle', () => '<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/>'],
  ['blockTitle', () => '<xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1"/>'],
  ['blockNote', () => '<xf numFmtId="0" fontId="9" fillId="0" borderId="0" xfId="0" applyFont="1"/>'],
  ['blockHead', (f) => `<xf numFmtId="0" fontId="8" fillId="${f.navy}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`],
  ['blockHeadLeft', (f) => `<xf numFmtId="0" fontId="8" fillId="${f.navy}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>`],
  ['text', () => '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>'],
  ['center', () => '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>'],
  ['count', () => '<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>'],
  ['percentCenter', () => '<xf numFmtId="9" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>'],
  ['wrap', () => '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'],
  ['topic', () => '<xf numFmtId="0" fontId="7" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>'],
  ['totalText', (f) => `<xf numFmtId="0" fontId="7" fillId="${f.total}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>`],
  ['totalCount', (f) => `<xf numFmtId="3" fontId="7" fillId="${f.total}" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>`],
  ['totalPercent', (f) => `<xf numFmtId="9" fontId="7" fillId="${f.total}" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>`],
];
const extraStyle = (colors, name) => 2 + 2 * colors.length + EXTRA_STYLES.findIndex(([n]) => n === name);

// A tinted data cell's key ("E6F4EA|b" = that fill, bold), from cellColor's answer.
const cellKey = (c) => {
  if (!c) return null;
  const fill = typeof c === 'string' ? c : c.fill;
  return fill ? `${String(fill).toUpperCase()}|${typeof c === 'object' && c.bold ? 'b' : ''}` : null;
};

// `cellKeys`: the tinted cells' styles, after EXTRA_STYLES (one fill each).
function stylesXml(colors, cellKeys = []) {
  // fills 0/1 are Excel's reserved none / gray125; then dark + light per
  // section, then the report tables' header and total fills, then the tinted cells'
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  for (const c of colors) {
    fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`);
    fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${tint(c)}"/><bgColor indexed="64"/></patternFill></fill>`);
  }
  const fixedFills = { navy: fills.length, total: fills.length + 1 };
  fills.push('<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>');
  fills.push('<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill>');
  // xf 0 default, 1 data cell (thin light border, top aligned); per section
  // 2 + 2i the band, 3 + 2i the header; then EXTRA_STYLES
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>',
  ];
  colors.forEach((_, i) => {
    xfs.push(`<xf numFmtId="0" fontId="1" fillId="${2 + 2 * i}" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" indent="1"/></xf>`);
    xfs.push(`<xf numFmtId="0" fontId="2" fillId="${3 + 2 * i}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>`);
  });
  for (const [, xf] of EXTRA_STYLES) xfs.push(xf(fixedFills));
  for (const key of cellKeys) {
    const [fill, bold] = key.split('|');
    xfs.push(`<xf numFmtId="0" fontId="${bold ? 7 : 0}" fillId="${fills.length}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>`);
    fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${fill}"/><bgColor indexed="64"/></patternFill></fill>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="10">
<font><sz val="10"/><color rgb="FF1F1F1F"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="9"/><color rgb="FF1F1F1F"/><name val="Arial"/><family val="2"/></font>
<font><u/><sz val="10"/><color rgb="FF0B57D0"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="18"/><color rgb="FF1F3864"/><name val="Arial"/><family val="2"/></font>
<font><sz val="10"/><color rgb="FF595959"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="12"/><color rgb="FF1F3864"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="10"/><color rgb="FF1F1F1F"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/><family val="2"/></font>
<font><i/><sz val="10"/><color rgb="FF595959"/><name val="Arial"/><family val="2"/></font>
</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right><top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border>
<border><left style="medium"><color rgb="FFFFFFFF"/></left><right/><top/><bottom/><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function cellXml(ref, value, style) {
  const s = style ? ` s="${style}"` : '';
  if (value === '' || value == null) return style ? `<c r="${ref}"${s}/>` : '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

// validations: [{ rule, cols: [index…] }] on those columns, from row 3 to
// `untilRow`. A rule is a dropdown ({ type: 'list', name } — the defined name
// of its list), a number ('decimal' / 'whole', zero or more) or a length
// ('textLength', min–max). Each one only warns: like the product page, a value
// off the list can be kept.
// A strict rule (`strict: true`) refuses the value; the others warn and let
// it be kept. `anchor` is the rule's first cell (a custom formula is written
// for it and Excel shifts it for the others).
const VALIDATION = {
  list: (r) => ({ attrs: 'type="list"', formulas: `<formula1>${r.name}</formula1>`, title: 'Not on the list', error: r.strict ? "Pick a value from the PIM's list." : "This value is not on the PIM's list. Keep it anyway?" }),
  decimal: (r) => ({ attrs: 'type="decimal" operator="greaterThanOrEqual"', formulas: '<formula1>0</formula1>', title: 'Numbers only', error: r.strict ? 'Numbers only — no letters, units or symbols.' : 'Enter a number only (no units or text). Keep it anyway?' }),
  whole: (r) => ({ attrs: 'type="whole" operator="greaterThanOrEqual"', formulas: '<formula1>0</formula1>', title: 'Whole numbers only', error: r.strict ? 'A whole number only — no letters or symbols.' : 'Enter a whole number. Keep it anyway?' }),
  textLength: (r) => ({ attrs: 'type="textLength" operator="between"', formulas: `<formula1>${r.min}</formula1><formula2>${r.max}</formula2>`, title: 'Check the length', error: `This should have ${r.min} to ${r.max} characters.` }),
  // digits only, min–max of them (a UPC)
  upc: (r, anchor) => ({
    attrs: 'type="custom"',
    formulas: `<formula1>${esc(`AND(ISNUMBER(--${anchor}),ISERROR(FIND(".",${anchor})),LEN(${anchor})>=${r.min},LEN(${anchor})<=${r.max})`)}</formula1>`,
    title: 'Digits only',
    error: `A UPC is ${r.min} to ${r.max} digits — no letters, spaces or symbols.`,
  }),
};
function validationsXml(validations, untilRow) {
  if (!validations.length) return '';
  const items = validations.map(({ rule, cols }) => {
    const sqref = cols.map((c) => `${colLetter(c)}3:${colLetter(c)}${untilRow}`).join(' ');
    const v = VALIDATION[rule.type](rule, `${colLetter(cols[0])}3`);
    return `<dataValidation ${v.attrs} errorStyle="${rule.strict ? 'stop' : 'warning'}" allowBlank="1" showErrorMessage="1" errorTitle="${esc(v.title)}" error="${esc(v.error)}" sqref="${sqref}">${v.formulas}</dataValidation>`;
  });
  return `<dataValidations count="${items.length}">${items.join('')}</dataValidations>`;
}

// A column's data style: its format's, else the plain data cell.
const formatStyles = (sheet, colors) => (sheet.formats ?? []).map((f) => (f ? extraStyle(colors, f) : 1));

function sheetXml(sheet, styleOf, validations = [], colors = [], cellStyle = () => null) {
  const headers = sheet.sections.flatMap((s) => s.headers);
  const styles = formatStyles(sheet, colors);
  const links = []; // { ref, url } — written as the sheet's hyperlinks
  const last = colLetter(Math.max(0, headers.length - 1));
  const lastRow = Math.max(2, sheet.rows.length + 2);
  const band = [];
  const head = [];
  const merges = [];
  let col = 0;
  sheet.sections.forEach((s) => {
    const { bandStyle, headerStyle } = styleOf(s);
    s.headers.forEach((h, i) => {
      const ref = colLetter(col + i);
      band.push(cellXml(`${ref}1`, i === 0 ? s.title : '', bandStyle));
      head.push(cellXml(`${ref}2`, h, headerStyle));
    });
    if (s.headers.length > 1) merges.push(`${colLetter(col)}1:${colLetter(col + s.headers.length - 1)}1`);
    col += s.headers.length;
  });
  const rows = sheet.rows.map((values, r) => {
    const n = r + 3;
    const cells = headers.map((_, c) => {
      const ref = `${colLetter(c)}${n}`;
      if (sheet.formats?.[c] === 'link' && /^https?:\/\//i.test(String(values[c] ?? ''))) links.push({ ref, url: String(values[c]) });
      const style = cellStyle(values, c) ?? styles[c] ?? 1;
      // an empty text in a column to fill in: the long link left of it stays in its own cell
      if (sheet.emptyText?.includes(c) && (values[c] === '' || values[c] == null)) return `<c r="${ref}" s="${style}" t="inlineStr"><is><t></t></is></c>`;
      return cellXml(ref, values[c], style);
    }).join('');
    return `<row r="${n}">${cells}</row>`;
  });
  const sample = sheet.rows.slice(0, 200);
  const cols = headers.map((h, i) => `<col min="${i + 1}" max="${i + 1}" width="${sheet.widths?.[i] ?? columnWidth(h, sample.map((r) => r[i]))}" customWidth="1"/>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${last}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0" zoomScale="90" zoomScaleNormal="90"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/><selection pane="topRight" activeCell="B1" sqref="B1"/><selection pane="bottomLeft" activeCell="A3" sqref="A3"/><selection pane="bottomRight" activeCell="B3" sqref="B3"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>
<row r="1" ht="24" customHeight="1">${band.join('')}</row>
<row r="2" ht="42" customHeight="1">${head.join('')}</row>
${rows.join('\n')}
</sheetData>
<autoFilter ref="A2:${last}${lastRow}"/>
${merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}
${validationsXml(validations, Math.max(1000, sheet.rows.length + 500))}
${links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rIdL${i + 1}"/>`).join('')}</hyperlinks>` : ''}
<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
  return { xml, links };
}

// A sheet's external links, one relationship each.
const linksRelsXml = (links) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${links.map((l, i) => `<Relationship Id="rIdL${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(l.url)}" TargetMode="External"/>`).join('\n')}
</Relationships>`;

// A report page: title and subtitle, then each block's title, note, header
// row, rows and total, one blank row apart — from column B, no gridlines.
const BLOCK_STYLE = { text: 'text', center: 'center', count: 'count', percent: 'percentCenter', wrap: 'wrap', topic: 'topic' };
const TOTAL_STYLE = { count: 'totalCount', percent: 'totalPercent' };
function reportSheetXml(sheet, colors) {
  const st = (name) => extraStyle(colors, name);
  const rows = [];
  let r = 1;
  // the next row: its values from column B, each with its style name
  const line = (values, styleOf, height) => {
    r += 1;
    const cells = values.map((v, c) => cellXml(`${colLetter(c + 1)}${r}`, v, st(styleOf(c))));
    rows.push(`<row r="${r}"${height ? ` ht="${height}" customHeight="1"` : ''}>${cells.join('')}</row>`);
  };
  line([sheet.title ?? ''], () => 'title', 26);
  if (sheet.subtitle) line([sheet.subtitle], () => 'subtitle');
  for (const block of sheet.blocks) {
    r += 1; // a blank row before each block
    if (block.title) line([block.title], () => 'blockTitle', 18);
    if (block.note) line([block.note], () => 'blockNote');
    line(block.headers, (c) => (c ? 'blockHead' : 'blockHeadLeft'), 30);
    block.rows.forEach((values, i) => {
      const formats = block.rowFormats?.[i] ?? block.formats;
      line(values, (c) => BLOCK_STYLE[formats?.[c]] ?? 'text');
    });
    if (block.total) line(block.total, (c) => TOTAL_STYLE[block.formats?.[c]] ?? 'totalText');
  }
  const cols = ['<col min="1" max="1" width="2" customWidth="1"/>',
    ...(sheet.widths ?? []).map((w, i) => `<col min="${i + 2}" max="${i + 2}" width="${w}" customWidth="1"/>`)].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>
${rows.join('\n')}
</sheetData>
<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

// The hidden sheet that holds the dropdowns' lists, one per column.
function listsSheetXml(lists) {
  const height = Math.max(...lists.map((l) => l.values.length)) + 1;
  const rows = [];
  for (let r = 0; r < height; r++) {
    // a list of numbers holds numbers, so a typed 2 matches its "2"
    const cell = (l) => {
      const v = l.values[r - 1] ?? '';
      return /^\d+(\.\d+)?$/.test(String(v)) ? Number(v) : v;
    };
    const cells = lists.map((l, c) => cellXml(`${colLetter(c)}${r + 1}`, r === 0 ? `List ${c + 1}` : cell(l), 0)).join('');
    rows.push(`<row r="${r + 1}">${cells}</row>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetData>${rows.join('')}</sheetData>
</worksheet>`;
}
const LISTS_SHEET = 'PIM Lists';

/**
 * The workbook as a Blob (.xlsx), its sheets in the given order (report pages
 * included). `validationFor(header, kind)` → what a
 * column checks from row 3, or null: { type: 'list', values } (a dropdown,
 * its list on a hidden "PIM Lists" sheet), { type: 'decimal' | 'whole' } or
 * { type: 'textLength', min, max } (user, 2026-10-15).
 */
export async function buildSectionedWorkbook(sheets, { validationFor = null } = {}) {
  if (!sheets.length) throw new Error('Nothing to write.');
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  // parts only, no folder entries (the files Excel itself writes have none)
  const put = (name, data) => zip.file(name, data, { createFolders: false });
  const names = sheetNames(sheets.map((s) => s.name));

  // one style pair per distinct section color
  const colors = [...new Set(sheets.flatMap((s) => (s.sections ?? []).map((x) => x.color)))];
  const styleOf = (section) => {
    const i = colors.indexOf(section.color);
    return { bandStyle: 2 + 2 * i, headerStyle: 3 + 2 * i };
  };

  // the distinct lists, and per sheet which columns take which rule
  const lists = [];
  const listIndex = new Map(); // JSON of the values → index
  const perSheet = sheets.map((sheet) => {
    const byRule = new Map(); // rule key → { rule, cols }
    (sheet.sections ?? []).flatMap((s) => s.headers).forEach((h, c) => {
      let rule = validationFor?.(h, sheet.kind);
      if (!rule || (rule.type === 'list' && !rule.values?.length)) return;
      if (rule.type === 'list') {
        const key = JSON.stringify(rule.values);
        if (!listIndex.has(key)) {
          listIndex.set(key, lists.length);
          lists.push({ name: `PIM_List_${lists.length + 1}`, values: rule.values });
        }
        rule = { type: 'list', name: lists[listIndex.get(key)].name, strict: Boolean(rule.strict) };
      }
      const key = JSON.stringify(rule);
      if (!byRule.has(key)) byRule.set(key, { rule, cols: [] });
      byRule.get(key).cols.push(c);
    });
    return [...byRule.values()];
  });

  // the tinted cells' distinct styles (cellColor), after the named ones
  const cellKeys = [...new Set(sheets.filter((s) => s.cellColor && !s.blocks).flatMap((s) => {
    const width = s.sections.reduce((n, x) => n + x.headers.length, 0);
    return s.rows.flatMap((values) => Array.from({ length: width }, (_, c) => cellKey(s.cellColor(values, c)))).filter(Boolean);
  }))];
  const cellBase = 2 + 2 * colors.length + EXTRA_STYLES.length;
  const cellStyleOf = (sheet) => (sheet.cellColor
    ? (values, c) => { const k = cellKey(sheet.cellColor(values, c)); return k ? cellBase + cellKeys.indexOf(k) : null; }
    : () => null);

  sheets.forEach((sheet, i) => {
    if (sheet.blocks) return put(`xl/worksheets/sheet${i + 1}.xml`, reportSheetXml(sheet, colors));
    const { xml, links } = sheetXml(sheet, styleOf, perSheet[i], colors, cellStyleOf(sheet));
    put(`xl/worksheets/sheet${i + 1}.xml`, xml);
    if (links.length) put(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, linksRelsXml(links));
  });
  const allNames = lists.length ? [...names, LISTS_SHEET] : names;
  if (lists.length) put(`xl/worksheets/sheet${allNames.length}.xml`, listsSheetXml(lists));
  put('xl/styles.xml', stylesXml(colors, cellKeys));
  const filterNames = sheets.flatMap((sheet, i) => {
    if (sheet.blocks) return []; // a report page has no filter
    const count = sheet.sections.reduce((n, s) => n + s.headers.length, 0);
    const lastRow = Math.max(2, sheet.rows.length + 2);
    // "Bar & Prep Sinks": the reference is XML text too, so its & must be escaped
    const ref = `'${names[i].replace(/'/g, "''")}'!$A$2:$${colLetter(Math.max(0, count - 1))}$${lastRow}`;
    return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(ref)}</definedName>`;
  });
  const listNames = lists.map((l, c) => `<definedName name="${l.name}">'${LISTS_SHEET}'!$${colLetter(c)}$2:$${colLetter(c)}$${l.values.length + 1}</definedName>`);
  put('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView activeTab="0"/></bookViews>
<sheets>${allNames.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}"${i >= names.length ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${[...filterNames, ...listNames].join('')}</definedNames>
</workbook>`);
  put('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${allNames.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${allNames.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  put('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  put('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${allNames.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE' });
}
