import {
  loadJSZip,
  openTemplate,
  sheetPathByName,
  sheetToGrid,
  buildCell,
  indexToCol,
  injectRows,
  fetchImagesBySku,
} from './templateFiller';

// Menards (Syndigo "PIM Hierarchy") exporter.
//
// A Menards category is a SET of files: one ProductContent workbook (sheet
// "Attributes", ~251 columns) plus one small "Containers" workbook per
// dimension group (Overall Width / Height / Depth / Weight / Interior
// Dimensions Per Bowl — 6 columns each). All share the same layout on the data
// sheet: row 1 attribute GUIDs, row 2 source, row 3 locale, row 4 requiredness,
// row 5 display names; data rows start at row 6.
//
// Phase 1 fills what the PIM owns (content, compliance, dimensions, packaging
// from shipping data) and leaves Menards-account commercial fields (vendor,
// merchant, payment terms, master packs…) blank — or filled from
// MENARDS_ACCOUNT once the business provides the values.

// Account-level constants (same for every product). Fill these once with the
// values from the Menards vendor agreement; blank = left empty in the file.
const MENARDS_ACCOUNT = {
  'Vendor Number': '',
  'Merchant': '',
  'Associate Merchant': '',
  'Payment Terms': '',
  'FOB': '',
  'Shipping Method': '',
  'Ship Combination': '',
  'Freight Type': '',
  'Freight Min Description': '',
  'Vendor Ships Via': '',
  'Sales Unit': '',
  'Min Order Qty - Vendor': '',
  'Lead Time': '',
  'Order Lead Time UOM': '',
  'Product Port Of Origin': '',
};

const attr = (p) => p.attributes || {};
const num = (v) => {
  if (v == null || v === '') return '';
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? m[0] : '';
};
const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '');
const ext = (p, axis) => num(attr(p).external_dimensions_in?.[axis]);
const cut = (p, axis) => num(attr(p).cut_out_dimensions_in?.[axis]);
const ship = (p, axis) => num(attr(p).shipping_dimensions_in?.[axis]);
const colorFamily = (p) => {
  const f = String(p.finish ?? '').toLowerCase();
  if (/black/.test(f)) return 'Black';
  if (/gold/.test(f)) return 'Gold';
  if (/stainless|chrome|silver/.test(f)) return 'Silver';
  if (/white/.test(f)) return 'White';
  if (/grey|gray/.test(f)) return 'Gray';
  if (/brown|bamboo/.test(f)) return 'Brown';
  return '';
};
const mounting = (p) => {
  const t = `${p.product_type ?? ''} ${[attr(p).installation_type ?? []].flat().join(' ')} ${attr(p).mounting_type ?? ''}`;
  if (/dual/i.test(t)) return 'Dual Mount';
  if (/under/i.test(t)) return 'Undermount';
  if (/drop/i.test(t)) return 'Drop-In';
  if (/farmhouse|apron/i.test(t)) return 'Apron/Farmhouse';
  return '';
};
const interiorPerBowl = (p) => {
  const d = attr(p).internal_dimensions_in ?? {};
  return d.length && d.width && d.depth ? `${d.length} in x ${d.width} in x ${d.depth} in` : '';
};

