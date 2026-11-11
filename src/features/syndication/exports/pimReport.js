import { supabase } from '@/lib/supabase';
import { FIELD_DEFS, SECTIONS, sectionOfHeader, CATEGORY_LABELS, ALIAS_LOOKUP, BULLET_RE, IMAGE_LINK_RE, imageLinkHeader, normalizeHeader } from '@/features/import/lib/importSchema';
import { buildSectionedWorkbook } from '@/features/import/lib/sectionedXlsx';
import { scoreCompleteness, completenessContext, inCompleteness } from '@/features/products/lib/completeness';
import { CATEGORY_OPTIONS } from '@/features/products/lib/categories';
import { fetchAllProducts } from './pimExport';
import { reportKind } from './pimReportKinds';

// The PIM's reports (user, 2026-10-15: "un reporte completo en un solo excel
// con toda la información de todos los productos"; 2026-11-11: one per
// subject too — prices, attributes, content, images, marketplace IDs — "y
// lógicamente el full completo", pimReportKinds.js). The complete one is an
// .xlsx with
//  - Summary: totals, by category, by status, the most-missed fields;
//  - All Products: one row per product, every field the PIM's Excel carries
//    in its sections, then completeness, stock, media, marketplace IDs, the
//    web store flags and the older fields the app no longer reads;
//  - Media (one row per file) and Marketplace IDs (one row per ID);
//  - Notes: what each part means.
// A report by subject is the same product sheet with that subject's sections.
//
// Every report can be uploaded back in Import Products (user, 2026-11-11:
// "que permita importar y que actualice aquellos datos nuevos"): each product
// row starts with SKU, Model Name, Brand and Category, the PIM's own fields
// keep the import's column names, and every other column (completeness,
// stock, links, IDs, older fields) has a name the import does not know, so it
// is read-only (`readOnlyHeader`). The import writes only the cells that
// differ from the PIM (importChanges.js), so a report uploaded as it was
// downloaded changes nothing.

const PAGE = 1000; // the API's row cap per request

async function readAll(table, columns, order) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select(columns).order(order).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

const groupBy = (rows, key = 'sku') => rows.reduce((m, r) => m.set(r[key], [...(m.get(r[key]) ?? []), r]), new Map());

const stripHtml = (h) => String(h || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<\/li>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/\n{2,}/g, '\n').trim();

// Excel holds at most 32,767 characters in a cell.
const MAX_CELL = 32000;
const NUMERIC = new Set(['number', 'int', 'money']);
function show(raw, type) {
  if (raw == null || raw === '') return '';
  if (type === 'description') return stripHtml(raw).slice(0, MAX_CELL);
  if (NUMERIC.has(type) && Number.isFinite(Number(raw))) return Number(raw);
  if (Array.isArray(raw)) return raw.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : x)).join('; ');
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  if (typeof raw === 'object') return JSON.stringify(raw).slice(0, MAX_CELL);
  return String(raw).slice(0, MAX_CELL);
}
const day = (ts) => (ts ? String(ts).slice(0, 10) : '');

const LANG = { en: 'EN', fr: 'FR', en_fr: 'EN-FR', en_es: 'EN-ES' };
const TAB = { overview: 'Overview', specs: 'Specifications', content: 'Content', pricing: 'Pricing', media: 'Media' };

// The sections the report adds after the PIM Excel's own.
const REPORT_SECTIONS = [
  { key: 'x_completeness', title: 'PIM Completeness', color: 'B71C1C' },
  { key: 'x_stock', title: 'Stock', color: '33691E' },
  { key: 'x_media', title: 'Images & Documents', color: '4E342E' },
  { key: 'x_images', title: 'Images (links)', color: '4E342E' },
  { key: 'x_channels', title: 'Websites & Marketplace IDs', color: '01579B' },
  { key: 'x_sync', title: 'Web Store Flags & Sync', color: '455A64' },
  { key: 'x_other', title: 'Other / Older Fields (not used by the app)', color: '616161' },
];

