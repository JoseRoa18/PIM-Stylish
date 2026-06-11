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

async function findFirstSheetPath(zip) {
  const wbFile = zip.file('xl/workbook.xml');
  const relsFile = zip.file('xl/_rels/workbook.xml.rels');
  if (wbFile && relsFile) {
    const wbDoc = parseXml(await wbFile.async('string'));
    const wbNs = wbDoc.documentElement.namespaceURI;
    const sheets = wbDoc.getElementsByTagNameNS(wbNs, 'sheet');
    if (sheets.length > 0) {
      const rId =
        sheets[0].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ||
        sheets[0].getAttribute('r:id');
      const relsDoc = parseXml(await relsFile.async('string'));
      const rels = relsDoc.getElementsByTagName('Relationship');
      for (let i = 0; i < rels.length; i++) {
        if (rels[i].getAttribute('Id') === rId) {
          const target = rels[i].getAttribute('Target') ?? '';
          return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
        }
      }
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

async function parseXlsx(file) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const ssFile = zip.file('xl/sharedStrings.xml');
  const sharedStrings = parseSharedStrings(ssFile ? await ssFile.async('string') : null);

  const sheetPath = await findFirstSheetPath(zip);
  const sheetFile = zip.file(sheetPath);
  if (!sheetFile) throw new Error('Could not find a worksheet in the file.');

  const doc = parseXml(await sheetFile.async('string'));
  const ns = doc.documentElement.namespaceURI;
  const rowEls = doc.getElementsByTagNameNS(ns, 'row');

  // Materialize each row as a sparse array indexed by column
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
    grid.push(rowArr);
  }

  // First row with content = headers
  const headerIdx = grid.findIndex((row) => row.some((v) => String(v ?? '').trim() !== ''));
  if (headerIdx === -1) throw new Error('The file appears to be empty.');

  const headers = grid[headerIdx].map((h) => String(h ?? '').trim());
  const rows = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const arr = grid[r];
    if (!arr || !arr.some((v) => String(v ?? '').trim() !== '')) continue; // skip blank rows
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = String(arr[i] ?? '').trim();
    });
    rows.push(obj);
  }

  return { headers: headers.filter(Boolean), rows };
}

function parseCsvText(text) {
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

function parseCsv(text) {
  const grid = parseCsvText(text).filter((r) => r.some((v) => v.trim() !== ''));
  if (grid.length === 0) throw new Error('The file appears to be empty.');

  const headers = grid[0].map((h) => h.trim());
  const rows = grid.slice(1).map((arr) => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = (arr[i] ?? '').trim();
    });
    return obj;
  });
  return { headers: headers.filter(Boolean), rows };
}

export async function parseSpreadsheetFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) return parseCsv(await file.text());
  if (name.endsWith('.xlsx')) return parseXlsx(file);
  throw new Error('Unsupported file type — upload a .xlsx or .csv file.');
}