// Rules keyed by the row-5 display name. Menards axis language: Width =
// side-to-side (PIM length), Depth = front-to-back (PIM width), Height =
// top-to-bottom (PIM height/depth).
const MENARDS_RULES = {
  ...Object.fromEntries(Object.entries(MENARDS_ACCOUNT).map(([k, v]) => [k, () => v])),

  // Identity & copy
  'Model Number': (p) => p.sku,
  'MFG Part # (OEM)': (p) => p.sku,
  'MFG Model # (Series)': (p) => p.model_name || p.sku,
  'Description 1': (p) => attr(p).general_title_en || p.model_name || p.sku,
  'Description 2': (p) => [p.brand, p.model_name, p.product_type].filter(Boolean).join(' '),
  'UPC': (p) => attr(p).upc || '',
  'Country Of Origin': (p) => attr(p).country_of_origin || '',
  'Mfg Location': (p) => attr(p).country_of_origin || '',
  'Imported Flag': (p) => (/canada|usa|united states/i.test(attr(p).country_of_origin ?? '') ? 'No' : 'Yes'),
  'Master Image (Front View)': (p) => (p._images ?? [])[0] ?? '',
  'Includes': (p) => [attr(p).accessories_included ?? []].flat().join(', '),
  'Product Type': (p) => p.product_type || '',
  'Application': (p) => attr(p).application || 'Kitchen',

  // Warranty
  'Mfr Warranty': (p) => attr(p).warranty_length || '',
  'Warranty UOM': (p) => (/year/i.test(attr(p).warranty_length ?? '') ? 'year' : ''),
  'Manufacturer Warranty': (p) => attr(p).warranty_length || '',

  // Sink specifics
  'Gauge': (p) => num(attr(p).gauge),
  'Sink Material': (p) => p.material || '',
  'Sink Shape': (p) => attr(p).sink_shape || '',
  'Number of Bowls': (p) => num(attr(p).number_of_bowls),
  'Bowl Configuration': (p) => attr(p).bowl_configuration || attr(p).basin_split || '',
  'Mounting Type': mounting,
  'Color/Finish': (p) => p.finish || '',
  'Color/Finish Family': colorFamily,
  'Drain Location': (p) => attr(p).drain_hole_location || '',
  'Number of Faucet Holes': (p) => num(attr(p).number_of_faucet_holes) || '0',
  'Faucet Type': () => '',
  'Faucet Finish': () => '',
  'Flow Rate': () => '',
  'Interior Dimensions Per Bowl': interiorPerBowl,

  // Dimensions (content + container files share these names)
  'Overall Width': (p) => ext(p, 'length'),
  'Overall Width UOM': (p) => (ext(p, 'length') ? 'inch' : ''),
  'Width': (p) => ext(p, 'length'),
  'Overall Depth': (p) => ext(p, 'width'),
  'Depth': (p) => ext(p, 'width'),
  'Overall Depth UOM': (p) => (ext(p, 'width') ? 'inch' : ''),
  'Overall Height': (p) => ext(p, 'height') || ext(p, 'depth'),
  'Overall Height UOM': (p) => (ext(p, 'height') || ext(p, 'depth') ? 'inch' : ''),
  'Weight': (p) => num(attr(p).product_weight_lb),
  'Weight UOM': (p) => (num(attr(p).product_weight_lb) ? 'pound' : ''),
  'Cutout Left-to-Right Width': (p) => cut(p, 'length'),
  'Cutout Front-to-Back Depth': (p) => cut(p, 'width'),
  'Cutout Below Counter Height': (p) => cut(p, 'depth'),
  'Minimum Cabinet Size': (p) => num(attr(p).min_external_cabinet_size_in),
  'Minimum Cabinet Size UOM': (p) => (num(attr(p).min_external_cabinet_size_in) ? 'inch' : ''),
  'Minimum Countertop Length': (p) => num(attr(p).min_external_cabinet_size_in),
  'Minimum Countertop Length UOM': (p) => (num(attr(p).min_external_cabinet_size_in) ? 'inch' : ''),

  // Retail pack = the shipping box the PIM already knows
  'Retail Pack Width': (p) => ship(p, 'width'),
  'Package Width UOM': (p) => (ship(p, 'width') ? 'inch' : ''),
  'Retail Pack Height': (p) => ship(p, 'height'),
  'Package Height UOM': (p) => (ship(p, 'height') ? 'inch' : ''),
  'Retail Pack Depth': (p) => ship(p, 'length'),
  'Package Depth UOM': (p) => (ship(p, 'length') ? 'inch' : ''),
  'Retail Pack Weight': (p) => num(p.shipping_weight_lb),
  'Package Weight UOM': (p) => (num(p.shipping_weight_lb) ? 'pound' : ''),
  'Retail Pack Qty': () => '1',
  'Retail Pack UPC': (p) => attr(p).upc || '',
  'Retail Packaging Type': () => 'Box',
  'Retail Nestable': () => 'No',
  'Retail Peggable': () => 'No',

  // Compliance (conservative constants; ADA from the PIM)
  'ADA Compliant': (p) => {
    const v = String(attr(p).ada_compliant ?? '').toLowerCase();
    if (!v) return '';
    return v.includes('not') || v === 'no' || v === 'false' ? 'No' : 'Yes';
  },
  'AGA Certified': () => 'No',
  'Lithium Type': () => 'Does not Use or Contain Lithium Batteries/Cells',
  // Sinks certify under ASME/ANSI A112 (the cUPC mark covers it).
  'ANSI Compliant': (p) => {
    const a = attr(p);
    const anyYes = [a.asme_a112_19_3_compliant, a.asme_a112_19_2_compliant, a.cupc_certified]
      .some((v) => /yes|true/i.test(String(v ?? '')));
    return anyYes ? 'Yes' : '';
  },
  'Certified Mark Name': (p) => (/yes|true/i.test(String(attr(p).cupc_certified ?? '')) ? 'UPC' : ''),
  'Perishable Item': () => 'No',
  'Expiration Date Required': () => 'No',
  'Limited Quantity': () => 'No',
  'Hazard Code Required': () => 'No',
  'Prop 65 Item': () => 'No',
  'OSHA Approved': () => 'No',
  'Energy Star': () => 'No',
  'Refrigerated Van': () => 'No',
  'Heated Van Required': () => 'No',
};