// Product columns the report shows by name (or leaves out: Wix's own copy of
// the product), so they are not repeated among the older fields.
const SHOWN_COLUMNS = new Set(['sku', 'brand', 'category', 'attributes', 'workflow_status', 'family_number', 'created_at', 'updated_at',
  'wix_product_id', 'wix_synced_at', 'wayfair_synced_at', 'visible_online', 'visible_pos', 'on_sale', 'sale_price_cad', 'pre_order', 'ribbon',
  'spec_sheet_needs_update', 'installation_sheet_needs_update', 'notes', 'wayfair_item_group_id', 'wayfair_usa_item_group_id',
  'channel_exclusions', 'wix_raw', 'additional_info_sections', 'wix_collection_ids']);
const filled = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length);

// A read-only column must not be read by the import as one of its fields: an
// older attribute called `color` was taken for the Color column and its value
// would have been written over 11 products (2026-11-11). A name the import
// knows gets a tag that makes it unknown.
const importKnows = (header) => {
  const n = normalizeHeader(header);
  return ALIAS_LOOKUP.has(n) || BULLET_RE.test(n) || IMAGE_LINK_RE.test(n);
};
const readOnlyHeader = (header, tag = 'read-only') => (importKnows(header) ? `${header} (${tag})` : header);
// The four columns every product row starts with, so a report can be imported.
const KEY_FIELDS = new Set(['sku', 'model_name', 'brand', 'category']);

// `task` (optional taskProgress reporter): one step per table read. A report
// by subject reads only the tables it shows (the media list is ~9,500 rows).
async function loadReportData(task = null, kind = reportKind('complete')) {
  const has = (section) => kind.sections === null || kind.sections.includes(section);
  const none = Promise.resolve([]);
  const reads = [
    fetchAllProducts(),
    has('x_media') || has('x_images') ? readAll('product_media', 'id, sku, media_type, storage_path, file_name, file_size_bytes, is_primary, display_order, document_type, language, image_role', 'id') : none,
    has('x_channels') ? readAll('product_aliases', 'sku, marketplace, alias, kind, note, listing_title', 'sku') : none,
    has('x_channels') ? readAll('amazon_links', 'marketplace, sku, seller_sku, asin, status, fulfillment', 'sku') : none,
    has('x_stock') ? readAll('product_inventory', 'market, sku, on_hand, available, eta, synced_at', 'sku') : none,
    has('x_channels') ? readAll('wix_links', 'site, sku, wix_product_id, synced_at', 'sku') : none,
  ];
  let done = 0;
  const [products, media, aliases, amazon, stock, wix] = await Promise.all(reads.map((p) => p.then((rows) => {
    done += 1;
    task?.count(done, reads.length, `Loading the catalog… (${done} of ${reads.length} tables)`);
    return rows;
  })));
  return { products, media, aliases, amazon, stock, wix };
}

