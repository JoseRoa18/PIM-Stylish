import { supabase } from '@/lib/supabase';
import { getMediaUrl } from '@/features/media/api/media';
import { logActivity } from '@/features/activity/api/activityLog';

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
  // Metal names beat textures: "Brushed Gold" is a Gold Finish.
  if (l.includes('stainless')) return 'Stainless Steel Finish';
  if (l.includes('chrome')) return 'Chrome Finish';
  if (l.includes('gold')) return 'Gold Finish';
  if (l.includes('nickel')) return 'Nickel Finish';
  if (l.includes('bronze')) return 'Bronze Finish';
  if (l.includes('brass')) return 'Brass Finish';
  if (l.includes('copper')) return 'Copper Finish';
  if (l.includes('matte')) return 'Matte';
  if (l.includes('brushed')) return 'Brushed';
  if (l.includes('polished')) return 'Polished';
  return 'N/A';
}

// "Exact Color" is a closed list (Black/Blue/…/Silver/White — no Gold, no
// Grey): anything unmappable stays blank rather than invalid.
function mapExactColor(product) {
  const t = `${product.finish ?? ''} ${product.material ?? ''}`.toLowerCase();
  if (t.includes('black')) return 'Black';
  if (t.includes('white')) return 'White';
  if (t.includes('chrome')) return 'Chrome';
  if (t.includes('stainless') || t.includes('silver') || t.includes('nickel')) return 'Silver';
  if (t.includes('brown') || t.includes('bamboo') || t.includes('acacia')) return 'Brown';
  return '';
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
  // BB&B is a US channel: its cost comes from the official Lowes/Small
  // Online Dealers/BB&B list and prices are USD.
  r['Supplier Cost'] = product.cost_usd_lowes_sod_bbb ?? '';
  r['Hard or Soft MAP'] = 'Hard';
  r['MSRP'] = product.msrp_usd ?? '';
  r['Country of Origin'] = COUNTRY_MAP[a.country_of_origin] ?? a.country_of_origin ?? '';
  r['UPC'] = a.upc ?? '';
  r['Model/Style#'] = product.sku;
  r['Manufacturer Part #'] = product.sku;
  r['Manufacturer Name'] = a.manufacturer ??
    (/azuni/i.test(product.brand || '') ? 'Azuni' : 'Stylish International Inc.');
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
  r['Attribute: Exact Color Value 1'] = mapExactColor(product);
  if (ext.length && ext.width && ext.depth) {
    r['Attribute: Exact Size Value 1'] = `${ext.length}"x${ext.width}"x${ext.depth}"`;
  }
  r['Attribute: Finish Value 1'] = mapFinish(product.finish);
  r['Attribute: Material Value 1'] = product.material ?? '';
  r['Attribute: Number of Basin Value 1'] = mapBasins(a.number_of_bowls);
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

  // ---- Category-specific attributes ----------------------------------------
  // Each First Cost file carries only its own category's attribute columns, so
  // keys for other categories are no-ops — the guards below exist for the
  // fields whose NAME repeats across categories with a DIFFERENT closed list
  // (Product Features, Height…), where a wrong-category value would be invalid.
  const cat = product.category ?? '';
  const isSink = /sink/.test(cat);
  const isFaucet = /faucet|pot_filler/.test(cat);

  if (isSink) {
    const dur = a.durability_tags ?? [];
    if (dur.some((d) => d.toLowerCase().includes('rust') || d.toLowerCase().includes('stain'))) {
      r['Attribute: Product Features Value 1'] = 'Rust Resistant';
    }
    r['Attribute: Product Features Value 2'] = 'Sound Dampening';
  }
  if (cat === 'bathroom_sink') {
    const holes = Number(a.number_of_faucet_holes);
    if (Number.isFinite(holes) && holes > 0) {
      r['Attribute: Number of Faucet Installation Hole Value 1'] = faucetHoleText(holes);
    }
  }

  if (isFaucet) {
    const t = `${product.product_type ?? ''} ${installs.join(' ')} ${a.mounting_type ?? ''} ${a.spout_type ?? ''}`.toLowerCase();
    r['Attribute: Configuration Value 1'] =
      /widespread/.test(t) ? 'Widespread'
        : /centerset|4.?inch/.test(t) ? 'Centerset'
        : /wall/.test(t) ? 'Wall Mount'
        : /single.?hole|one.?hole/.test(t) ? 'Single Hole'
        : 'Deck Mount';
    r['Attribute: Faucet Mount Style Value 1'] = /wall/.test(t) ? 'Wall Mount' : 'Deck Mount';
    r['Attribute: Faucet Set Value 1'] = 'Sink Faucet';

    const styles = [];
    if (/touchless|motion|sensor/.test(t) || /touchless/i.test(a.general_title_en ?? '')) styles.push('Touch-Touchless');
    if (/pull.?down|pull.?out|sprayer/.test(t)) styles.push('Hand Sprayer');
    if (/swivel/.test(t)) styles.push('Swivel Spout');
    if (/vessel/.test(t)) styles.push('Vessel');
    if (/waterfall/.test(t)) styles.push('Waterfall');
    if (styles[0]) r['Attribute: Faucet Style Value 1'] = styles[0];
    if (styles[1]) r['Attribute: Faucet Style Value 2'] = styles[1];

    const gpm = Number(a.max_flow_rate);
    if (Number.isFinite(gpm) && gpm > 0) {
      r['Attribute: Flow Rate Value 1'] =
        gpm <= 1 ? 'Up to 1 GPM' : gpm <= 2 ? '1-2 GPM' : gpm <= 3 ? '2-3 GPM' : 'Over 3 GPM';
    }

    const hstyle = String(a.handle_style ?? '').toLowerCase();
    const handleStyle =
      /lever/.test(hstyle) ? 'Lever'
        : /knob/.test(hstyle) ? 'Knob'
        : /cross/.test(hstyle) ? 'Cross'
        : /touchless|motion|sensor/.test(t) ? 'Touch-Touchless'
        : Number(a.number_of_handles) === 1 ? 'Single' : '';
    if (handleStyle) r['Attribute: Handle Style Value 1'] = handleStyle;

    const nh = Number(a.number_of_handles);
    if (Number.isFinite(nh)) {
      r['Attribute: Number of Faucet Handle Value 1'] =
        nh === 0 ? 'No Handle' : nh === 1 ? 'Single Handle' : nh === 2 ? 'Double Handle'
          : nh === 3 ? 'Triple Handle' : 'More than 3 Handles';
    }
    const holes = Number(a.number_of_installation_holes);
    if (Number.isFinite(holes) && holes > 0) {
      r['Attribute: Number of Faucet Installation Hole Value 1'] = faucetHoleText(holes);
    }

    // Buckets straight from the template's closed lists.
    const fh = Number(a.faucet_height_in ?? a.spout_height_in);
    if (Number.isFinite(fh) && fh > 0) {
      r['Attribute: Height Value 1'] =
        fh < 5 ? 'Less than 5 Inches' : fh <= 6 ? '5-6 Inches' : fh <= 7 ? '6-7 Inches'
          : fh <= 8 ? '7-8 Inches' : fh <= 10 ? '9-10 Inches' : 'Over 11 Inches';
    }
    const sh = Number(a.spout_height_in);
    if (Number.isFinite(sh) && sh > 0) {
      r['Attribute: Spout Height Value 1'] =
        sh > 15 ? 'Over 15 Inches' : `${Math.max(0, Math.ceil(sh) - 1)} to ${Math.ceil(sh)} Inches`;
    }
    // Spout Reach list runs in 0.5" steps up to 10 Inches.
    const sr = Number(a.spout_reach_in);
    if (Number.isFinite(sr) && sr >= 1 && sr <= 10) {
      const half = Math.round(sr * 2) / 2;
      r['Attribute: Spout Reach Value 1'] =
        half === 1 ? '1 Inch' : `${Number.isInteger(half) ? half : half.toFixed(1)} Inches`;
    }
    r['Attribute: Style Value 1'] = 'Modern & Contemporary';

    const feats = [];
    if (a.ada_compliant) feats.push('ADA Compliant');
    if (a.cupc_certified) feats.push('IAPMO Certified'); // cUPC is IAPMO's
    if (a.asse_1001_certified) feats.push('ASSE Certified');
    if (a.handles_included) feats.push('Handles Included');
    if (feats[0]) r['Attribute: Product Features Value 1'] = feats[0];
    if (feats[1]) r['Attribute: Product Features Value 2'] = feats[1];
  }

  // Soap dispensers: capacity bucket from the ml in title/attributes.
  if (cat === 'accessory' && /soap|dispenser/i.test(`${product.product_type ?? ''} ${a.general_title_en ?? ''}`)) {
    const ml = Number(a.capacity_ml) ||
      Number((String(a.general_title_en ?? '').match(/(\d+)\s*ml/i) ?? [])[1]);
    if (ml > 0) {
      const oz = ml / 29.5735;
      r['Attribute: Capacity Value 1'] =
        oz < 5 ? 'Up to 5 Ounces' : oz >= 12 ? '12 Ounces and Over' : `${Math.round(oz)} Ounces`;
    }
  }

  return r;
}

