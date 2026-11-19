import { getMediaUrl } from '@/features/media/api/media';
import { countryFromList } from '@/features/products/lib/countries';
import { WAREHOUSE, boxCount, boxSize, competitorPrices } from './ronaExport';
import {
  buildCell, columnStyles, downloadZip, fetchDocsBySku, fetchImagesBySku, fetchVideosBySku, indexToCol, injectRows, isYes, mergeRows, norm, sheetPathByName,
  sheetToGrid, templateExt,
} from './templateFiller';

// Rona's catalog file of its DSCO portal (user, 2026-11-19: "el que hay que
// llenar es el que te acabo de subir" — "RONA Catalog Items - Bathroom Sink
// Faucets.xlsx"). One file per Rona category:
//   "Catalog Data"       names on row 1, one row per product from row 2. The
//                        file comes with row 2 holding only its retailer id and
//                        its category (the last columns): every row carries them.
//   "Help and Glossary"  the same columns again — their names, what each asks,
//                        Required / Recommended / Optional, its type, and under
//                        them the values a pick list takes.
// The columns are found by their names, never by letter: a category's own
// attributes come after the columns every category shares, and the next
// category's file has others. A pick list takes only a value of the file's own
// list, a column the PIM has nothing for is left empty, and what was left empty
// among the Required ones is named (the readiness report).

const DATA_SHEET = 'Catalog Data';
const HELP_SHEET = 'Help and Glossary';
const MAX_BOXES = 10;

// What a file is for, by the last part of its category, and the PIM products
// that belong in it. A category not listed here takes what Templates gave it.
const CATEGORY_FITS = [
  [/bathroom sink faucets?$/i, (p) => p.category === 'bathroom_faucet', 'bathroom faucets'],
];

const attr = (p) => p.attributes ?? {};
const num = (v) => { const n = Number(v); return v !== null && v !== '' && v !== undefined && Number.isFinite(n) ? n : ''; };
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const words = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const yesNo = (v) => (v ? 'Yes' : 'No');
// A switch of the product page: never stored means off, like a stored No.
const switchOn = (v) => v === true || isYes(v);
const plain = (html) => words(String(html ?? '')
  .replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|li|h\d)>/gi, ' ').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'"));
