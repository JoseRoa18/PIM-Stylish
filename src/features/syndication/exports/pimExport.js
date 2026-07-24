import { supabase } from '@/lib/supabase';
import { loadJSZip } from './templateFiller';
import {
  FIELD_DEFS,
  normalizeHeader,
  BULLET_RE,
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
import { accessoryKind } from '@/features/templates/api/templates';

// Exports products back into the PIM's OWN category templates (the same
// header sets the importer accepts), filled from the database — the exact
// inverse of the import mapping, so a exported file re-imports cleanly.
// One CSV per category; several categories bundle into a single ZIP.

// category → template headers. Accessories split further by kind.
const CATEGORY_HEADERS = {
  kitchen_sink: TEMPLATE_HEADERS,
  outdoor_sink: TEMPLATE_HEADERS,
  bar_prep_sink: TEMPLATE_HEADERS,
  bathroom_sink: BATH_SINK_TEMPLATE_HEADERS,
  kitchen_faucet: FAUCET_TEMPLATE_HEADERS,
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
  bathroom_faucet: 'Bathroom Faucet',
  pot_filler: 'Pot Filler',
  bar_prep_sink: 'Bar Prep Sink',
  outdoor_sink: 'Outdoor Sink',
  colander_drying_rack: 'Colanders & Drying Racks',
  accessory: 'Accessory',
};

// normalized header → field def (labels + every alias, first def wins —
// mirrors how the importer resolves columns).
const DEF_BY_HEADER = (() => {
  const map = new Map();
  for (const def of FIELD_DEFS) {
    for (const key of [normalizeHeader(def.label), ...def.aliases]) {
      if (!map.has(key)) map.set(key, def);
    }
  }
  return map;
})();

const fmt = (v) => {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) return v.join('; ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
};

function cellValue(product, header) {
  const nh = normalizeHeader(header);

  const bullet = nh.match(BULLET_RE);
  if (bullet) {
    const key = bullet[2] === 'fr' ? 'bullet_points_fr' : 'bullet_points';
    const list = product.attributes?.[key];
    return fmt(Array.isArray(list) ? list[Number(bullet[1]) - 1] : '');
  }

  const def = DEF_BY_HEADER.get(nh);
  if (!def) return ''; // informational column (Family #, retailer SKUs…)
  if (def.type === 'category') return CATEGORY_LABELS[product.category] ?? product.category ?? '';

  const t = def.target;
  if (t.col) return fmt(product[t.col]);
  if (t.attr) return fmt(product.attributes?.[t.attr]);
  if (t.dim) return fmt(product.attributes?.[t.dim[0]]?.[t.dim[1]]);
  return '';
}

// RFC-4180 CSV with BOM so Excel opens it as UTF-8.
function toCsv(headers, products) {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [headers.map(esc).join(',')];
  for (const p of products) {
    lines.push(headers.map((h) => esc(cellValue(p, h))).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const groupKeyOf = (p) =>
  p.category === 'accessory' ? `accessory ${accessoryKind(p) ?? 'other'}` : (p.category ?? 'uncategorized');

const headersFor = (p) => {
  if (p.category === 'accessory') {
    return ACCESSORY_KIND_HEADERS[accessoryKind(p)] ?? ACCESSORY_TEMPLATE_HEADERS;
  }
  return CATEGORY_HEADERS[p.category] ?? TEMPLATE_HEADERS;
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

/**
 * Export products into the PIM's category templates. One CSV per category
 * (accessories split by kind); multiple files bundle into one ZIP.
 */
export async function generatePimExport(products) {
  if (!products?.length) throw new Error('No products to export.');

  const groups = new Map(); // group key → products[]
  for (const p of products) {
    const key = groupKeyOf(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const date = new Date().toISOString().slice(0, 10);
  const files = [...groups.entries()].map(([key, list]) => {
    const slug = key.replace(/[^a-z0-9]+/gi, '_');
    return {
      name: `Stylish_PIM_${slug}_${date}.csv`,
      csv: toCsv(headersFor(list[0]), list),
      count: list.length,
      key,
    };
  });

  if (files.length === 1) {
    downloadBlob(new Blob([files[0].csv], { type: 'text/csv;charset=utf-8' }), files[0].name);
  } else {
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    for (const f of files) zip.file(f.name, f.csv);
    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'DEFLATE' });
    downloadBlob(blob, `Stylish_PIM_Export_${date}.zip`);
  }

  return {
    count: products.length,
    files: files.length,
    categories: [...groups.keys()],
  };
}
