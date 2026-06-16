import { supabase } from '@/lib/supabase';
import { getMediaUrl } from '@/features/media/api/media';

// JSZip loads on demand — it's only needed when the user actually exports,
// so it stays out of the page bundles.
async function loadJSZip() {
  const mod = await import('jszip');
  return mod.default;
}

// ===================== PIM → BB&B field mapping =====================

const COUNTRY_MAP = {
  'China': 'CN - China', 'Canada': 'CA - Canada', 'USA': 'US - United States',
  'United States': 'US - United States', 'Mexico': 'MX - Mexico',
  'Taiwan': 'TW - Taiwan', 'India': 'IN - India', 'Vietnam': 'VN - Vietnam',
  'Italy': 'IT - Italy',
};

function stripHtml(html) {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

function sinkWidthBucket(l) {
  if (l == null) return '';
  if (l < 20) return 'Less than 20 Inch';
  if (l <= 31) return '20 - 31 Inch';
  if (l <= 33) return '31 - 33 Inch';
  return 'Over 33 Inch';
}

function basinDepthBucket(d) {
  if (d == null) return '';
  if (d < 5) return 'Less than 5 Inch';
  if (d <= 11) return '5 - 11 Inch';
  if (d <= 17) return '12 - 17 Inch';
  if (d <= 24) return '18 - 24 Inch';
  return 'More than 24 Inch';
}

function bowlDepthBucket(d) {
  if (d == null) return '';
  if (d <= 7) return 'Up to 7 inches';
  if (d <= 8) return '7.1 to 8 inches';
  if (d <= 9) return '8.1 to 9 inches';
  return '9 inches or More';
}

function mapInstallation(t) {
  if (!t) return '';
  const l = t.toLowerCase();
  if (l.includes('undermount')) return 'Undermount';
  if (l.includes('drop')) return 'Drop-in';
  if (l.includes('farmhouse') || l.includes('apron')) return 'Farmhouse and Apron';
  if (l.includes('dual')) return 'Dual';
  return t;
}

function mapShape(s) {
  if (!s) return 'Rectangle';
  const l = s.toLowerCase();
  if (l.includes('rect')) return 'Rectangle';
  if (l.includes('square')) return 'Square';
  if (l.includes('round') || l.includes('circ')) return 'Round';
  if (l.includes('oval')) return 'Oval';
  // Unknown shape → safe default that matches the BB&B dropdown.
  return 'Rectangle';
}

function mapBasins(n) {
  if (n === 1) return 'Single Basin';
  if (n === 2) return 'Double Basin';
  if (n === 3) return 'Triple Basin';
  return 'N/A';
}

function mapDrain(loc) {
  if (!loc) return '';
  const l = loc.toLowerCase();
  if (l.includes('side') || l.includes('reversible')) return 'Right Center';
  if (l.includes('center') && l.includes('right')) return 'Right Center';
  if (l.includes('center') && l.includes('left')) return 'Left Center';
  if (l.includes('center')) return 'Center';
  return loc;
}

function mapFinish(f) {
  if (!f) return '';
  const l = f.toLowerCase();
  if (l.includes('stainless')) return 'Stainless Steel Finish';
  if (l.includes('matte')) return 'Matte';
  if (l.includes('brushed')) return 'Brushed';
  if (l.includes('polished')) return 'Polished';
  return 'N/A';
}

function buildRowData(product, media) {
  const a = product.attributes ?? {};
  const ext = a.external_dimensions_in ?? {};
  const intl = a.internal_dimensions_in ?? {};
  const ship = a.shipping_dimensions_in ?? {};
  const desc = stripHtml(product.description);
  const images = (media ?? [])
    .filter((m) => m.storage_path && m.media_type === 'image')
    .sort((x, y) => (x.display_order ?? 999) - (y.display_order ?? 999));

  const r = {};
  r['Type'] = 'Product';
  r['Product ID'] = product.sku;
  r['Supplier SKU'] = product.sku;
  // BB&B wants the long marketing title, not the short model name
  r['Product Name'] = a.general_title_en ?? product.model_name ?? '';
  r['Description'] = desc;
  // DON'T set "Character Count for Description" — it's a formula cell F8
  r['Hide'] = 'No';
  r['Brand'] = product.brand ?? '';
  r['Warranty Provider'] = 'Manufacturer';
  r['Warranty Company'] = product.brand ?? '';
  r['Warranty Length'] = 'Limited Lifetime Manufacturer';
  r['Quality'] = 'New';
  r['Supplier Cost'] = product.dealer_cost_cad ?? '';
  r['Hard or Soft MAP'] = 'Hard';
  r['MSRP'] = product.msrp_cad ?? '';
  r['Country of Origin'] = COUNTRY_MAP[a.country_of_origin] ?? a.country_of_origin ?? '';
  r['UPC'] = a.upc ?? '';
  r['Model/Style#'] = product.sku;
  r['Manufacturer Part #'] = product.sku;
  r['Manufacturer Name'] = a.manufacturer ?? 'Stylish International Inc.';
  r['Show Prop 65 Disclaimer'] = 'No';
  // Width = left-right (length), Depth = front-to-back (width), Height = vertical (depth)
  r['Assembled Width'] = ext.length ?? '';
  r['Assembled Height'] = ext.depth ?? '';
  r['Assembled Depth'] = ext.width ?? '';
  r['Assembled Dimensions Unit of Measure'] = 'Inches';
  // Prefer the bare product weight; fall back to shipping weight only if absent.
  r['Product Weight'] = a.product_weight_lb ?? product.shipping_weight_lb ?? '';
  r['Product Weight Unit of Measure'] = 'Pounds';
  r['Assembly Required?'] = 'No';
  r['Fulfillment Time'] = '1 Business Day';
  r['Ship Mode - Carrier'] = 'Small Parcel - UPS';
  r['Expeditable'] = 'No';
  r['Replenishable'] = 'No';
  r['Shipping Box 1 Width'] = ship.width ?? '';
  r['Shipping Box 1 Length'] = ship.length ?? '';
  r['Shipping Box 1 Height'] = ship.height ?? '';
  r['Shipping Box 1 Dimensions Unit of Measure'] = 'Inches';
  r['Shipping Box 1 Weight'] = product.shipping_weight_lb ?? '';
  r['Shipping Box 1 Weight Unit of Measure'] = 'Pounds';
  images.forEach((img, i) => {
    if (i < 20) r[`Product Image ${i + 1}`] = getMediaUrl(img.storage_path) ?? '';
  });

  // PDFs → "Product PDF 1-10" with their type. BB&B only accepts PDFs here,
  // so DXF and other formats are skipped.
  const DOC_TYPE_TO_BBB = {
    installation_manual: 'Installation/Assembly Instructions',
    warranty_file: 'Warranty Information',
    spec_sheet: 'Technical Specifications',
    cut_out_template: 'Size Guides',
  };
  const pdfs = (media ?? []).filter((m) => {
    if (m.media_type !== 'document') return false;
    const name = (m.file_name ?? m.storage_path ?? '').toLowerCase();
    return m.mime_type === 'application/pdf' || /\.pdf(\?|$)/.test(name);
  });
  pdfs.slice(0, 10).forEach((d, i) => {
    r[`Product PDF ${i + 1}`] = getMediaUrl(d.storage_path) ?? '';
    const bbbType = DOC_TYPE_TO_BBB[d.document_type];
    if (bbbType) r[`PDF ${i + 1} Type`] = bbbType;
  });
  r['Attribute: Assembly Value 1'] = 'Assembled';
  // Basin/bowl depth is the internal (usable) depth, not the external dimension.
  r['Attribute: Basin Depth Value 1'] = basinDepthBucket(intl.depth ?? ext.depth);
  r['Attribute: Bowl Depth Value 1'] = bowlDepthBucket(intl.depth ?? ext.depth);
  r['Attribute: Commercial Value 1'] = 'Yes';
  if (a.craftsmanship === 'Handmade') r['Attribute: Customization Value 1'] = 'Handmade';
  // "Exact Color" dropdown only allows specific values; map stainless → Silver
  r['Attribute: Exact Color Value 1'] = product.material?.toLowerCase().includes('stainless') ? 'Silver' : (product.finish ?? '');
  if (ext.length && ext.width && ext.depth) {
    r['Attribute: Exact Size Value 1'] = `${ext.length}"x${ext.width}"x${ext.depth}"`;
  }
  r['Attribute: Finish Value 1'] = mapFinish(product.finish);
  r['Attribute: Material Value 1'] = product.material ?? '';
  r['Attribute: Number of Basin Value 1'] = mapBasins(a.number_of_bowls);
  const dur = a.durability_tags ?? [];
  if (dur.some((d) => d.toLowerCase().includes('rust') || d.toLowerCase().includes('stain'))) {
    r['Attribute: Product Features Value 1'] = 'Rust Resistant';
  }
  r['Attribute: Product Features Value 2'] = 'Sound Dampening';
  r['Attribute: Shape Value 1'] = mapShape(a.sink_shape);
  r['Attribute: Sink Drain location Value 1'] = mapDrain(a.drain_hole_location);
  r['Attribute: Sink Gauge Value 1'] = a.gauge ?? '';

  // installation_type is an array (dual-mount sinks have two entries);
  // BB&B has two Sink Style slots.
  const installs = Array.isArray(a.installation_type)
    ? a.installation_type
    : a.installation_type ? [a.installation_type] : [];
  const mappedInstalls = installs.map(mapInstallation).filter(Boolean);
  if (mappedInstalls[0]) r['Attribute: Sink Style Value 1'] = mappedInstalls[0];
  if (mappedInstalls[1]) r['Attribute: Sink Style Value 2'] = mappedInstalls[1];

  r['Attribute: Sink Width Value 1'] = sinkWidthBucket(ext.length);
  return r;
}

// ===================== XML helpers =====================

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colToIndex(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function buildCell(ref, value, style) {
  const s = style ? ` s="${style}"` : '';
  if (typeof value === 'number') {
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

// Inject data into an existing row by merging with existing cells,
// preserving formulas and re-serializing cells in ascending column order.
function injectDataRow(sheetXml, rowNum, cellData, style = '7') {
  const rowRe = new RegExp(`(<row\\b[^>]*\\br="${rowNum}"[^>]*>)([\\s\\S]*?)(</row>)`);
  const m = sheetXml.match(rowRe);
  if (!m) throw new Error(`Row ${rowNum} not found in the sheet.`);

  const openTag = m[1];
  const body = m[2];

  // 1. Parse existing cells into a map keyed by column letter
  const cells = {};
  const cellRe = /<c\b[^>]*\br="([A-Z]+)\d+"[\s\S]*?(?:\/>|<\/c>)/g;
  let cm;
  while ((cm = cellRe.exec(body)) !== null) {
    cells[cm[1]] = cm[0];
  }

  // 2. Overwrite only the columns we have data for (preserves formulas like F8)
  for (const [col, value] of Object.entries(cellData)) {
    cells[col] = buildCell(`${col}${rowNum}`, value, style);
  }

  // 3. Re-serialize cells in ascending column order (Excel requires this)
  const ordered = Object.keys(cells)
    .sort((a, b) => colToIndex(a) - colToIndex(b))
    .map((col) => cells[col])
    .join('');

  return sheetXml.replace(rowRe, `${openTag}${ordered}</row>`);
}

function parseXml(xmlString) {
  return new DOMParser().parseFromString(xmlString, 'application/xml');
}

function getCellValue(cellEl, ns) {
  const type = cellEl.getAttribute('t') ?? '';
  if (type === 'inlineStr') {
    const isEl = cellEl.getElementsByTagNameNS(ns, 'is')[0];
    if (isEl) {
      const tEls = isEl.getElementsByTagNameNS(ns, 't');
      let text = '';
      for (let i = 0; i < tEls.length; i++) text += tEls[i].textContent ?? '';
      return text;
    }
  }
  const vEl = cellEl.getElementsByTagNameNS(ns, 'v')[0];
  if (vEl) return vEl.textContent ?? '';
  return '';
}

function getCellCol(cellEl) {
  const ref = cellEl.getAttribute('r') ?? '';
  const match = ref.match(/^([A-Z]+)/);
  return match ? match[1] : null;
}

// ===================== Find the correct sheet =====================

async function findDataSheet(zip) {
  // Brute-force: try every sheet*.xml and find the one with BB&B headers
  const sheetFiles = Object.keys(zip.files).filter((f) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(f)
  );

  const knownHeaders = ['Type', 'Supplier SKU', 'Product Name', 'Brand', 'Description', 'UPC', 'MSRP', 'Quality'];

  for (const path of sheetFiles) {
    const xml = await zip.file(path).async('string');
    const doc = parseXml(xml);
    const ns = doc.documentElement.namespaceURI;
    const rows = doc.getElementsByTagNameNS(ns, 'row');

    for (let r = 0; r < rows.length; r++) {
      const rowEl = rows[r];
      const rowNum = parseInt(rowEl.getAttribute('r') ?? '0');
      const cells = rowEl.getElementsByTagNameNS(ns, 'c');

      const headers = {};
      const found = new Set();

      for (let c = 0; c < cells.length; c++) {
        const col = getCellCol(cells[c]);
        if (!col) continue;
        const val = getCellValue(cells[c], ns).trim();
        if (!val) continue;
        headers[val] = col;
        found.add(val);
      }

      const matchCount = knownHeaders.filter((h) => found.has(h)).length;
      if (matchCount >= 3 && Object.keys(headers).length > 5) {
        return { path, xml, doc, ns, headerRow: rowNum, headers };
      }
    }
  }

  throw new Error(
    `Could not find BB&B header row in any sheet. Sheets scanned: ${sheetFiles.join(', ')}`
  );
}

// ===================== Bulk export (multiple products into one template) =====================

// Build a fresh row from scratch with only the cells that have data.
// Sheet-level data validations (sqref="A8:A1000") still apply to the new
// row, so dropdowns work without copying styles or formulas.
function buildSimpleRow(rowNum, cellData, style = '7') {
  const sortedCols = Object.keys(cellData).sort((a, b) => colToIndex(a) - colToIndex(b));
  const cells = sortedCols.map((col) => buildCell(`${col}${rowNum}`, cellData[col], style));
  return `<row r="${rowNum}" spans="1:268">${cells.join('')}</row>`;
}

export async function generateBBBFromTemplateBulk(templateStoragePath, productList) {
  if (!productList?.length) throw new Error('No products selected.');

  const { data: blob, error } = await supabase.storage
    .from('templates')
    .download(templateStoragePath);
  if (error) throw new Error(`Failed to download template: ${error.message}`);

  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const sheet = await findDataSheet(zip);
  const baseRow = sheet.headerRow + 1;

  // Build cellData for each product (header → column letter → value)
  const productCellData = productList.map(({ product, media }) => {
    const rowData = buildRowData(product, media);
    const cellData = {};
    for (const [header, value] of Object.entries(rowData)) {
      const col = sheet.headers[header];
      if (!col || value === '' || value === null || value === undefined) continue;
      cellData[col] = value;
    }
    return cellData;
  });

  let xml = sheet.xml;

  // 1. First product → merge into the existing template row (row 8) — preserves
  //    the F8 formula, styles, and all cell-level metadata.
  xml = injectDataRow(xml, baseRow, productCellData[0], '7');

  // 2. Additional products → build fresh, simple rows and insert after row 8.
  //    Sheet-level data validations cover the new rows automatically.
  if (productList.length > 1) {
    const extraRows = productCellData
      .slice(1)
      .map((data, i) => buildSimpleRow(baseRow + 1 + i, data, '7'))
      .join('');

    // Find the closing </row> of the base row and insert after it.
    const baseRowRe = new RegExp(`(<row\\b[^>]*\\br="${baseRow}"[^>]*>[\\s\\S]*?</row>)`);
    const m = xml.match(baseRowRe);
    if (!m) throw new Error('Could not locate base row to extend.');
    xml = xml.replace(baseRowRe, `$1${extraRows}`);
  }

  zip.file(sheet.path, xml);

  const output = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    compression: 'DEFLATE',
  });

  const url = URL.createObjectURL(output);
  const link = document.createElement('a');
  link.href = url;
  link.download = `BBB_${productList.length}_products_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ===================== Main export (single product) =====================

export async function generateBBBFromTemplate(templateStoragePath, product, media) {
  // 1. Download template
  const { data: blob, error } = await supabase.storage
    .from('templates')
    .download(templateStoragePath);
  if (error) throw new Error(`Failed to download template: ${error.message}`);

  // 2. Open as ZIP
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());

  // 3. Find the correct sheet by scanning ALL sheets for BB&B headers
  const sheet = await findDataSheet(zip);
  const dataRowNum = sheet.headerRow + 1;

  // 4. Build data
  const rowData = buildRowData(product, media);

  // 5. Map header → column letter
  const cellData = {};
  for (const [header, value] of Object.entries(rowData)) {
    const col = sheet.headers[header];
    if (!col || value === '' || value === null || value === undefined) continue;
    cellData[col] = value;
  }

  // 6. Merge cells into existing row, preserving formulas and column order
  const updatedXml = injectDataRow(sheet.xml, dataRowNum, cellData, '7');
  zip.file(sheet.path, updatedXml);

  // 7. Download
  const output = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    compression: 'DEFLATE',
  });
  const url = URL.createObjectURL(output);
  const link = document.createElement('a');
  link.href = url;
  link.download = `BBB_${product.sku}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
