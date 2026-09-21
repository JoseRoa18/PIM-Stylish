// Price2Spy "Matrix Report" reader (the daily usa-/canada-p2s-pricing-report
// xlsx). One row per product, one column per monitored site; each cell holds
// the last price seen and a HYPERLINK to the retailer's page. The cell colour
// carries Price2Spy's status legend:
//   DFDFDF  Inactive URL          — Price2Spy gave up on the page (gone)
//   F7FAAC  URL with zero price   — the page opens but shows no price
//   others  a price was captured  — the page opens
// Cells without a hyperlink are sites Price2Spy does not monitor for that SKU.
//
// Read with JSZip + DOMParser like the bulk import (no spreadsheet lib):
// sheet cells (value + style index), styles.xml (style → fill colour),
// the sheet's rels (hyperlink id → target URL).

const RELS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NOT_SITES = new Set(['product name', 'map', 'promo price', 'targeted price', 'sku', 'internal id', 'category', 'brand', 'supplier', 'my own price is...']);

const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const colIndex = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function sharedStrings(xml) {
  if (!xml) return [];
  const doc = parseXml(xml);
  const ns = doc.documentElement.namespaceURI;
  const out = [];
  const si = doc.getElementsByTagNameNS(ns, 'si');
  for (let i = 0; i < si.length; i++) {
    const t = si[i].getElementsByTagNameNS(ns, 't');
    let s = '';
    for (let j = 0; j < t.length; j++) s += t[j].textContent ?? '';
    out.push(s);
  }
  return out;
}

// style index → fill RGB (upper-case, no alpha), via cellXfs → fills.
function styleFills(xml) {
  if (!xml) return [];
  const doc = parseXml(xml);
  const ns = doc.documentElement.namespaceURI;
  const fills = [];
  const fillEls = doc.getElementsByTagNameNS(ns, 'fills')[0]?.getElementsByTagNameNS(ns, 'fill') ?? [];
  for (let i = 0; i < fillEls.length; i++) {
    const fg = fillEls[i].getElementsByTagNameNS(ns, 'fgColor')[0];
    const rgb = fg?.getAttribute('rgb') ?? '';
    fills.push(rgb ? rgb.slice(-6).toUpperCase() : null);
  }
  const xfs = doc.getElementsByTagNameNS(ns, 'cellXfs')[0]?.getElementsByTagNameNS(ns, 'xf') ?? [];
  const out = [];
  for (let i = 0; i < xfs.length; i++) out.push(fills[Number(xfs[i].getAttribute('fillId') ?? 0)] ?? null);
  return out;
}