const BULLET_RE = /^Bullet_(\d+)$/;

// Locate the data sheet: "Attributes" on content files, the dimension-named
// sheet on container files (the one that isn't Summary/Reference/category).
function isDataSheetName(name) {
  return !['Summary', 'Reference'].includes(name);
}

/**
 * Fill one Menards workbook (content or containers). Returns the filled file
 * as a blob (kept under its original name — the set ships as one ZIP, the way
 * Menards delivers it) plus per-file stats.
 */
async function fillOne(template, products) {
  const { zip, shared } = await openTemplate(template.storage_path);
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const sheetNames = [...wbXml.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((m) => m[1]);

  let dataPath = null;
  let grid = null;
  for (const name of sheetNames.filter(isDataSheetName)) {
    const path = await sheetPathByName(zip, name);
    if (!path) continue;
    const g = sheetToGrid(await zip.file(path).async('string'), shared);
    // The data sheet is the one whose row 5 carries display names.
    if ((g[4] || []).filter(Boolean).length > 0) { dataPath = path; grid = g; break; }
  }
  if (!dataPath) throw new Error(`No data sheet found in ${template.file_name}`);

  const names = grid[4] || [];
  const ncols = names.length;
  const sheetXml = await zip.file(dataPath).async('string');

  const START = 6; // rows 1-5 are the Syndigo header block
  const unmapped = new Set();
  let rowsXml = '';
  products.forEach((p, pi) => {
    const rowNum = START + pi;
    const bullets = attr(p).bullet_points || [];
    let cells = '';
    for (let ci = 0; ci < ncols; ci++) {
      const nm = names[ci];
      if (!nm) continue;
      let v = '';
      const bul = BULLET_RE.exec(nm);
      if (bul) v = bullets[Number(bul[1]) - 1] || '';
      else {
        const rule = MENARDS_RULES[nm];
        if (!rule) { unmapped.add(nm); continue; }
        try { v = rule(p); } catch { v = ''; }
      }
      if (v === '' || v == null) continue;
      cells += buildCell(`${indexToCol(ci + 1)}${rowNum}`, v);
    }
    rowsXml += `<row r="${rowNum}" spans="1:${ncols}">${cells}</row>`;
  });

  zip.file(dataPath, injectRows(sheetXml, rowsXml, START - 1 + products.length));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { file: template.file_name, blob, columns: ncols, unmapped: [...unmapped] };
}

/**
 * Fill a whole Menards file set (content + containers) for the given products.
 * @param {Object[]} templates  marketplace_templates rows (all Menards files)
 * @param {Object[]} products   full product rows
 */
export async function generateMenardsFromTemplates(templates, products) {
  if (!templates?.length) throw new Error('No Menards templates uploaded.');
  if (!products?.length) throw new Error('No products to export.');

  // Attach primary-first image URLs (Master Image column).
  const imgBySku = await fetchImagesBySku(products.map((p) => p.sku));
  for (const p of products) p._images = (imgBySku[p.sku] || []).map((m) => m.storage_path);

  const results = [];
  for (const t of templates) results.push(await fillOne(t, products));

  // Bundle the whole set into one ZIP, mirroring how Menards delivers it.
  const JSZip = await loadJSZip();
  const bundle = new JSZip();
  for (const r of results) bundle.file(r.file, r.blob);
  const out = await bundle.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const category = (products[0]?.category ?? 'export').replace(/[^\w-]+/g, '_');
  const url = URL.createObjectURL(out);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Menards_${category}_${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return { files: results.length, count: products.length, results };
}
