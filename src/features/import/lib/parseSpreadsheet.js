/**
 * Spreadsheet parsing for the bulk import. Supports .xlsx (read via JSZip +
 * DOMParser, no heavy spreadsheet lib) and .csv (RFC-4180-ish state machine).
 *
 * Both return: { headers: string[], rows: Array<Record<header, string>> }
 * Values come back as raw strings — coercion happens in buildImportRows.
 */

function parseXml(xmlString) {
  return new DOMParser().parseFromString(xmlString, 'application/xml');
}

function colLetterToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1; // 0-based
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const doc = parseXml(xml);
  const ns = doc.documentElement.namespaceURI;
  const out = [];
  const siEls = doc.getElementsByTagNameNS(ns, 'si');
  for (let i = 0; i < siEls.length; i++) {
    const tEls = siEls[i].getElementsByTagNameNS(ns, 't');
    let text = '';
    for (let j = 0; j < tEls.length; j++) text += tEls[j].textContent ?? '';
    out.push(text);
  }
  return out;
}

function getCellValue(cellEl, ns, sharedStrings) {
  const type = cellEl.getAttribute('t') ?? '';
  if (type === 's') {
    const v = cellEl.getElementsByTagNameNS(ns, 'v')[0];
    return v ? (sharedStrings[parseInt(v.textContent)] ?? '') : '';
  }
  if (type === 'inlineStr') {
    const isEl = cellEl.getElementsByTagNameNS(ns, 'is')[0];
    if (!isEl) return '';
    const tEls = isEl.getElementsByTagNameNS(ns, 't');
    let text = '';
    for (let i = 0; i < tEls.length; i++) text += tEls[i].textContent ?? '';
    return text;
  }
  const v = cellEl.getElementsByTagNameNS(ns, 'v')[0];
  return v ? (v.textContent ?? '') : '';
}

// The workbook's sheets in tab order: [{ name, path }].
async function listSheets(zip) {
  const wbFile = zip.file('xl/workbook.xml');
  const relsFile = zip.file('xl/_rels/workbook.xml.rels');
  const out = [];
  if (wbFile && relsFile) {
    const wbDoc = parseXml(await wbFile.async('string'));
    const wbNs = wbDoc.documentElement.namespaceURI;
    const sheets = wbDoc.getElementsByTagNameNS(wbNs, 'sheet');
    const relsDoc = parseXml(await relsFile.async('string'));
    const rels = relsDoc.getElementsByTagName('Relationship');
    for (let s = 0; s < sheets.length; s++) {
      const rId =
        sheets[s].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ||
        sheets[s].getAttribute('r:id');
      for (let i = 0; i < rels.length; i++) {
        if (rels[i].getAttribute('Id') === rId) {
          const target = rels[i].getAttribute('Target') ?? '';
          out.push({ name: sheets[s].getAttribute('name') ?? `Sheet${s + 1}`, path: target.startsWith('/') ? target.slice(1) : `xl/${target}` });
        }
      }
    }
  }
  return out.length ? out : [{ name: 'Sheet1', path: 'xl/worksheets/sheet1.xml' }];
}

// Materialize a sheet as rows of sparse arrays indexed by column; each row
// keeps its sheet row number.
function sheetGrid(xml, sharedStrings) {
  const doc = parseXml(xml);
  const ns = doc.documentElement.namespaceURI;
  const rowEls = doc.getElementsByTagNameNS(ns, 'row');
  const grid = [];
  for (let r = 0; r < rowEls.length; r++) {
    const cells = rowEls[r].getElementsByTagNameNS(ns, 'c');
    const rowArr = [];
    for (let c = 0; c < cells.length; c++) {
      const ref = cells[c].getAttribute('r') ?? '';
      const m = ref.match(/^([A-Z]+)/);
      if (!m) continue;
      rowArr[colLetterToIndex(m[1])] = getCellValue(cells[c], ns, sharedStrings);
    }
    rowArr.rowNumber = Number(rowEls[r].getAttribute('r')) || r + 1;
    grid.push(rowArr);
  }
  return grid;
}

