import {
  openTemplate,
  sheetPathByName,
  buildCell,
  colToIndex,
  downloadZip,
  templateExt,
  mergeRows,
  fetchImagesBySku,
  fetchDocsBySku,
} from './templateFiller';
import { accessoryKind } from '@/features/templates/api/templates';

// Fills "The Home Depot Canada.xlsm" — HD Canada's own multi-sheet vendor
// workbook (NOT Mirakl like Home Depot US). Six editable sheets share the key
// (Vendor Part Number on "Basic Data"; the satellites mirror it by formula):
//
//   Basic Data (87 cols)   — identity, department, packaging L1, MSRP (CAD!)
//   Online Core Attributes — category tree, EN/FR names, marketing & bullets
//   Add EAN UPC            — additional barcodes only (nothing for us)
//   Digital Assets         — image / PDF file NAMES
//   ECO Options, HAZMAT    — questionnaires (all "No" for our catalog)
//
// Every sheet ships with its 2000 data rows already present (lookup formulas
// in place), so cells are MERGED into existing rows — same machinery as the
// Lowe's templates. Headers are row 1, hint row 2, data starts ROW 3.
//
// Category values are the template's own named-range strings
// ("Label_____rangeName"); each L(n) value names the range holding its
// children, so the chains below were read straight out of the workbook.
// Brand list has both "Stylish" and "AZUNI". Currency is CAD, so MSRP maps
// from the PIM's msrp_cad. Left for the business: Vendor Number (M), National
// Cost (BR), Org PDT days (CE), Pick SLA and Ship-From location.

const HDCA_DOC_TYPES = {
  spec_sheet: 'spec_sheet',
  installation_manual: 'installation_manual',
  installation_dual_mount: 'installation_manual',
  installation_undermount: 'installation_manual',
  installation_drop_in: 'installation_manual',
  installation_top_mount: 'installation_manual',
  warranty_file: 'warranty_file',
  owner_manual: 'owner_manual',
};

const attr = (p) => p.attributes || {};
const num = (v) => {
  if (v == null || v === '') return '';
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : '';
};
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const stripHtml = (h) =>
  String(h || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{2,}/g, '\n')
    .trim();
const brandMap = (b) => (/azuni/i.test(b || '') ? 'AZUNI' : 'Stylish');
const baseName = (path) => String(path || '').split('/').pop();

const installText = (p) =>
  `${p.product_type ?? ''} ${[attr(p).installation_type ?? []].flat().join(' ')} ${attr(p).mounting_type ?? ''}`;

// HD Canada department + breakdown (Department sheet values, verbatim).
const department = (p) => {
  if (/faucet|pot_filler/.test(p.category ?? '')) {
    return { dept: '29 Bath', breakdown: 'Faucets_____29_Bath_l2_1' };
  }
  if (p.category === 'bathroom_sink' || p.category === 'laundry_sink') {
    return { dept: '29 Bath', breakdown: 'Bath Fixtures_____29_Bath_l2_3' };
  }
  return { dept: '29 Kitchen', breakdown: 'Kitchen Sinks_____29_Kitchen_l2_4' };
};

