import {
  FIELD_DEFS,
  ALIAS_LOOKUP,
  BULLET_RE,
  CATEGORY_MAP,
  VALUE_CANONICALS,
  normalizeHeader,
} from './importSchema';

const EMPTY_VALUES = new Set(['', 'n/a', 'na', '#n/a', '#n/d', '-', '—', 'null', 'none']);

function cleanText(raw) {
  const s = String(raw ?? '').trim();
  return EMPTY_VALUES.has(s.toLowerCase()) ? null : s;
}

function coerce(type, raw) {
  const s = cleanText(raw);
  if (s === null) return null;

  switch (type) {
    case 'text':
      return s;
    case 'int': {
      const n = parseInt(s.replace(/[^\d-]/g, ''), 10);
      return isNaN(n) ? null : n;
    }
    case 'number': {
      // Tolerates "10mm", "R10", "3.5\"", "1,5"
      const cleaned = s.replace(',', '.').replace(/[^\d.-]/g, '');
      const n = parseFloat(cleaned);
      return isNaN(n) ? null : n;
    }
    case 'bool': {
      const l = s.toLowerCase();
      if (['yes', 'y', 'true', '1', 'si', 'sí'].includes(l)) return true;
      if (['no', 'n', 'false', '0'].includes(l)) return false;
      return null;
    }
    case 'list':
      return s.split(/[;,\n]/).map((x) => x.trim()).filter(Boolean);
    case 'upc': {
      // Excel often mangles UPCs into scientific notation (8.40994E+11).
      if (/^\d+(\.\d+)?e\+?\d+$/i.test(s)) return Number(s).toFixed(0);
      return s.replace(/\.0+$/, '');
    }
    case 'category': {
      const mapped = CATEGORY_MAP[s.toLowerCase()];
      return mapped ?? null;
    }
    case 'date': {
      // Already ISO → keep. Excel serial number → convert. Otherwise best-effort
      // parse; anything unrecognized is dropped (null) rather than risking a bad
      // insert into a DATE column.
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      if (/^\d+(\.\d+)?$/.test(s)) {
        const serial = parseFloat(s);
        const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
        return new Date(ms).toISOString().slice(0, 10);
      }
      const t = Date.parse(s);
      return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
    }
    case 'description': {
      // Plain text → simple HTML paragraphs (matches how descriptions are stored)
      const escaped = s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return escaped
        .split(/\n{2,}/)
        .map((p) => `<p>${p.replace(/\n/g, ' ').trim()}</p>`)
        .join('');
    }
    default:
      return s;
  }
}

/**
 * Maps raw parsed rows into import-ready product rows with per-row validation
 * and completeness info.
 */
export function buildImportRows(parsed) {
  const { headers, rows } = parsed;

  // Resolve each spreadsheet header to a field def (or bullet slot)
  const headerMap = [];
  const unknownHeaders = [];
  const matchedFieldKeys = new Set();

  for (const h of headers) {
    const norm = normalizeHeader(h);
    const bullet = norm.match(BULLET_RE);
    if (bullet) {
      headerMap.push({ header: h, bullet: { index: parseInt(bullet[1], 10), lang: bullet[2] } });
      matchedFieldKeys.add(`bullets_${bullet[2]}`);
      continue;
    }
    const def = ALIAS_LOOKUP.get(norm);
    if (def) {
      headerMap.push({ header: h, def });
      matchedFieldKeys.add(def.key);
    } else {
      unknownHeaders.push(h);
    }
  }

  const seenSkus = new Set();
  const built = rows.map((raw, idx) => {
    const columns = {};
    const attributes = {};
    const dims = {};
    const bulletsEn = [];
    const bulletsFr = [];
    const errors = [];
    const filledLabels = new Set();
    const missingLabels = [];

    for (const entry of headerMap) {
      const rawVal = raw[entry.header];

      if (entry.bullet) {
        const text = cleanText(rawVal);
        if (text) {
          const target = entry.bullet.lang === 'en' ? bulletsEn : bulletsFr;
          target[entry.bullet.index - 1] = text;
        }
        continue;
      }

      const def = entry.def;
      let value = coerce(def.type, rawVal);

      // Snap known-dirty values to their canonical form (or drop them)
      const canon = VALUE_CANONICALS[def.key];
      if (canon && typeof value === 'string') {
        const mapped = canon[value.trim().toLowerCase()];
        if (mapped !== undefined) value = mapped;
      }

      if (value === null || (Array.isArray(value) && value.length === 0)) {
        // Category present-but-unmappable is an error, not just missing
        if (def.type === 'category' && cleanText(rawVal)) {
          errors.push(`Unknown category "${cleanText(rawVal)}"`);
        }
        continue;
      }

      filledLabels.add(def.label);
      if (def.target.col) columns[def.target.col] = value;
      else if (def.target.attr) attributes[def.target.attr] = value;
      else if (def.target.dim) {
        const [group, axis] = def.target.dim;
        if (!dims[group]) dims[group] = {};
        dims[group][axis] = value;
      }
    }

    // Assemble dimension groups
    for (const [group, obj] of Object.entries(dims)) {
      attributes[group] = obj;
    }

    // Bullets → compact arrays without holes
    const compactEn = bulletsEn.filter(Boolean);
    const compactFr = bulletsFr.filter(Boolean);
    if (compactEn.length > 0) {
      attributes.bullet_points = compactEn;
      filledLabels.add('Bullets (EN)');
    }
    if (compactFr.length > 0) {
      attributes.bullet_points_fr = compactFr;
      filledLabels.add('Bullets (FR)');
    }

    // Required checks
    const sku = columns.sku ?? null;
    if (!sku) errors.push('Missing Model Number (SKU)');
    else if (seenSkus.has(sku)) errors.push(`Duplicate SKU in file: ${sku}`);
    else seenSkus.add(sku);
    if (!columns.brand) errors.push('Missing Brand');
    if (!columns.category) {
      if (!errors.some((e) => e.startsWith('Unknown category'))) {
        errors.push('Missing Category');
      }
    }

    // Completeness: which expected fields are missing on this row
    for (const def of FIELD_DEFS) {
      if (!matchedFieldKeys.has(def.key)) continue; // column absent from the file entirely
      if (!filledLabels.has(def.label)) missingLabels.push(def.label);
    }
    if (matchedFieldKeys.has('bullets_en') && compactEn.length === 0) missingLabels.push('Bullets (EN)');
    if (matchedFieldKeys.has('bullets_fr') && compactFr.length === 0) missingLabels.push('Bullets (FR)');

    return {
      rowNumber: idx + 2, // 1-based + header row
      sku,
      columns,
      attributes,
      errors,
      filledCount: filledLabels.size,
      missing: missingLabels,
    };
  });

  return { rows: built, unknownHeaders, matchedFieldKeys };
}
