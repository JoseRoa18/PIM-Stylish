import { supabase } from '@/lib/supabase';
import {
  normalizeHeader,
  BULLET_RE,
  defForHeader,
  excelValidationFor,
  CATEGORY_LABELS,
  templateLayout,
  templateKindOf,
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
  imageLinkHeader,
} from '@/features/import/lib/importSchema';
import { listMediaFor, getMediaUrl } from '@/features/media/api/media';
import { buildSectionedWorkbook } from '@/features/import/lib/sectionedXlsx';
import { loadSuggestionLists } from '@/features/import/api/suggestionLists';
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

// The product's image links, the main one first, then in their order (user,
// 2026-10-16: "agregar los links de las imágenes"). Read-only in the sheet.
function imageLinks(media) {
  return (media ?? [])
    .filter((m) => m.media_type === 'image' && m.storage_path)
    .sort((a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)) || (a.display_order ?? 0) - (b.display_order ?? 0))
    .map((m) => getMediaUrl(m.storage_path));
}

/**
 * The export's sheets, in SHEET_ORDER: [{ name, sections, rows, count, formats }].
 * With `mediaBySku` (sku → media rows) each sheet ends with an "Images
 * (links)" section: Image 1 (the main), Image 2… as clickable links.
 */
export function pimExportSheets(products, mediaBySku = null) {
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
      const base = headersFor(list[0]);
      const sections = templateLayout(base);
      const headers = sections.flatMap((s) => s.headers);
      const sorted = [...list].sort((a, b) => a.sku.localeCompare(b.sku));
      let rows = sorted.map((p) => headers.map((h) => cellValue(p, h)));
      let formats;
      const links = mediaBySku ? sorted.map((p) => imageLinks(mediaBySku.get(p.sku))) : [];
      const most = Math.max(0, ...links.map((l) => l.length));
      if (most) {
        const imageHeaders = Array.from({ length: most }, (_, i) => imageLinkHeader(i + 1));
        sections.push({ key: 'images', title: 'Images (links)', color: '4E342E', headers: imageHeaders });
        rows = rows.map((r, i) => [...r, ...imageHeaders.map((_, k) => links[i][k] ?? '')]);
        formats = [...headers.map(() => null), ...imageHeaders.map(() => 'link')];
      }
      return { key, name: SHEET_NAMES[key] ?? key, kind: templateKindOf(base), sections, rows, formats, count: list.length };
    });
}

/**
 * Export products into the PIM's category templates: one sectioned .xlsx,
 * one sheet per category (accessories split by kind).
 */
export async function generatePimExport(products) {
  if (!products?.length) throw new Error('No products to export.');
  // the open fields' dropdowns list what the whole catalog uses
  const [mediaBySku, suggestions] = await Promise.all([listMediaFor(products.map((p) => p.sku)), loadSuggestionLists()]);
  const sheets = pimExportSheets(products, mediaBySku);
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(await buildSectionedWorkbook(sheets, { validationFor: (h, kind) => excelValidationFor(h, kind, suggestions) }), `Stylish_PIM_Export_${date}.xlsx`);
  return {
    count: products.length,
    files: 1,
    sheets: sheets.length,
    categories: sheets.map((s) => s.name),
  };
}
