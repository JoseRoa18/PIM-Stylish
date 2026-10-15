import { supabase } from '@/lib/supabase';
import {
  normalizeHeader,
  BULLET_RE,
  defForHeader,
  templateLayout,
  TEMPLATE_HEADERS,
  BATH_SINK_TEMPLATE_HEADERS,
  FAUCET_TEMPLATE_HEADERS,
  BATH_FAUCET_TEMPLATE_HEADERS,
  CUTTING_BOARD_TEMPLATE_HEADERS,
  ACCESSORY_TEMPLATE_HEADERS,
  DRAIN_TEMPLATE_HEADERS,
  STRAINER_TEMPLATE_HEADERS,
  FAUCET_PLATE_TEMPLATE_HEADERS,
  COLANDER_TEMPLATE_HEADERS,
} from '@/features/import/lib/importSchema';
import { buildSectionedWorkbook } from '@/features/import/lib/sectionedXlsx';
import { accessoryKind } from '@/features/templates/api/templates';
import { channelCategory } from '@/features/products/lib/categories';

// Exports products back into the PIM's OWN category templates (the same
// sectioned layout the bulk upload downloads and accepts), filled from the
// database — the exact inverse of the import mapping, so an exported file
// re-imports cleanly. One .xlsx, one sheet per category (user, 2026-10-15:
// "seccionalo"; it was one CSV per category in a ZIP).

// category → template headers. Accessories split further by kind.
const CATEGORY_HEADERS = {
  kitchen_sink: TEMPLATE_HEADERS,
  outdoor_sink: TEMPLATE_HEADERS,
  bar_prep_sink: TEMPLATE_HEADERS,
  laundry_sink: TEMPLATE_HEADERS,
  bathroom_sink: BATH_SINK_TEMPLATE_HEADERS,
  kitchen_faucet: FAUCET_TEMPLATE_HEADERS,
  kitchen_faucet_combo: FAUCET_TEMPLATE_HEADERS,
  cold_water_tap: FAUCET_TEMPLATE_HEADERS,
  pot_filler: FAUCET_TEMPLATE_HEADERS,
  bathroom_faucet: BATH_FAUCET_TEMPLATE_HEADERS,
  colander_drying_rack: COLANDER_TEMPLATE_HEADERS,
};
const ACCESSORY_KIND_HEADERS = {
  'cutting board': CUTTING_BOARD_TEMPLATE_HEADERS,
  strainer: STRAINER_TEMPLATE_HEADERS,
  drain: DRAIN_TEMPLATE_HEADERS,
  'faucet plate': FAUCET_PLATE_TEMPLATE_HEADERS,
};

// The Category cell must round-trip through the importer's CATEGORY_MAP.
const CATEGORY_LABELS = {
  kitchen_sink: 'Kitchen Sink',
  bathroom_sink: 'Bathroom Sink',
  kitchen_faucet: 'Kitchen Faucet',
  kitchen_faucet_combo: 'Kitchen Faucet Combo',
  cold_water_tap: 'Cold Water Tap',
  bathroom_faucet: 'Bathroom Faucet',
  pot_filler: 'Pot Filler',
  bar_prep_sink: 'Bar Prep Sink',
  laundry_sink: 'Laundry Sink',
  outdoor_sink: 'Outdoor Sink',
  colander_drying_rack: 'Colanders & Drying Racks',
  accessory: 'Accessory',
};

// The sheet each group lands on.
const SHEET_NAMES = {
  kitchen_sink: 'Kitchen Sinks',
  bar_prep_sink: 'Bar & Prep Sinks',
  laundry_sink: 'Laundry Sinks',
  outdoor_sink: 'Outdoor Sinks',
  bathroom_sink: 'Bathroom Sinks',
  kitchen_faucet: 'Kitchen Faucets',
  kitchen_faucet_combo: 'Kitchen Faucet Combos',
  cold_water_tap: 'Cold Water Taps',
  pot_filler: 'Pot Fillers',
  bathroom_faucet: 'Bathroom Faucets',
  colander_drying_rack: 'Colanders & Drying Racks',
  'accessory cutting board': 'Cutting Boards',
  'accessory strainer': 'Strainers',
  'accessory drain': 'Drains',
  'accessory faucet plate': 'Faucet Plates',
  'accessory soap dispenser': 'Soap Dispensers',
  'accessory grid': 'Grids',
  'accessory other': 'Other Accessories',
};
const SHEET_ORDER = Object.keys(SHEET_NAMES);