// Online category chain (Categories sheet named ranges, verbatim).
const categoryChain = (p) => {
  const t = installText(p);
  switch (p.category) {
    case 'kitchen_sink':
    case 'bar_prep_sink':
    case 'outdoor_sink': {
      let l3 = 'Kitchen_Undermount_Sinks_____l3_kitchenundermountsinks';
      if (/workstation/i.test(`${t} ${list(attr(p).accessories_included).join(' ')}`)) l3 = 'Kitchen_Workstation_Sinks_____l3_kitchenworkstationsinks';
      else if (/farm|apron/i.test(t)) l3 = 'Farmhouse_Sinks_____l3_farmhousesinks';
      else if (/bar|prep|outdoor/i.test(`${t} ${p.category}`)) l3 = 'Prep_and_Bar_Sinks_____l3_prepandbarsinks';
      else if (/drop|top.?mount|dual/i.test(t)) l3 = 'Kitchen_Drop_In_Sinks_____l3_kitchendropinsinks';
      return ['Kitchen_____l1_kitchen', 'Kitchen_and_Bar_Sinks_____l2_kitchen_sinks', l3];
    }
    case 'bathroom_sink': {
      let l3 = 'Undermount_Sinks_____l3_undermountsinks2016';
      if (/vessel/i.test(t)) l3 = 'Vessel_Sinks_____l3_vesselsinks';
      else if (/pedestal|console/i.test(t)) l3 = 'Console_and_Pedestal_Sinks_____l3_pedestalsconsoles';
      else if (/wall/i.test(t)) l3 = 'Wall_Mount_Sinks_____l4_wallmountsinks2016';
      else if (/drop|top.?mount|dual/i.test(t)) l3 = 'Drop_In_Sinks_____l3_bathsinks';
      return ['Bath_____l1_bath', 'Bathroom_Sinks_____l2_sinks', l3];
    }
    case 'kitchen_faucet':
    case 'pot_filler': {
      const s = `${t} ${attr(p).spout_type ?? ''} ${attr(p).spray_type ?? ''}`;
      let l3 = 'Pull_Down_Faucets_____l3_pulldownfaucetsh20';
      if (/pot ?filler/i.test(`${s} ${p.category}`)) l3 = 'Pot_Fillers_____l3_potfillersh20';
      else if (/pull.?out/i.test(s)) l3 = 'Pull_Out_Faucets_____l3_pulloutfaucetsh20';
      else if (/bar |beverage|drinking|filtration/i.test(s)) l3 = 'Bar_Faucets_____l3_bagfaucetsh20';
      else if (/bridge/i.test(s)) l3 = 'Bridge_Faucets_____l3_bridgefaucetsh20';
      else if (/wall/i.test(s)) l3 = 'Wall_Mounted_Faucets_____l3_wallmountedh20';
      return ['Kitchen_____l1_kitchen', 'Kitchen_and_Bar_Faucets_____l2_kitchen_faucets', l3];
    }
    case 'bathroom_faucet':
      return ['Bath_____l1_bath', 'Bathroom_Faucets_and_Shower_Heads_____l2_bath_faucets', 'Bathroom_Sink_Faucets_____1010154'];
    case 'laundry_sink':
      return ['Bath_____l1_bath', 'Laundry_Sinks_and_Faucets_____category_laundryroombath', 'Laundry_Sinks_and_Tubs_____category_laundrysinksb'];
    case 'colander_drying_rack':
      return ['Kitchen_____l1_kitchen', 'Kitchen_and_Sink_Accessories_____l2_kitchen_sinkaccessories', 'Colanders_____l3_cuttingboards_colanders'];
    case 'accessory': {
      const byKind = {
        strainer: 'Sink_Strainers_and_Disposal_Flange_____l3_sinkstrainers_disposalflange',
        grid: 'Sink_Grids_and_Rinse_Baskets_____l3_sinkgrids_rinsebaskets',
        'soap dispenser': 'Soap_Lotion_Dispensers_____l3_soap_lotiondispensers',
      };
      const l3 = byKind[accessoryKind(p)] ?? 'Colanders_____l3_cuttingboards_colanders';
      return ['Kitchen_____l1_kitchen', 'Kitchen_and_Sink_Accessories_____l2_kitchen_sinkaccessories', l3];
    }
    default:
      return ['', '', ''];
  }
};

const isFragile = (p) =>
  /fireclay|porcelain|ceramic|glass|granite|composite/i.test(`${p.material ?? ''} ${attr(p).material ?? ''}`) ? 'Yes' : 'No';

const titleEn = (p) => attr(p).general_title_en || p.model_name || p.sku;
const titleFr = (p) => attr(p).general_title_fr || '';
const warrantyText = (p) => {
  const text = [attr(p).warranty_length, p.warranty ?? attr(p).warranty].filter(Boolean).join(' ');
  if (!text) return '';
  return (/warrant/i.test(text) ? text : `${text} warranty`).replace(/\s+/g, ' ');
};

// ---- Per-sheet rules, keyed by column letter (data starts row 3) -----------

const BASIC_DATA_RULES = {
  A: (p) => p.sku,
  B: () => 'Special_Order',
  C: () => 'Online Only',
  E: (p) => department(p).dept,
  F: (p) => department(p).breakdown,
  G: titleEn,
  H: titleFr,
  I: (p) => titleEn(p).slice(0, 20),
  J: (p) => (titleFr(p) || titleEn(p)).slice(0, 20),
  K: () => 'National',
  L: (p) => brandMap(p.brand),
  // M Vendor Number: account dropdown — business fills.
  O: (p) => attr(p).hs_code ?? p.hs_code ?? '',
  P: () => 'No',
  Q: () => 'EA_each',
  R: () => 1,
  S: () => 'Yes',
  T: () => 'Yes',
  U: () => 'Yes',
  W: (p) => String(attr(p).upc ?? p.upc ?? '').replace(/\D/g, ''),
  X: isFragile,
  Y: () => 'Box',
  Z: (p) => num(p.shipping_weight_lb ?? attr(p).shipping_weight_lb),
  AA: (p) => num(attr(p).product_weight_lb ?? p.weight_lb),
  AB: (p) => num(attr(p).shipping_dimensions_in?.height),
  AC: (p) => num(attr(p).shipping_dimensions_in?.width),
  AD: (p) => num(attr(p).shipping_dimensions_in?.length),
  BQ: () => 'Hard',
  // BR National Cost: commercial terms — business fills.
  BU: (p) => num(p.msrp_cad),
  CA: () => 'No',
  CB: () => 'No',
  CF: () => 'Others', // cardboard isn't in the list (EPS/PVC/Others)
  CG: () => 'CN - China',
};