const filled = (row) => row && Array.from(row, (v) => String(v ?? '').trim()).some(Boolean);

// The header row: the first row with content — or, with a scorer, the best
// scoring of the first ten rows with content (the PIM's own Excel carries a
// section band above its headers).
function headerIndex(grid, scoreHeader) {
  const candidates = [];
  for (let r = 0; r < grid.length && candidates.length < 10; r++) if (filled(grid[r])) candidates.push(r);
  if (!candidates.length) return { index: -1, score: 0 };
  if (!scoreHeader) return { index: candidates[0], score: 1 };
  let best = { index: candidates[0], score: -1 };
  for (const r of candidates) {
    const score = scoreHeader(Array.from(grid[r], (v) => String(v ?? '').trim()));
    if (score > best.score) best = { index: r, score };
  }
  return best;
}

// Rows under the header row as objects keyed by header; each knows its sheet
// row (__row) and sheet (__sheet).
function rowsBelow(grid, index, sheetName) {
  const headers = Array.from(grid[index], (h) => String(h ?? '').trim());
  const rows = [];
  for (let r = index + 1; r < grid.length; r++) {
    const arr = grid[r];
    if (!filled(arr)) continue; // skip blank rows
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = String(arr[i] ?? '').trim();
    });
    Object.defineProperty(obj, '__row', { value: arr.rowNumber ?? r + 1, enumerable: false });
    if (sheetName) Object.defineProperty(obj, '__sheet', { value: sheetName, enumerable: false });
    rows.push(obj);
  }
  return { headers: headers.filter(Boolean), rows };
}

async function parseXlsx(file, { scoreHeader = null, allSheets = false } = {}) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const ssFile = zip.file('xl/sharedStrings.xml');
  const sharedStrings = parseSharedStrings(ssFile ? await ssFile.async('string') : null);

  const sheets = await listSheets(zip);
  const wanted = allSheets ? sheets : sheets.slice(0, 1);
  const headers = [];
  const rows = [];
  for (const sheet of wanted) {
    const sheetFile = zip.file(sheet.path);
    if (!sheetFile) continue;
    const grid = sheetGrid(await sheetFile.async('string'), sharedStrings);
    const { index, score } = headerIndex(grid, scoreHeader);
    // with every sheet read, one that names no known column (a notes tab) is skipped
    if (index === -1 || (allSheets && scoreHeader && score < 2)) continue;
    const part = rowsBelow(grid, index, allSheets ? sheet.name : null);
    for (const h of part.headers) if (!headers.includes(h)) headers.push(h);
    rows.push(...part.rows);
  }
  if (!headers.length) throw new Error(allSheets ? 'No sheet in the file has the template columns.' : 'The file appears to be empty.');
  return { headers, rows, sheets: wanted.length };
}

// Exported: promo file fillers need the raw grid (their header row isn't
// row 1 — portal files carry instruction rows above it).
export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseCsv(text, { scoreHeader = null } = {}) {
  const grid = parseCsvText(text).map((arr, i) => Object.assign(arr, { rowNumber: i + 1 }));
  const { index } = headerIndex(grid, scoreHeader);
  if (index === -1) throw new Error('The file appears to be empty.');
  return { ...rowsBelow(grid, index, null), sheets: 1 };
}

/**
 * Options (the bulk import uses both; the promo files use neither):
 *   scoreHeader(cells) → how much a row looks like the header row; the best of
 *     the first ten rows with content wins (else the first one).
 *   allSheets — read every sheet of an .xlsx (a sheet that scores under 2 is
 *     skipped); rows then carry their sheet name.
 */
export async function parseSpreadsheetFile(file, options = {}) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) return parseCsv(await file.text(), options);
  if (name.endsWith('.xlsx')) return parseXlsx(file, options);
  throw new Error('Unsupported file type — upload a .xlsx or .csv file.');
}
