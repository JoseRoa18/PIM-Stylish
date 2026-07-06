import { supabase } from '@/lib/supabase';
import { WAYFAIR_RULES, IMAGE_COL_RE, BULLET_COL_RE } from './wayfairMapping';

// xlsx loads on demand — only needed when a user actually exports.
async function loadXLSX() {
  const mod = await import('xlsx');
  return mod.default ?? mod;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Build displayName → Map(normalizedOption → exactOption) from the Valid Values
// sheet, so we can snap PIM values to the exact Wayfair option.
function buildValidMaps(XLSX, wb) {
  const vs = wb.Sheets['Valid Values'];
  if (!vs) return {};
  const grid = XLSX.utils.sheet_to_json(vs, { header: 1, defval: '' });
  const head = grid[0] || [];
  const maps = {};
  head.forEach((h, ci) => {
    if (!h) return;
    const m = new Map();
    for (let r = 1; r < grid.length; r++) {
      const v = grid[r][ci];
      if (v !== '') m.set(norm(v), v);
    }
    maps[h] = m;
  });
  return maps;
}

// Snap a (possibly semicolon-joined) value to the field's valid options.
function snap(value, validMap) {
  if (!validMap || value === '' || value == null) return value;
  return String(value)
    .split(';')
    .map((part) => {
      const t = part.trim();
      if (!t) return '';
      return validMap.get(norm(t)) ?? t;
    })
    .filter(Boolean)
    .join('; ');
}

async function fetchImagesBySku(skus) {
  const bySku = {};
  for (let i = 0; i < skus.length; i += 40) {
    const batch = skus.slice(i, i + 40);
    const { data } = await supabase
      .from('product_media')
      .select('sku, storage_path, is_primary, display_order')
      .in('sku', batch)
      .eq('media_type', 'image');
    for (const m of data ?? []) (bySku[m.sku] = bySku[m.sku] || []).push(m);
  }
  for (const k in bySku) {
    bySku[k].sort((a, b) => (b.is_primary - a.is_primary) || (a.display_order - b.display_order));
  }
  return bySku;
}

/**
 * Fill a Wayfair Product Addition template with the given products and trigger
 * a download of the completed .xlsx. One data row per product.
 *
 * @param {string} templateStoragePath  path in the `templates` bucket
 * @param {Object[]} products           full product rows (sku, brand, description, attributes, …)
 * @param {string} [fileName]           base name for the download
 */
export async function generateWayfairFromTemplate(templateStoragePath, products, fileName = 'Wayfair_Export') {
  if (!products?.length) throw new Error('No products to export.');

  const XLSX = await loadXLSX();

  const { data: blob, error } = await supabase.storage.from('templates').download(templateStoragePath);
  if (error) throw new Error(`Failed to download template: ${error.message}`);
  const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' });

  // The main data sheet is the one named like "653 - Kitchen Faucets".
  const mainName = wb.SheetNames.find((n) => /^\d+\s*-/.test(n));
  if (!mainName) throw new Error('Could not find the product sheet in the template.');
  const ws = wb.Sheets[mainName];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true });
  const names = grid[3] || []; // display-name header row
  const validMaps = buildValidMaps(XLSX, wb);

  const imgBySku = await fetchImagesBySku(products.map((p) => p.sku));

  const dataRows = products.map((p) => {
    const images = (imgBySku[p.sku] || []).map((m) => m.storage_path);
    const bullets = p.attributes?.bullet_points || [];
    return names.map((nm) => {
      if (!nm) return '';
      const img = IMAGE_COL_RE.exec(nm);
      if (img) return images[Number(img[1]) - 1] || '';
      const bul = BULLET_COL_RE.exec(nm);
      if (bul) return bullets[Number(bul[1]) - 1] || '';
      const rule = WAYFAIR_RULES[nm];
      if (!rule) return '';
      let v;
      try {
        v = rule(p);
      } catch {
        v = '';
      }
      if (v == null) return '';
      return validMaps[nm] ? snap(v, validMaps[nm]) : v;
    });
  });

  // Append data below the header block + example "Default Row" (rows 0–6).
  XLSX.utils.sheet_add_aoa(ws, dataRows, { origin: 7 });

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const url = URL.createObjectURL(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${fileName}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return { count: products.length };
}