/** The report's sheets, from the loaded rows (see buildSectionedWorkbook). `kindKey`: pimReportKinds.js. */
export function pimReportSheets({ products, media, aliases, amazon, stock, wix }, generatedOn = new Date().toISOString().slice(0, 10), kindKey = 'complete') {
  const kind = reportKind(kindKey);
  const whole = kind.sections === null; // the complete report: every section
  const inKind = (section) => whole || kind.sections.includes(section);
  const mediaBy = groupBy(media);
  const aliasBy = groupBy(aliases);
  const amazonBy = groupBy(amazon);
  const stockBy = groupBy(stock);
  const wixBy = groupBy(wix);
  const imagesOf = (sku) => (mediaBy.get(sku) ?? []).filter((m) => m.media_type === 'image');
  const docsOf = (sku) => (mediaBy.get(sku) ?? []).filter((m) => m.media_type === 'document');
  const stockOf = (sku, market) => (stockBy.get(sku) ?? []).find((r) => r.market === market);
  const categoryName = (c) => CATEGORY_LABELS[c] ?? CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? c ?? '';

  // the same score as Listing Health → PIM: the UPC check sees every product
  // that is not archived, obsolete ones included (user, 2026-10-16); every
  // product keeps its own score here, the Summary counts only the scored ones
  // (only the complete report scores: it is the one that reads the media too)
  const ctx = whole ? completenessContext(products.filter((p) => p.workflow_status !== 'archived')) : null;
  const score = new Map(whole ? products.map((p) => [p.sku, scoreCompleteness(p, mediaBy.get(p.sku) ?? [], ctx)]) : []);

  // ---- every field of the PIM's Excel, in its section ----
  const longest = (key) => Math.max(0, ...products.map((p) => (Array.isArray(p.attributes?.[key]) ? p.attributes[key].length : 0)));
  const bulletCols = (key, lang, section) => Array.from({ length: longest(key) }, (_, i) => ({
    section, header: `Bullet/Feature ${i + 1} (${lang})`, field: key, get: (p) => show(p.attributes?.[key]?.[i], 'text'), // an import field too
  }));
  const columns = [];
  const covered = new Set(['attr:bullet_points', 'attr:bullet_points_fr']); // what the field columns show
  for (const def of FIELD_DEFS) {
    const t = def.target;
    const id = t.col ? `col:${t.col}` : t.attr ? `attr:${t.attr}` : `dim:${t.dim[0]}.${t.dim[1]}`;
    if (covered.has(id)) continue; // two names for one field: the first one shows it
    covered.add(id);
    const section = sectionOfHeader(def.label);
    columns.push({
      section,
      header: def.label,
      field: def.key, // one of the import's own fields: what an upload can change
      money: section.startsWith('pricing'),
      format: /\bURL\b/.test(def.label) ? 'link' : undefined, // Product URL, Warranty URLs
      get: (p) => (def.type === 'category'
        ? categoryName(p.category)
        : show(t.col ? p[t.col] : t.attr ? p.attributes?.[t.attr] : p.attributes?.[t.dim[0]]?.[t.dim[1]], def.type)),
    });
    if (def.key === 'description_en') columns.push(...bulletCols('bullet_points', 'EN', 'content_en'));
    if (def.key === 'description_fr') columns.push(...bulletCols('bullet_points_fr', 'FR', 'content_fr'));
  }

  // ---- what the PIM keeps besides ----
  const marketplaces = [...new Set(aliases.map((a) => a.marketplace))].sort();
  const docName = (d) => `${String(d.document_type ?? 'document').replace(/_/g, ' ')}${d.language ? ` (${LANG[d.language] ?? d.language})` : ''}`;
  const mainImage = (sku) => {
    const imgs = imagesOf(sku);
    return (imgs.find((m) => m.is_primary) ?? [...imgs].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))[0])?.storage_path ?? '';
  };
  const amazonOf = (sku, mk, key) => (amazonBy.get(sku) ?? []).filter((a) => a.marketplace === mk).map((a) => a[key]).filter(Boolean).join('; ');
  columns.push(
    { section: 'status', header: 'Workflow Status', get: (p) => p.workflow_status ?? '' },
    { section: 'status', header: 'Family #', get: (p) => show(p.family_number, 'int') },
    { section: 'status', header: 'Created', get: (p) => day(p.created_at) },
    { section: 'status', header: 'Last Updated', get: (p) => day(p.updated_at) },
    ...(whole ? [
      { section: 'x_completeness', header: 'PIM Completeness', format: 'percent', get: (p) => score.get(p.sku).score / 100 },
      { section: 'x_completeness', header: 'Fields Missing', get: (p) => score.get(p.sku).missing.length },
      { section: 'x_completeness', header: 'Missing (field — reason)', get: (p) => score.get(p.sku).missing.map((m) => (m.note ? `${m.label} — ${m.note}` : m.label)).join('; ') },
    ] : []),
    ...['ca', 'us'].flatMap((mk) => {
      const M = mk.toUpperCase();
      return [
        { section: 'x_stock', header: `Stock ${M} — Available`, get: (p) => show(stockOf(p.sku, mk)?.available, 'number') },
        { section: 'x_stock', header: `Stock ${M} — On Hand`, get: (p) => show(stockOf(p.sku, mk)?.on_hand, 'number') },
        ...(mk === 'ca' ? [{ section: 'x_stock', header: 'Stock CA — ETA', get: (p) => show(stockOf(p.sku, 'ca')?.eta, 'text') }] : []),
        { section: 'x_stock', header: `Stock ${M} — Read`, get: (p) => day(stockOf(p.sku, mk)?.synced_at) },
      ];
    }),
    { section: 'x_media', header: 'Images', get: (p) => imagesOf(p.sku).length },
    { section: 'x_media', header: 'Main Image URL', format: 'link', get: (p) => mainImage(p.sku) },
    { section: 'x_media', header: 'Videos', get: (p) => (mediaBy.get(p.sku) ?? []).filter((m) => m.media_type === 'video').length },
    { section: 'x_media', header: 'Documents', get: (p) => docsOf(p.sku).length },
    { section: 'x_media', header: 'Document Types', get: (p) => [...new Set(docsOf(p.sku).map(docName))].sort().join('; ') },
    { section: 'x_channels', header: 'Websites (Wix)', get: (p) => [...new Set((wixBy.get(p.sku) ?? []).map((w) => w.site))].sort().join('; ') },
    ...['ca', 'us'].flatMap((mk) => [
      { section: 'x_channels', header: `Amazon ${mk.toUpperCase()} Seller SKU`, get: (p) => amazonOf(p.sku, mk, 'seller_sku') },
      { section: 'x_channels', header: `Amazon ${mk.toUpperCase()} ASIN`, get: (p) => amazonOf(p.sku, mk, 'asin') },
    ]),
    ...marketplaces.map((m) => ({ section: 'x_channels', header: `${m} ID`, get: (p) => (aliasBy.get(p.sku) ?? []).filter((a) => a.marketplace === m).map((a) => a.alias).join('; ') })),
    { section: 'x_channels', header: 'Wayfair Item Group ID (CA)', get: (p) => show(p.wayfair_item_group_id, 'text') },
    { section: 'x_channels', header: 'Wayfair Item Group ID (USA)', get: (p) => show(p.wayfair_usa_item_group_id, 'text') },
    { section: 'x_channels', header: 'Excluded Marketplaces', get: (p) => show(p.channel_exclusions, 'text') },
    { section: 'x_sync', header: 'Wix Product ID', get: (p) => show(p.wix_product_id, 'text') },
    { section: 'x_sync', header: 'Wix Synced', get: (p) => day(p.wix_synced_at) },
    { section: 'x_sync', header: 'Wayfair Synced', get: (p) => day(p.wayfair_synced_at) },
    { section: 'x_sync', header: 'Visible Online', get: (p) => show(p.visible_online, 'text') },
    { section: 'x_sync', header: 'Visible POS', get: (p) => show(p.visible_pos, 'text') },
    { section: 'x_sync', header: 'On Sale (Wix)', get: (p) => show(p.on_sale, 'text') },
    { section: 'x_sync', header: 'Sale Price CAD (Wix)', money: true, get: (p) => show(p.sale_price_cad, 'money') },
    { section: 'x_sync', header: 'Pre-order', get: (p) => show(p.pre_order, 'text') },
    { section: 'x_sync', header: 'Ribbon', get: (p) => show(p.ribbon, 'text') },
    { section: 'x_sync', header: 'Spec Sheet Needs Update', get: (p) => show(p.spec_sheet_needs_update, 'text') },
    { section: 'x_sync', header: 'Installation Sheet Needs Update', get: (p) => show(p.installation_sheet_needs_update, 'text') },
    { section: 'x_sync', header: 'Notes', get: (p) => show(p.notes, 'text') },
  );
  // The images report: every image's link, the main one first, then in their
  // order — "Image 1", "Image 2"… as in the PIM export (the import knows those
  // names and never reads them).
  if (!whole && inKind('x_images')) {
    const linksOf = new Map(products.map((p) => [p.sku, [...imagesOf(p.sku)]
      .filter((m) => m.storage_path)
      .sort((a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)) || (a.display_order ?? 0) - (b.display_order ?? 0))
      .map((m) => m.storage_path)]));
    const most = Math.max(0, ...[...linksOf.values()].map((l) => l.length));
    for (let i = 0; i < most; i += 1) {
      columns.push({ section: 'x_images', header: imageLinkHeader(i + 1), imageLink: true, format: 'link', get: (p) => linksOf.get(p.sku)[i] ?? '' });
    }
  }

  // every other value a product holds: older columns and attributes from
  // earlier imports, kept as they are
  const older = new Map(); // id → name
  for (const p of whole ? products : []) {
    for (const [k, v] of Object.entries(p)) {
      if (!SHOWN_COLUMNS.has(k) && !covered.has(`col:${k}`) && filled(v)) older.set(`col:${k}`, k);
    }
    for (const [k, v] of Object.entries(p.attributes ?? {})) {
      if (!filled(v)) continue;
      if (typeof v === 'object' && !Array.isArray(v)) {
        for (const [axis, x] of Object.entries(v)) if (filled(x) && !covered.has(`dim:${k}.${axis}`)) older.set(`dim:${k}.${axis}`, `${k}.${axis}`);
      } else if (!covered.has(`attr:${k}`)) older.set(`attr:${k}`, k);
    }
  }
  for (const [id, name] of [...older].sort((a, b) => a[1].localeCompare(b[1]))) {
    const [olderKind] = id.split(':');
    columns.push({
      section: 'x_other',
      header: olderKind === 'col' ? `${name} (column)` : `${name} (older field)`,
      get: (p) => {
        if (olderKind === 'col') return show(p[name], 'text');
        if (olderKind === 'dim') { const [g, axis] = name.split('.'); return show(p.attributes?.[g]?.[axis], 'text'); }
        return show(p.attributes?.[name], 'text');
      },
    });
  }

  // ---- The product sheet: rows by category, then SKU ----
  // Its columns: the report's sections, after the four every row starts with.
  // The complete report leaves out a column nobody fills; a report by subject
  // keeps every field of its sections, filled or not, so it can be filled in
  // and uploaded (its read-only columns still go when empty).
  // (an image link keeps its name: the import knows "Image N" and skips it)
  for (const c of columns) if (!c.field && !c.imageLink) c.header = readOnlyHeader(c.header);
  const wanted = columns.filter((c) => inKind(c.section) || KEY_FIELDS.has(c.field));
  const catOrder = [...CATEGORY_OPTIONS.map((c) => c.value), ...new Set(products.map((p) => p.category).filter((c) => !CATEGORY_OPTIONS.some((o) => o.value === c)))];
  const sorted = [...products].sort((a, b) => catOrder.indexOf(a.category) - catOrder.indexOf(b.category) || a.sku.localeCompare(b.sku));
  const sectionDefs = [...SECTIONS, ...REPORT_SECTIONS];
  const values = wanted.map((c) => sorted.map((p) => c.get(p)));
  const kept = wanted.map((c, i) => ({ ...c, values: values[i] })).filter((c) => KEY_FIELDS.has(c.field) || (!whole && c.field) || c.values.some(filled));
  const sections = sectionDefs
    .map((s) => ({ ...s, cols: kept.filter((c) => c.section === s.key) }))
    .filter((s) => s.cols.length);
  const ordered = sections.flatMap((s) => s.cols);
  const allProducts = {
    name: kind.sheet,
    sections: sections.map((s) => ({ title: s.title, color: s.color, headers: s.cols.map((c) => c.header) })),
    formats: ordered.map((c) => c.format ?? (c.money ? 'money' : null)),
    rows: sorted.map((_, r) => ordered.map((c) => c.values[r])),
  };

  // ---- Media and Marketplace IDs: one row per file / per ID ----
  const modelOf = new Map(products.map((p) => [p.sku, p.model_name ?? '']));
  const mediaSheet = {
    name: 'Media',
    sections: [{ title: 'Images, videos & documents — one row per file', color: '4E342E', headers: ['SKU', 'Model Name', 'Type', 'Document Type', 'Language', 'Primary', 'Order', 'Image Role', 'File Name', 'Size (KB)', 'URL'] }],
    formats: [null, null, null, null, null, null, null, null, null, null, 'link'],
    rows: [...media]
      .sort((a, b) => a.sku.localeCompare(b.sku) || String(a.media_type).localeCompare(String(b.media_type)) || (a.display_order ?? 0) - (b.display_order ?? 0))
      .map((m) => [m.sku, modelOf.get(m.sku) ?? '', m.media_type ?? '', m.document_type ? String(m.document_type).replace(/_/g, ' ') : '',
        LANG[m.language] ?? m.language ?? 'Universal', m.is_primary ? 'Yes' : '', m.display_order ?? '', m.image_role ?? '', m.file_name ?? '',
        m.file_size_bytes ? Math.round(m.file_size_bytes / 1024) : '', m.storage_path ?? '']),
  };
  const idsSheet = {
    name: 'Marketplace IDs',
    sections: [{ title: 'Marketplace & website IDs — one row per ID', color: '01579B', headers: ['SKU', 'Model Name', 'Channel', 'ID', 'Kind', 'Listing Title / ASIN', 'Note / Status'] }],
    rows: [
      ...aliases.map((a) => [a.sku, modelOf.get(a.sku) ?? '', a.marketplace, a.alias, a.kind ?? '', a.listing_title ?? '', a.note ?? '']),
      ...amazon.map((a) => [a.sku, modelOf.get(a.sku) ?? '', `Amazon ${String(a.marketplace).toUpperCase()}`, a.seller_sku ?? '', 'seller sku',
        a.asin ? `ASIN ${a.asin}` : '', [a.status, a.fulfillment].filter(Boolean).join(' · ')]),
      ...wix.map((w) => [w.sku, modelOf.get(w.sku) ?? '', `Wix — ${w.site}`, w.wix_product_id ?? '', 'wix product id', '', w.synced_at ? `synced ${day(w.synced_at)}` : '']),
    ].sort((a, b) => a[0].localeCompare(b[0]) || a[2].localeCompare(b[2])),
  };

  // How a report goes back into the PIM (every kind's Notes say it).
  const howToUpdate = ['Updating the PIM with this file', `Change the cells you need on "${kind.sheet}" and upload the file in Import Products. Only the cells that differ from the PIM are updated: a product whose row changes nothing is not touched, and an empty cell never clears a value. Keep SKU, Brand and Category as they are — they tell the import which product a row is. The read-only columns (links, counts, IDs, completeness, stock, older fields) and the other sheets are not imported.`];

  // ---- A report by subject: its product sheet, its own extra sheet, its notes ----
  if (!whole) {
    const about = {
      prices: ['Prices', 'Blue = the regular level, Orange and Purple = the promotion levels. MAP and WC (wholesale cost) per channel, in CAD or USD as each header says. A product without a price on a level has that cell empty.'],
      attributes: ['Attributes', 'Each field of the product page\'s Overview and Specifications tabs. A field that does not apply to a product (a faucet field on a sink) stays empty.'],
      content: ['Content', 'Titles, descriptions, keywords and each bullet in its own column, in English and French. Descriptions are plain text here: one whose words do not change keeps its formatting in the PIM.'],
      images: ['Images', 'Counts per product and every image as a link, the main one first; the Media sheet lists every file with its type, language set (Universal = language-neutral), order and link. Images and documents are changed on the product page, not from this file.'],
      ids: ['Marketplace IDs', 'The retailer IDs the PIM keeps on the product can be changed here. The Aliases tab numbers, Amazon Seller SKUs / ASINs and the Wix products (the other columns and the Marketplace IDs sheet) are read-only: they are changed on the product page.'],
    }[kind.key];
    const subjectNotes = {
      name: 'Notes',
      title: `About this report — ${kind.label}`,
      widths: [30, 110],
      blocks: [{
        headers: ['Part', 'What it means'],
        formats: ['topic', 'wrap'],
        rows: [
          ['Generated', `${generatedOn}, read live from the PIM. It is a snapshot: later edits in the PIM are not reflected.`],
          [kind.sheet, `One row per product (${products.length}), by category then SKU. Row 1 names the section, row 2 the field; the filters are on row 2.`],
          about,
          ...(kind.key === 'images' ? [] : [howToUpdate]),
        ].filter(Boolean),
      }],
    };
    const extra = { media: mediaSheet, ids: idsSheet };
    return {
      sheets: [allProducts, ...kind.extra.map((k) => extra[k]).filter(Boolean), subjectNotes],
      products: products.length,
      columns: ordered.length,
      files: media.length,
      ids: idsSheet.rows.length,
    };
  }

  // ---- Summary ----
  // The completeness figures count what Listing Health scores: archived and
  // obsolete products are left out (user, 2026-10-16); the counts keep them.
  const scored = products.filter(inCompleteness);
  // a group with nothing scored has no average (blank, not 0%)
  const avg = (ps) => (ps.length ? ps.reduce((s, p) => s + score.get(p.sku).score, 0) / ps.length / 100 : '');
  const complete = (ps) => ps.filter((p) => score.get(p.sku).complete).length;
  const obsolete = (ps) => ps.filter((p) => p.is_obsolete).length;
  const count = (rows, type) => rows.filter((m) => m.media_type === type).length;
  const catRows = catOrder.map((cat) => {
    const ps = products.filter((p) => p.category === cat);
    if (!ps.length) return null;
    const inScore = ps.filter(inCompleteness);
    return [categoryName(cat), ps.length, ps.filter((p) => p.brand === 'Stylish').length, ps.filter((p) => p.brand === 'Azuni').length, obsolete(ps),
      avg(inScore), complete(inScore), ps.reduce((s, p) => s + imagesOf(p.sku).length, 0), ps.reduce((s, p) => s + docsOf(p.sku).length, 0),
      ps.filter((p) => stockOf(p.sku, 'ca')).length, ps.filter((p) => stockOf(p.sku, 'us')).length];
  }).filter(Boolean);
  const sum = (i) => catRows.reduce((s, r) => s + r[i], 0);
  const statusRows = [...groupBy(products, 'workflow_status')].map(([s, ps]) => [s ?? '—', ps.length]).sort((a, b) => b[1] - a[1]);
  const gaps = new Map();
  for (const p of scored) {
    for (const m of score.get(p.sku).missing) {
      const key = `${m.label}\u0000${m.tab}`;
      gaps.set(key, (gaps.get(key) ?? 0) + 1);
    }
  }
  const gapRows = [...gaps].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([key, n]) => {
    const [label, tab] = key.split('\u0000');
    return [label, TAB[tab] ?? tab, n];
  });
  const totals = [
    ['Products', products.length],
    ['Stylish', products.filter((p) => p.brand === 'Stylish').length],
    ['Azuni', products.filter((p) => p.brand === 'Azuni').length],
    ['Obsolete products', obsolete(products)],
    ['Average PIM completeness', avg(scored)],
    ['Products 100% complete', complete(scored)],
    ['Images', count(media, 'image')],
    ['Documents', count(media, 'document')],
    ['Videos', count(media, 'video')],
    ['Products with Canada stock tracked', products.filter((p) => stockOf(p.sku, 'ca')).length],
    ['Products with USA stock tracked', products.filter((p) => stockOf(p.sku, 'us')).length],
    ['Marketplace IDs (aliases, Amazon, Wix)', idsSheet.rows.length],
  ];
  const summary = {
    name: 'Summary',
    title: 'Stylish PIM — Full Product Report',
    subtitle: `Every product in the PIM, generated ${generatedOn}. A snapshot: later edits in the PIM are not in this file.`,
    widths: [40, 12, 12, 12, 12, 16, 16, 14, 14, 14, 14],
    blocks: [
      {
        title: 'Totals',
        headers: ['Measure', 'Value'],
        formats: ['text', 'count'],
        rows: totals,
        // the completeness row is a percentage
        rowFormats: { [totals.findIndex(([measure]) => measure === 'Average PIM completeness')]: ['text', 'percent'] },
      },
      {
        title: 'By category',
        headers: ['Category', 'Products', 'Stylish', 'Azuni', 'Obsolete', 'Avg completeness', '100% complete', 'Images', 'Documents', 'Stock CA tracked', 'Stock US tracked'],
        formats: ['text', 'count', 'count', 'count', 'count', 'percent', 'count', 'count', 'count', 'count', 'count'],
        rows: catRows,
        total: ['Total', sum(1), sum(2), sum(3), sum(4), avg(scored), sum(6), sum(7), sum(8), sum(9), sum(10)],
      },
      { title: 'By workflow status', headers: ['Status', 'Products'], formats: ['text', 'count'], rows: statusRows },
      {
        title: 'Most-missed PIM fields',
        note: "Each product's own gaps are in All Products → PIM Completeness. A field only counts where it applies (Listing Health → PIM rules).",
        headers: ['Field', 'Product tab', 'Products'],
        formats: ['text', 'center', 'count'],
        rows: gapRows,
      },
    ],
  };

  const notes = {
    name: 'Notes',
    title: 'About this report',
    widths: [30, 110],
    blocks: [{
      headers: ['Part', 'What it means'],
      formats: ['topic', 'wrap'],
      rows: [
        ['Generated', `${generatedOn}, read live from the PIM. It is a snapshot: later edits in the PIM are not reflected.`],
        ['All Products', `One row per product (${products.length}), by category then SKU. Row 1 names the section, row 2 the field; the filters are on row 2. The sections follow the product page and the PIM's import / export Excel, then what the PIM keeps besides: completeness, stock, media, marketplace IDs and the web store flags.`],
        ['Empty columns', 'A column is left out when no product has a value in it; an empty cell means the field is not filled for that product.'],
        ['Prices', 'Blue = the regular level, Orange and Purple = the promotion levels. MAP and WC (wholesale cost) per channel, in CAD or USD as each header says.'],
        ['Descriptions', 'Plain text (the formatting of the product page is removed). Each bullet has its own column. Uploaded back, a description whose words did not change keeps its formatting in the PIM.'],
        ['PIM Completeness', "The same score as Listing Health → PIM: only the fields that apply to the product count. 'Missing' lists each gap and, for a value that is filled but wrong, the reason."],
        ['Obsolete', "A mark of its own (Status & Dates, Yes / No), apart from the workflow status: it changes no listing, channel push or marketplace file. Obsolete products keep their own score in All Products but, like archived ones, are left out of the Summary's completeness figures, as in Listing Health."],
        ['Stock', "Odoo's Available for Use: Canada = warehouse CBG, USA = warehouse ATL. An empty cell means Odoo does not have the product, so it is not tracked (not 0)."],
        ['Images & Documents', "Counts per product; the Media sheet lists every file with its type, language set (Universal = language-neutral), order and link. Videos and documents are shared by a family's products."],
        ['Marketplace IDs', "The product's Aliases tab (retailer item numbers), the Amazon Seller SKUs and ASINs, and the product of each Wix website — one row per ID."],
        ['Other / Older Fields', 'Values stored on products by earlier imports that the app no longer reads, kept as they are. The current field with the same meaning is in its own section.'],
        ['Not included', "Wix's own copy of each product (raw data, additional-info sections), price history and the activity log."],
        howToUpdate,
      ],
    }],
  };

  return { sheets: [summary, allProducts, mediaSheet, idsSheet, notes], products: products.length, columns: ordered.length, files: media.length, ids: idsSheet.rows.length };
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Builds and downloads a report (`kind`: a key of pimReportKinds.js, the
 * complete one by default); returns what it holds. `task` (optional
 * taskProgress reporter): loading 45%, the sheets 10%, writing 45%.
 */
export async function generatePimReport({ task = null, kind = 'complete' } = {}) {
  const which = reportKind(kind);
  const data = await loadReportData(task?.part(0, 0.45), which);
  if (!data.products.length) throw new Error('The catalog has no products.');
  const date = new Date().toISOString().slice(0, 10);
  if (task) await task.step(`Building the sheets for ${data.products.length} products…`);
  const { sheets, products, columns, files, ids } = pimReportSheets(data, date, which.key);
  task?.progress(0.55);
  downloadBlob(await buildSectionedWorkbook(sheets, { task: task?.part(0.55, 1) }), `Stylish_PIM_${which.file}_${date}.xlsx`);
  return { kind: which.key, label: which.label, products, columns, files, ids };
}