// Descriptions are stored as TipTap HTML; the sheet gets plain text with line
// breaks. This is also the correct import inverse — the importer converts
// plain text back into HTML paragraphs (raw HTML would get double-escaped).
const stripHtml = (h) =>
  String(h || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\n{2,}/g, '\n')
    .trim();

const NUMERIC = new Set(['number', 'int', 'money']);
// A cell's value: a number stays a number (prices, sizes), a list reads
// "a; b", a yes / no reads Yes / No.
function cellValue(product, header) {
  const nh = normalizeHeader(header);

  const bullet = nh.match(BULLET_RE);
  if (bullet) {
    const key = bullet[2] === 'fr' ? 'bullet_points_fr' : 'bullet_points';
    const list = product.attributes?.[key];
    return Array.isArray(list) ? (list[Number(bullet[1]) - 1] ?? '') : '';
  }

  const def = defForHeader(header);
  if (!def) return '';
  if (def.type === 'category') return CATEGORY_LABELS[product.category] ?? product.category ?? '';

  const t = def.target;
  const raw = t.col
    ? product[t.col]
    : t.attr
      ? product.attributes?.[t.attr]
      : t.dim
        ? product.attributes?.[t.dim[0]]?.[t.dim[1]]
        : '';
  if (raw == null || raw === '') return '';
  if (def.type === 'description') return stripHtml(raw);
  if (NUMERIC.has(def.type) && raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
  if (Array.isArray(raw)) return raw.join('; ');
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  return String(raw);
}

// Colanders and racks filed as Accessories keep the colander sheet (channelCategory).
const groupKeyOf = (p) =>
  channelCategory(p) === 'accessory' ? `accessory ${accessoryKind(p) ?? 'other'}` : (channelCategory(p) ?? 'uncategorized');

const headersFor = (p) => {
  if (channelCategory(p) === 'accessory') {
    return ACCESSORY_KIND_HEADERS[accessoryKind(p)] ?? ACCESSORY_TEMPLATE_HEADERS;
  }
  return CATEGORY_HEADERS[channelCategory(p)] ?? TEMPLATE_HEADERS;
};

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

/** Every product in the catalog — paginated past PostgREST's ~1000-row cap. */
export async function fetchAllProducts() {
  const PAGE = 1000;
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('sku')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

/** The export's sheets, in SHEET_ORDER: [{ name, sections, rows, count }]. */
export function pimExportSheets(products) {
  const groups = new Map(); // group key → products[]
  for (const p of products) {
    const key = groupKeyOf(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const rank = (k) => (SHEET_ORDER.includes(k) ? SHEET_ORDER.indexOf(k) : SHEET_ORDER.length);
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([key, list]) => {
      const sections = templateLayout(headersFor(list[0]));
      const headers = sections.flatMap((s) => s.headers);
      const rows = [...list].sort((a, b) => a.sku.localeCompare(b.sku)).map((p) => headers.map((h) => cellValue(p, h)));
      return { key, name: SHEET_NAMES[key] ?? key, sections, rows, count: list.length };
    });
}

/**
 * Export products into the PIM's category templates: one sectioned .xlsx,
 * one sheet per category (accessories split by kind).
 */
export async function generatePimExport(products) {
  if (!products?.length) throw new Error('No products to export.');
  const sheets = pimExportSheets(products);
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(await buildSectionedWorkbook(sheets), `Stylish_PIM_Export_${date}.xlsx`);
  return {
    count: products.length,
    files: 1,
    sheets: sheets.length,
    categories: sheets.map((s) => s.name),
  };
}