// A text Rona caps: whole words up to the cap, and the cut is said.
function capped(text, max, sku, what, notes) {
  const t = words(text);
  if (t.length <= max) return t;
  notes.push(`${sku}: ${what} cut to ${max} characters`);
  const cut = t.slice(0, max + 1);
  return cut.slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : max).replace(/[\s,;:·-]+$/, '');
}
const titleOf = (p) => attr(p).general_title_en || p.model_name || '';
const tagsOf = (p) => list(attr(p).durability_tags).join(' | ');
const describes = (p) => `${p.product_type ?? ''} ${titleOf(p)} ${list(attr(p).accessories_included).join(' ')}`;
const materials = (p) => `${p.material ?? ''} ${attr(p).handle_material ?? ''} ${titleOf(p)}`;
const isJpg = (url) => /\.jpe?g(?:[?#]|$)/i.test(String(url ?? ''));
const isMp4 = (url) => /\.mp4(?:[?#]|$)/i.test(String(url ?? ''));

// Canada's order for artwork with text, as every push to a Canadian store: the
// English-French set, else the English one (with the French one), else
// English-Spanish — plus the photos without language. The main image first.
function canadaGallery(images) {
  const langs = [['en_fr'], ['en', 'fr'], ['en_es']].find((set) => images.some((m) => m.language === set[0])) ?? [];
  return images.filter((m) => !m.language || langs.includes(m.language)).map((m) => getMediaUrl(m.storage_path)).filter(Boolean);
}

// One PDF of a kind for a column's language: its own language first, then the
// bilingual file; a file without language (the brand's warranty) is English.
const DOC_KINDS = {
  installationguide: ['installation_manual', 'installation_undermount', 'installation_dual_mount', 'installation_drop_in', 'installation_top_mount'],
  dimensionguide: ['spec_sheet'],
  warranty: ['warranty_file'],
};
function docFor(docs, kind, french) {
  const types = DOC_KINDS[kind];
  if (!types) return '';
  const order = french ? ['fr', 'en_fr'] : ['en', 'en_fr', ''];
  const mine = docs.filter((d) => types.includes(d.raw) && order.includes(d.lang ?? ''));
  mine.sort((a, b) => order.indexOf(a.lang ?? '') - order.indexOf(b.lang ?? '') || types.indexOf(a.raw) - types.indexOf(b.raw));
  return mine[0] ? getMediaUrl(mine[0].url) : '';
}
function videoFor(videos, french) {
  const order = french ? ['fr', 'en_fr'] : ['en', 'en_fr', ''];
  const mine = videos.filter((v) => isMp4(v.storage_path) && order.includes(v.language ?? ''));
  mine.sort((a, b) => order.indexOf(a.language ?? '') - order.indexOf(b.language ?? ''));
  return mine[0] ? getMediaUrl(mine[0].storage_path) : '';
}

// Rona's colour families from the PIM's Color, and from the Finish where the
// Color is a word the list lacks ("Silver": brushed nickel, stainless steel).
function colorFamily(p, options) {
  const color = words(p.color);
  const has = (name) => options.find((o) => norm(o) === norm(name));
  if (/\band\b|\//i.test(color)) return has('Multiple colors') ?? '';
  // The longest name the finish holds: "Stainless steel" before "Steel".
  const inFinish = options.filter((o) => new RegExp(`\\b${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(p.finish ?? '')).sort((a, b) => b.length - a.length);
  return has(color) ?? inFinish[0] ?? '';
}

// "5 Years" + "Limited" → "5-year limited"; "Lifetime" + "Limited" → "Limited lifetime".
function warrantyChoices(p) {
  const length = words(attr(p).warranty_length);
  const limited = /limited/i.test(`${attr(p).warranty ?? ''} ${length}`);
  if (/lifetime/i.test(length)) return limited ? ['Limited lifetime', 'Lifetime'] : ['Lifetime'];
  const m = length.match(/(\d+)\s*-?\s*(year|month|day)/i);
  if (!m) return [];
  const base = `${m[1]}-${m[2].toLowerCase()}`;
  return limited ? [`${base} limited`, base] : [base];
}

// ---- what each column takes --------------------------------------------------
// Keyed by the column's name without spaces or signs. A rule answers with the
// value (or, for a pick list, the candidates to look up in the file's list);
// `x` holds what was read for the product and the column's own list.
const RULES = {
  sku: (p) => p.sku,
  productstatus: () => 'active',
  productiscurrentlyavailableinronastores: () => 'No',
  manufacturerpartnumber: (p) => p.sku,
  productnameenglish: (p, x) => capped(titleOf(p), 128, p.sku, 'the English name', x.notes),
  productnamefrench: (p, x) => capped(attr(p).general_title_fr, 128, p.sku, 'the French name', x.notes),
  marketingcopyenglish: (p) => plain(p.description),
  marketingcopyfrench: (p) => plain(attr(p).description_fr),
  upc: (p) => String(attr(p).upc ?? '').replace(/\D/g, ''),
  brand: (p) => p.brand ?? '',
  manufacturername: (p) => (/azuni/i.test(p.brand ?? '') ? 'Azuni' : attr(p).manufacturer ?? ''),
  bilingualpackaginganddocumentation: () => 'Bilingual',
  consumerunitsellinguom: () => 'EA - Each',
  unitcostwithoutshippingfees: (p) => num(p.cost_cad_rona_hd),
  currencycode: () => 'CAD',
  msrp: (p) => num(p.map_cad), // Rona's MSRP is the MAP (user, 2026-11-09)
  map: (p) => num(p.map_cad),
  shippedinhowmanyboxes: (p) => String(boxCount(p, MAX_BOXES)),
  countryoforigin: (p, x) => countryFromList(attr(p).country_of_origin, x.options),
  // Everything ships from the Cambridge warehouse, by parcel (the Vendor Quote Sheet's own answers).
  isyouritemcrossingaborder: () => 'No',
  hscode: (p) => { const d = String(attr(p).hs_code_ca || attr(p).hs_code || '').replace(/\D/g, ''); return d ? d.padEnd(10, '0').slice(0, 10) : ''; },
  isitemonaskid: () => 'No',
  isltlshippingrequired: () => 'No',
  leadtimebusinessdays: () => 2,
  warehouseaddress1: () => `${WAREHOUSE.address}, ${WAREHOUSE.postalCode}`,
  doesproductcontainswood: (p) => yesNo(/wood|bamboo|acacia|teak|walnut|maple|\boak\b|paper/i.test(materials(p))),
  doesproductcontainscompositewood: (p) => yesNo(/composite wood|wood fib|\bmdf\b|particle ?board|plywood/i.test(materials(p))),
  hazmatcode: (p, x) => x.options.find((o) => /^no msds/i.test(o)) ?? '',
  imagesfrontfacingimageenglish: (p, x) => x.main,
  imagesfrontfacingimagefrench: (p, x) => x.main, // "if only one image is available, use the same for both"
  // Made here only when it is made in Canada, and then a person confirms Rona's three conditions.
  wellmadehere: (p) => (attr(p).country_of_origin && !/^canada$/i.test(attr(p).country_of_origin) ? 'No' : ''),
  title: (p, x) => capped(titleOf(p), 128, p.sku, 'the title', []) || x.none,

  // ---- faucets ----
  '1holesinkcompatible': (p) => holes(p, 1),
  '2holesinkcompatible': (p) => holes(p, 2),
  // A single-hole faucet covers a three-hole sink when its deck plate comes with it.
  '3holesinkcompatible': (p) => (num(attr(p).number_of_installation_holes) === '' ? '' : yesNo(num(attr(p).number_of_installation_holes) === 3 || switchOn(attr(p).deck_plate_included))),
  activationmethod: (p) => {
    const t = `${attr(p).sensor_activation ?? ''} ${titleOf(p)}`;
    if (/touchless|sensor|motion/i.test(t)) return 'Touchless';
    if (/\btouch\b/i.test(t)) return 'Touch';
    return num(attr(p).number_of_handles) > 0 || attr(p).handle_style ? 'Handle' : '';
  },
  antimicrobial: (p) => (/antimicrob|antibacter/i.test(tagsOf(p)) ? 'Yes' : ''),
  commercialresidential: (p) => { const a = attr(p).application ?? ''; const com = /non.?residential|commercial/i.test(a); const res = /(^|;|\s)residential/i.test(a.replace(/non.?residential/gi, '')); return com && res ? 'Commercial/Residential' : com ? 'Commercial' : res ? 'Residential' : ''; },
  // Lead free by the PIM's own marks: Lead Free, California's AB 100, the Safe Drinking Water Act.
  complieswithfederalleadguidelines: (p) => (attr(p).lead_free === true || isYes(attr(p).lead_free) || isYes(attr(p).ab_100_compliant) || isYes(attr(p).sdwa_compliant) ? 'Yes' : ''),
  corrosionresistant: (p) => (/rust|corrosion/i.test(tagsOf(p)) ? 'Yes' : ''),
  deckplateincluded: (p) => yesNo(switchOn(attr(p).deck_plate_included)),
  fingerprintresistant: (p) => (/fingerprint|spot/i.test(tagsOf(p)) ? 'Yes' : ''),
  fixturecolorfamily: (p, x) => colorFamily(p, x.options),
  fixturefinish: (p) => [attr(p).finish_type, { Glossy: 'Gloss' }[attr(p).finish_type]],
  handletype: (p) => attr(p).handle_style ?? '',
  handlesincluded: (p) => yesNo(switchOn(attr(p).handles_included)),
  manufacturercolorfinish: (p) => p.finish ?? '',
  maxflowrate: (p, x) => { const n = num(attr(p).max_flow_rate); return n === '' ? '' : x.options.find((o) => parseFloat(o) === n) ?? `${n} GPM`; },
  maximumfaucetheightin: (p) => num(attr(p).faucet_height_in),
  mountinglocation: (p) => { const m = `${attr(p).mounting_type ?? ''} ${list(attr(p).installation_type).join(' ')}`; return /wall/i.test(m) ? 'Wall-mount' : /deck|single|hole|centerset|widespread|vessel/i.test(m) ? 'Deck-mount' : ''; },
  mountingtype: (p) => { const m = words(attr(p).mounting_type); return [m, m.replace(/-/g, ' '), /single/i.test(m) ? 'Single hole' : '']; },
  numberoffaucethandles: (p) => { const n = num(attr(p).number_of_handles); return n === '' ? '' : `${n}-handle`; },
  packagequantity: (p) => boxCount(p, 99),
  // The PIM records a pull-down spray where there is one.
  pulldownsprayer: (p) => yesNo(/pull.?down|pull.?out/i.test(`${attr(p).spray_type ?? ''}`)),
  scratchresistant: (p) => (/scratch/i.test(tagsOf(p)) ? 'Yes' : ''),
  soaporlotiondispenser: (p) => yesNo(/soap|lotion|dispenser/i.test(describes(p))),
  spoutheightin: (p) => num(attr(p).spout_height_in),
  spoutreachin: (p) => num(attr(p).spout_reach_in),
  spouttype: (p) => attr(p).spout_type ?? '',
  supplylinesincluded: (p) => yesNo(switchOn(attr(p).supply_line_included)),
  valveincluded: (p) => yesNo(switchOn(attr(p).valve_included)),
  warranty: (p) => warrantyChoices(p),
  collectionname: (p) => p.series || 'N/A',
};
function holes(p, n) {
  const count = num(attr(p).number_of_installation_holes);
  return count === '' ? '' : yesNo(count === n);
}

// Columns that come in numbered groups.
const PATTERNS = [
  [/^box(\d+)shippinginfodescription$/, (p, x, m) => (Number(m[1]) <= x.boxes ? words(titleOf(p)) : '')],
  [/^box(\d+)(depth|width|height|weight)$/, (p, x, m) => {
    if (Number(m[1]) > x.boxes) return '';
    // Rona measures a box by its long side, its short side and its height (as on the Vendor Quote Sheet).
    return { depth: x.box?.length ?? '', width: x.box?.width ?? '', height: x.box?.height ?? '', weight: num(p.shipping_weight_lb ?? attr(p).shipping_weight_lb) }[m[2]];
  }],
  [/^supplierbullet(\d+)$/, (p, x, m) => capped(list(attr(p).bullet_points)[Number(m[1]) - 1] ?? '', 250, p.sku, `bullet ${m[1]}`, x.notes)],
  [/^pdf(.+?)(english|french)$/, (p, x, m) => docFor(x.docs, m[1], m[2] === 'french')],
  [/^videourlproductdemo(english|french)$/, (p, x, m) => videoFor(x.videos, m[1] === 'french')],
  // The prices the PIM read on the other Canadian stores' pages.
  [/^(homedepot|wayfair|walmart|amazon|bestbuy)ca$/, (p, x, m) => x.prices[`${m[1]}_ca`]?.[p.sku] ?? ''],
];
// The image columns after the two front-facing ones take the rest of the
// gallery in the PIM's own order: the PIM does not say which photo is a silo,
// a lifestyle or a close-up.
const GALLERY_SLOT = /^images(silo|roomlifestyle|detailfeature|vignettelifestyle)/;

/** The help sheet as columns: [{ requirement, type, options }] by column index. */
function readGlossary(grid) {
  const head = grid.findIndex((row) => row && norm(row[0] ?? '') === 'sku');
  if (head === -1) throw new Error(`Rona changed its DSCO file: the "${HELP_SHEET}" sheet no longer lists the columns from "sku".`);
  const names = grid[head] ?? [];
  const requirement = grid[head + 2] ?? [];
  const type = grid[head + 3] ?? [];
  const options = [];
  for (let r = head + 4; r < grid.length; r++) {
    (grid[r] ?? []).forEach((v, ci) => { if (v !== undefined && v !== null && String(v).trim() !== '') (options[ci] ??= []).push(String(v)); });
  }
  return { names, column: (ci) => ({ requirement: requirement[ci] ?? '', type: type[ci] ?? '', options: options[ci] ?? [] }) };
}

/**
 * Fills an opened DSCO catalog file with the products that belong in it.
 * @returns {{ count, skipped, skippedReason, missingData, fillReport }}
 */
export async function fillRonaDsco({ zip, shared }, templateStoragePath, products, fileName, { task = null } = {}) {
  const path = await sheetPathByName(zip, DATA_SHEET);
  const helpPath = await sheetPathByName(zip, HELP_SHEET);
  if (!helpPath) throw new Error(`This Rona DSCO file has no "${HELP_SHEET}" sheet: its columns' lists are read from it.`);
  let xml = await zip.file(path).async('string');
  const grid = sheetToGrid(xml, shared);
  const header = (grid[0] ?? []).map((h) => words(h));
  if (norm(header[0] ?? '') !== 'sku') throw new Error(`Rona changed its DSCO file: "${DATA_SHEET}" no longer starts with the sku column.`);
  const glossary = readGlossary(sheetToGrid(await zip.file(helpPath).async('string'), shared));

  // What the file itself says it is: the retailer id and the category on its first row.
  const col = (name) => header.findIndex((h) => h === name);
  const retailerCol = col('sftp_retailer_id');
  const categoryCol = col('sftp_category');
  const retailerId = retailerCol === -1 ? '' : grid[1]?.[retailerCol] ?? '';
  const categoryPath = categoryCol === -1 ? '' : grid[1]?.[categoryCol] ?? '';
  if (!categoryPath) throw new Error('This Rona DSCO file does not say its category (sftp_category on row 2). Download it again from DSCO for one category.');
  const categoryName = categoryPath.split('||').pop().trim();
  const fits = CATEGORY_FITS.find(([re]) => re.test(categoryName));
  const kept = fits ? products.filter(fits[1]) : products;
  const skipped = products.filter((p) => !kept.includes(p)).map((p) => p.sku);
  if (!kept.length) {
    throw new Error(`This DSCO file is Rona's "${categoryName}" category: it takes ${fits[2]} only, and none of the products chosen is one. Upload the DSCO file of their own category in Templates.`);
  }

  const skus = kept.map((p) => p.sku);
  task?.progress(0.1, 'Reading images, documents and store prices…');
  const [images, docs, videos, prices] = await Promise.all([fetchImagesBySku(skus), fetchDocsBySku(skus), fetchVideosBySku(skus), competitorPrices(skus)]);
  task?.progress(0.45, 'Filling the sheet…');

  // Each column once: its rule, its list and whether Rona requires it.
  const gallerySlots = new Map(); // column index → place in the gallery
  const columns = header.map((name, ci) => {
    if (!name) return null;
    const key = norm(name);
    const spec = glossary.column(norm(glossary.names[ci] ?? '') === key ? ci : glossary.names.findIndex((n) => norm(n ?? '') === key));
    let rule = null;
    let match = null;
    if (GALLERY_SLOT.test(key)) {
      gallerySlots.set(ci, gallerySlots.size);
      rule = (p, x) => x.gallery[gallerySlots.get(ci)] ?? '';
    } else if (RULES[key]) rule = RULES[key];
    else {
      const hit = PATTERNS.find(([re]) => re.test(key));
      if (hit) { rule = hit[1]; match = key.match(hit[0]); }
    }
    // The DSCO platform's own optional columns repeat Rona's under other names ("msrp", "warranty"): left alone.
    if (/^optional$/i.test(spec.requirement)) rule = null;
    return { ci, name, rule, match, required: /^required$/i.test(spec.requirement), number: /^number/i.test(spec.type), whole: /no decimal/i.test(spec.type), options: spec.options, byNorm: new Map(spec.options.map((o) => [norm(o), o])) };
  });

  const styles = columnStyles(xml);
  const notes = []; // texts that were cut
  const offList = new Map(); // column name → Map(value → [sku])
  const empty = new Map(); // required column name → [sku]
  const filled = new Map(); // required column index → rows filled
  const rowCells = kept.map((p) => {
    const all = images[p.sku] ?? [];
    const pictures = canadaGallery(all).filter(isJpg);
    const main = all[0] && isJpg(all[0].storage_path) ? getMediaUrl(all[0].storage_path) : '';
    const x = { notes, prices, docs: docs[p.sku] ?? [], videos: videos[p.sku] ?? [], main, gallery: pictures.filter((u) => u !== main), box: boxSize(p), boxes: boxCount(p, MAX_BOXES), none: '' };
    const cells = new Map();
    for (const c of columns) {
      if (!c) continue;
      let value = '';
      if (c.ci === retailerCol) value = num(retailerId) === '' ? retailerId : num(retailerId);
      else if (c.ci === categoryCol) value = categoryPath;
      else if (c.rule) {
        const raw = c.rule(p, { ...x, options: c.options }, c.match);
        if (c.options.length) {
          // A pick list: the file's own spelling of one of the candidates, or nothing.
          const tries = [raw].flat().map((v) => words(v)).filter(Boolean);
          value = tries.map((t) => c.byNorm.get(norm(t))).find(Boolean) ?? '';
          if (!value && tries.length) {
            const seen = offList.get(c.name) ?? new Map();
            seen.set(tries[0], [...(seen.get(tries[0]) ?? []), p.sku]);
            offList.set(c.name, seen);
          }
        } else if (c.number) {
          const n = num(raw);
          value = n === '' ? '' : c.whole ? Math.round(n) : n;
        } else value = typeof raw === 'number' ? raw : words(raw);
      }
      if (c.required) {
        if (value === '') empty.set(c.name, [...(empty.get(c.name) ?? []), p.sku]);
        else filled.set(c.ci, (filled.get(c.ci) ?? 0) + 1);
      }
      if (value !== '') cells.set(c.ci + 1, value);
    }
    return cells;
  });

  // Row 2 is in the file (its retailer id and category): the first product goes
  // into it, the others into rows of the same shape after it.
  const rowAttrs = xml.match(/<row r="2"([^>]*?)\/?>/)?.[1]?.replace(/\/\s*$/, '') ?? '';
  const xmlOf = (cells, row) => new Map([...cells].map(([ci, v]) => [ci, buildCell(`${indexToCol(ci)}${row}`, v, typeof v === 'number' ? null : styles.get(ci) ?? null)]));
  xml = mergeRows(xml, new Map([[2, xmlOf(rowCells[0], 2)]]));
  const more = rowCells.slice(1).map((cells, i) => {
    const row = 3 + i;
    const body = [...xmlOf(cells, row)].sort((a, b) => a[0] - b[0]).map(([, cell]) => cell).join('');
    return `<row r="${row}"${rowAttrs}>${body}</row>`;
  }).join('');
  if (more) xml = injectRows(xml, more, 1 + rowCells.length);
  zip.file(path, xml);
  // Named apart from the Vendor Quote Sheet of the same products.
  await downloadZip(zip, /dsco/i.test(fileName) ? fileName : `${fileName}_DSCO`, templateExt(templateStoragePath), { task: task?.part(0.55, 1) });

  // What a person still has to look at, shortest first.
  const everywhere = [...empty].filter(([, without]) => without.length === kept.length).map(([name]) => name);
  const some = [...empty].filter(([, without]) => without.length < kept.length);
  const few = (names) => `${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}`;
  const missingData = [
    everywhere.length ? `required by Rona and empty on ${kept.length === 1 ? 'it' : 'every product'} (${everywhere.length} columns): ${everywhere.join(', ')}` : '',
    ...some.map(([name, without]) => `${name}: ${few(without)}`),
    ...[...offList].flatMap(([name, values]) => [...values].map(([value, with_]) => `${name} "${value}" is not on Rona's list: ${few(with_)}`)),
    ...notes,
  ].filter(Boolean);
  if (missingData.length) console.warn('[Rona DSCO export] To look at:', missingData);
  const required = columns.filter((c) => c?.required);
  return {
    count: kept.length,
    skipped: skipped.length ? skipped : undefined,
    skippedReason: skipped.length ? `this DSCO file is Rona's "${categoryName}" category` : undefined,
    missingData,
    fillReport: { rows: kept.length, columns: required.map((c) => ({ label: c.name, filled: filled.get(c.ci) ?? 0 })) },
  };
}