// Shared "Number of Faucet Installation Hole" wording (same list on the
// faucet and bathroom-sink templates).
function faucetHoleText(n) {
  return n === 1 ? 'Single hole' : n === 2 ? 'Two holes' : n === 3 ? 'Three holes'
    : n === 4 ? 'Four holes' : n === 5 ? 'Five holes' : n === 6 ? 'Six holes' : '';
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

// Core fill: template + products → { blob, fillReport }. Shared by the
// single-file export and the per-category set below.
async function fillBBBWorkbook(templateStoragePath, productList) {
  const { data: blob, error } = await supabase.storage
    .from('templates')
    .download(templateStoragePath);
  if (error) throw new Error(`Failed to download template: ${error.message}`);

  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const sheet = await findDataSheet(zip);
  const baseRow = sheet.headerRow + 1;

  // Build cellData for each product (header → column letter → value).
  // rowDatas is kept header-keyed for the readiness report at the end.
  const rowDatas = productList.map(({ product, media }) => buildRowData(product, media));
  const productCellData = rowDatas.map((rowData) => {
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

  // Readiness report: how many of the template's headed columns each export
  // actually filled (rowData is header-keyed, so count per header).
  const columns = Object.keys(sheet.headers).map((label) => ({
    label,
    filled: rowDatas.reduce(
      (n, rd) => (rd[label] !== '' && rd[label] != null ? n + 1 : n),
      0,
    ),
  }));
  return { blob: output, fillReport: { rows: productList.length, columns } };
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function generateBBBFromTemplateBulk(templateStoragePath, productList) {
  if (!productList?.length) throw new Error('No products selected.');
  const { blob, fillReport } = await fillBBBWorkbook(templateStoragePath, productList);
  triggerDownload(blob, `BBB_${productList.length}_products_${new Date().toISOString().slice(0, 10)}.xlsx`);

  logActivity({
    action: 'export',
    entityType: 'product',
    entityId: `${productList.length} products`,
    target: 'bbb',
    summary: `Exported ${productList.length} product(s) to a BB&B template`,
    metadata: { count: productList.length, skus: productList.map((p) => p.product?.sku).filter(Boolean) },
  });
  return { count: productList.length, fillReport };
}

/**
 * Per-category set: BB&B's First Cost files are one per Beyond category, so a
 * mixed selection fills each matching template and downloads ONE ZIP with the
 * files kept under their original names (same delivery style as Menards and
 * Lowe's).
 *
 * @param {Array<{ template: { storage_path: string, file_name: string }, productList: Array }>} groups
 */
export async function generateBBBSet(groups) {
  const filled = [];
  for (const g of groups) {
    if (!g.productList?.length) continue;
    const { blob, fillReport } = await fillBBBWorkbook(g.template.storage_path, g.productList);
    filled.push({ name: g.template.file_name, blob, fillReport });
  }
  if (!filled.length) throw new Error('No products matched a BB&B template.');

  if (filled.length === 1) {
    triggerDownload(filled[0].blob, filled[0].name);
  } else {
    const JSZip = await loadJSZip();
    const bundle = new JSZip();
    for (const f of filled) bundle.file(f.name, f.blob);
    const out = await bundle.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    triggerDownload(out, `BBB_${new Date().toISOString().slice(0, 10)}.zip`);
  }

  const total = groups.reduce((n, g) => n + (g.productList?.length ?? 0), 0);
  logActivity({
    action: 'export',
    entityType: 'product',
    entityId: `${total} products`,
    target: 'bbb',
    summary: `Exported ${total} product(s) to ${filled.length} BB&B template file(s)`,
    metadata: { count: total, files: filled.map((f) => f.name) },
  });
  return {
    count: total,
    files: filled.length,
    reports: filled.map((f) => ({ file: f.name, ...f.fillReport })),
  };
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

  logActivity({
    action: 'export',
    entityType: 'product',
    entityId: product.sku,
    target: 'bbb',
    summary: `Exported ${product.sku} to a BB&B template`,
  });
}