async function firstSheet(zip) {
  const wb = zip.file('xl/workbook.xml');
  const rels = zip.file('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const wbDoc = parseXml(await wb.async('string'));
    const sheet = wbDoc.getElementsByTagNameNS(wbDoc.documentElement.namespaceURI, 'sheet')[0];
    const rId = sheet?.getAttributeNS(RELS_NS, 'id') || sheet?.getAttribute('r:id');
    const relDoc = parseXml(await rels.async('string'));
    const rs = relDoc.getElementsByTagName('Relationship');
    for (let i = 0; i < rs.length; i++) {
      if (rs[i].getAttribute('Id') === rId) {
        const t = rs[i].getAttribute('Target') ?? '';
        return t.startsWith('/') ? t.slice(1) : `xl/${t}`;
      }
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

/**
 * @param {File} file  the Price2Spy matrix report (.xlsx)
 * @returns {{ market: 'us'|'ca'|null, reportDate: string|null, sites: string[], rows: Array<{sku, site, url, price, status}> }}
 */
export async function parsePrice2SpyReport(file) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const ss = sharedStrings(zip.file('xl/sharedStrings.xml') ? await zip.file('xl/sharedStrings.xml').async('string') : null);
  const fillOfStyle = styleFills(zip.file('xl/styles.xml') ? await zip.file('xl/styles.xml').async('string') : null);
  const sheetPath = await firstSheet(zip);
  const sheetXml = await zip.file(sheetPath)?.async('string');
  if (!sheetXml) throw new Error('The file has no worksheet. Is this the Price2Spy matrix report (.xlsx)?');

  // Sheet rels: hyperlink r:id → URL
  const relsPath = sheetPath.replace(/worksheets\/([^/]+)$/, 'worksheets/_rels/$1.rels');
  const relTargets = {};
  const relsXml = await zip.file(relsPath)?.async('string');
  if (relsXml) {
    const rs = parseXml(relsXml).getElementsByTagName('Relationship');
    for (let i = 0; i < rs.length; i++) relTargets[rs[i].getAttribute('Id')] = rs[i].getAttribute('Target');
  }

  const doc = parseXml(sheetXml);
  const ns = doc.documentElement.namespaceURI;
  const linkOfRef = {};
  const hl = doc.getElementsByTagNameNS(ns, 'hyperlink');
  for (let i = 0; i < hl.length; i++) {
    const ref = hl[i].getAttribute('ref');
    const rId = hl[i].getAttributeNS(RELS_NS, 'id') || hl[i].getAttribute('r:id');
    const target = rId ? relTargets[rId] : hl[i].getAttribute('location');
    if (ref && target) linkOfRef[ref] = target;
  }

  const rowsEls = doc.getElementsByTagNameNS(ns, 'row');
  const grid = [];
  for (let r = 0; r < rowsEls.length; r++) {
    const cells = rowsEls[r].getElementsByTagNameNS(ns, 'c');
    const arr = [];
    for (let c = 0; c < cells.length; c++) {
      const el = cells[c];
      const ref = el.getAttribute('r') ?? '';
      const m = ref.match(/^([A-Z]+)(\d+)$/);
      if (!m) continue;
      const type = el.getAttribute('t') ?? '';
      let value;
      const v = el.getElementsByTagNameNS(ns, 'v')[0];
      if (type === 's') value = ss[Number(v?.textContent ?? -1)] ?? '';
      else if (type === 'inlineStr') value = el.getElementsByTagNameNS(ns, 't')[0]?.textContent ?? '';
      else value = v?.textContent ?? '';
      const style = Number(el.getAttribute('s') ?? -1);
      arr[colIndex(m[1])] = { value, fill: style >= 0 ? fillOfStyle[style] ?? null : null, link: linkOfRef[ref] ?? null };
    }
    grid.push(arr);
  }

  const headerIdx = grid.findIndex((row) => row.some((c) => c && String(c.value).trim().toLowerCase() === 'product name'));
  if (headerIdx === -1) throw new Error('Header row "Product name" not found. Is this the Price2Spy matrix report?');
  const headers = grid[headerIdx].map((c) => String(c?.value ?? '').trim());
  const siteCols = headers.map((h, i) => ({ h, i })).filter(({ h, i }) => i > 0 && h && !NOT_SITES.has(h.toLowerCase()));

  const rows = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const arr = grid[r];
    const sku = String(arr?.[0]?.value ?? '').trim();
    if (!sku) continue; // legend rows at the bottom have no product name
    for (const { h, i } of siteCols) {
      const cell = arr[i];
      if (!cell?.link) continue;
      const price = Number(cell.value);
      const fill = cell.fill;
      const status = fill === 'DFDFDF' ? 'inactive' : fill === 'F7FAAC' || (Number.isFinite(price) && price === 0) ? 'zero' : Number.isFinite(price) && price > 0 ? 'price' : 'unknown';
      rows.push({ sku, site: h, url: cell.link, price: Number.isFinite(price) ? price : null, status });
    }
  }

  const name = file.name ?? '';
  const market = /^canada/i.test(name) ? 'ca' : /^usa/i.test(name) ? 'us' : null;
  const reportDate = name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  return { market, reportDate, sites: siteCols.map((s) => s.h), rows };
}