const ONLINE_CORE_RULES = {
  C: (p) => categoryChain(p)[0],
  D: (p) => categoryChain(p)[1],
  E: (p) => categoryChain(p)[2],
  I: titleEn,
  J: (p) => stripHtml(p.description),
  Y: titleFr,
  Z: (p) => stripHtml(attr(p).description_fr),
  AO: warrantyText,
  AP: warrantyText,
  AQ: () => 'No',
  AR: () => 'No',
  AS: () => 'No',
  AT: (p) => num(attr(p).product_weight_lb ?? p.weight_lb),
  // Assembled H = vertical, W = left-to-right (PIM length), D = front-to-back.
  AU: (p) => num(attr(p).external_dimensions_in?.height ?? attr(p).external_dimensions_in?.depth),
  AV: (p) => num(attr(p).external_dimensions_in?.length),
  AW: (p) => num(attr(p).external_dimensions_in?.width),
  // AZ Pick SLA + BA-BC ship-from: fulfillment terms — business fills.
};
// Bullet1-14: EN in K..X, FR in AA..AN.
for (let i = 0; i < 14; i++) {
  ONLINE_CORE_RULES[colLetter(colToIndex('K') + i)] = (p) => list(attr(p).bullet_points)[i] ?? '';
  ONLINE_CORE_RULES[colLetter(colToIndex('AA') + i)] = (p) => list(attr(p).bullet_points_fr)[i] ?? '';
}

const DIGITAL_ASSETS_RULES = {
  C: (p) => baseName((p._images ?? [])[0]),
};

const ECO_RULES = { C: () => 'No' };

const HAZMAT_RULES = {
  C: () => 'No', D: () => 'No', E: () => 'No', F: () => 'No', G: () => 'No',
  H: () => 'No', I: () => 'No', J: () => 'No', K: () => 'No',
};

/**
 * Fill The Home Depot Canada workbook (in place) and download it.
 *
 * @param {string} templateStoragePath  path in the `templates` bucket
 * @param {Object[]} products           full product rows
 * @param {string} [fileName]
 */
export async function generateHomeDepotCaFromTemplate(templateStoragePath, products, fileName = 'HomeDepotCA_Export') {
  if (!products?.length) throw new Error('No products to export.');

  const { zip } = await openTemplate(templateStoragePath);

  const skus = products.map((p) => p.sku);
  const imgBySku = await fetchImagesBySku(skus);
  const docBySku = await fetchDocsBySku(skus, HDCA_DOC_TYPES, Object.keys(HDCA_DOC_TYPES));
  for (const p of products) {
    p._images = (imgBySku[p.sku] || []).map((m) => m.storage_path);
    p._docs = docBySku[p.sku] || [];
  }

  const DATA_ROW = 3;
  const fillSheet = async (sheetName, rules) => {
    const path = await sheetPathByName(zip, sheetName);
    if (!path) throw new Error(`The file has no "${sheetName}" sheet — is this the Home Depot Canada template?`);
    const xml = await zip.file(path).async('string');
    const cellsByRow = new Map();
    products.forEach((p, pi) => {
      const rowNum = DATA_ROW + pi;
      const cells = new Map();
      for (const [col, rule] of Object.entries(rules)) {
        let v;
        try { v = rule(p); } catch { v = ''; }
        if (v === '' || v == null) continue;
        cells.set(colToIndex(col), buildCell(`${col}${rowNum}`, v));
      }
      if (cells.size) cellsByRow.set(rowNum, cells);
    });
    zip.file(path, mergeRows(xml, cellsByRow));
  };

  // Digital Assets: primary + up to 20 additional images (D..W), PDFs X..AL.
  const digitalRules = { ...DIGITAL_ASSETS_RULES };
  for (let i = 0; i < 20; i++) {
    const ci = colToIndex('D') + i;
    digitalRules[colLetter(ci)] = (p) => baseName((p._images ?? [])[i + 1]);
  }
  for (let i = 0; i < 15; i++) {
    const ci = colToIndex('X') + i;
    digitalRules[colLetter(ci)] = (p) => baseName((p._docs ?? [])[i]?.url);
  }

  await fillSheet('Basic Data', BASIC_DATA_RULES);
  await fillSheet('Online Core Attributes', ONLINE_CORE_RULES);
  await fillSheet('Digital Assets', digitalRules);
  await fillSheet('ECO Options', ECO_RULES);
  await fillSheet('HAZMAT', HAZMAT_RULES);

  await downloadZip(zip, fileName, templateExt(templateStoragePath));
  return { count: products.length };
}

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
