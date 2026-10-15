// The PIM's own Excel (user, 2026-10-15: "seccionalo"): the bulk-upload
// template and the PIM export, one sheet per category. Row 1 is a colored
// band per section (Identity, Pricing, Shipping…), row 2 the column headers
// on the section's light tint, data from row 3. The two header rows and the
// SKU column stay frozen, and row 2 carries the filter. Built straight as
// OOXML with JSZip (loaded on demand) — no spreadsheet library.
//
// sheets: [{ name, sections: [{ title, color, headers }], rows: [[value…]] }]
// A row lists its values in the sections' column order; a number is written
// as a number, anything else as text, '' / null as an empty cell.

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

function stylesXml(colors) {
  // fills 0/1 are Excel's reserved none / gray125; then dark + light per section
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  for (const c of colors) {
    fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`);
    fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${tint(c)}"/><bgColor indexed="64"/></patternFill></fill>`);
  }
  // xf 0 default, 1 data cell (thin light border, top aligned); per section
  // 2 + 2i the band, 3 + 2i the header
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>',
  ];
  colors.forEach((_, i) => {
    xfs.push(`<xf numFmtId="0" fontId="1" fillId="${2 + 2 * i}" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" indent="1"/></xf>`);
    xfs.push(`<xf numFmtId="0" fontId="2" fillId="${3 + 2 * i}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3">
<font><sz val="10"/><color rgb="FF1F1F1F"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="9"/><color rgb="FF1F1F1F"/><name val="Arial"/><family val="2"/></font>
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

function sheetXml(sheet, styleOf) {
  const headers = sheet.sections.flatMap((s) => s.headers);
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
    const cells = headers.map((_, c) => cellXml(`${colLetter(c)}${n}`, values[c], 1)).join('');
    return `<row r="${n}">${cells}</row>`;
  });
  const sample = sheet.rows.slice(0, 200);
  const cols = headers.map((h, i) => `<col min="${i + 1}" max="${i + 1}" width="${columnWidth(h, sample.map((r) => r[i]))}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
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
<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

/** The workbook as a Blob (.xlsx). */
export async function buildSectionedWorkbook(sheets) {
  if (!sheets.length) throw new Error('Nothing to write.');
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  // parts only, no folder entries (the files Excel itself writes have none)
  const put = (name, data) => zip.file(name, data, { createFolders: false });
  const names = sheetNames(sheets.map((s) => s.name));

  // one style pair per distinct section color
  const colors = [...new Set(sheets.flatMap((s) => s.sections.map((x) => x.color)))];
  const styleOf = (section) => {
    const i = colors.indexOf(section.color);
    return { bandStyle: 2 + 2 * i, headerStyle: 3 + 2 * i };
  };

  sheets.forEach((sheet, i) => put(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet, styleOf)));
  put('xl/styles.xml', stylesXml(colors));
  const filterNames = sheets.map((sheet, i) => {
    const count = sheet.sections.reduce((n, s) => n + s.headers.length, 0);
    const lastRow = Math.max(2, sheet.rows.length + 2);
    // "Bar & Prep Sinks": the reference is XML text too, so its & must be escaped
    const ref = `'${names[i].replace(/'/g, "''")}'!$A$2:$${colLetter(Math.max(0, count - 1))}$${lastRow}`;
    return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(ref)}</definedName>`;
  });
  put('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView activeTab="0"/></bookViews>
<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${filterNames.join('')}</definedNames>
</workbook>`);
  put('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
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
${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE' });
}
