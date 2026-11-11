import { FIELD_DEFS } from './importSchema';

// What an import row would CHANGE on a product the PIM already has (user,
// 2026-11-11: a report must be importable and "que actualice aquellos datos
// nuevos"). A file re-imported as it was downloaded changes nothing; a row
// writes only the fields whose value differs, and a row that changes nothing
// is not written at all.
//
// Two values are the same when they read the same: spaces around or doubled
// do not count, a number is a number however it is written ("65.0" = 65), a
// yes / no is a yes / no, a list is its items whatever separates them, and a
// description is its words whatever its formatting (the sheet holds it as
// plain text, the PIM as formatted text). An empty cell never reaches here:
// it clears nothing.

const DEF = { col: new Map(), attr: new Map(), dim: new Map() };
for (const def of FIELD_DEFS) {
  const t = def.target;
  if (t.col) { if (!DEF.col.has(t.col)) DEF.col.set(t.col, def); }
  else if (t.attr) { if (!DEF.attr.has(t.attr)) DEF.attr.set(t.attr, def); }
  else if (t.dim) { if (!DEF.dim.has(t.dim.join('.'))) DEF.dim.set(t.dim.join('.'), def); }
}

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
const text = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : null;
};
const YES_NO = { yes: true, true: true, no: false, false: false };
const bool = (v) => (typeof v === 'boolean' ? v : typeof v === 'string' ? YES_NO[v.trim().toLowerCase()] : undefined);
// a list's items, whatever holds them: an array, or "a; b" in one text
const items = (v) => (Array.isArray(v) ? v : [v]).flatMap((x) => String(x ?? '').split(/[;,\n]/)).map(text).filter(Boolean);
// a description's words, whatever its HTML
const words = (html) => text(String(html ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'"));

/** Do the stored value and the file's value read the same? `type` = the field's import type. */
export function sameValue(stored, incoming, type = null) {
  if (isEmpty(stored) && isEmpty(incoming)) return true;
  if (isEmpty(stored) || isEmpty(incoming)) return false;
  if (type === 'description') return words(stored) === words(incoming);
  if (type === 'date') return String(stored).slice(0, 10) === String(incoming).slice(0, 10);
  if (Array.isArray(stored) || Array.isArray(incoming)) {
    // Bullets are whole sentences (their commas are text); other lists are items.
    if (type === 'bullets') {
      const a = [].concat(stored).map(text).filter(Boolean);
      const b = [].concat(incoming).map(text).filter(Boolean);
      return a.length === b.length && a.every((v, i) => v === b[i]);
    }
    const a = items(stored);
    const b = items(incoming);
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  if (typeof stored === 'boolean' || typeof incoming === 'boolean') {
    const a = bool(stored);
    const b = bool(incoming);
    if (a !== undefined && b !== undefined) return a === b;
  }
  const a = num(stored);
  const b = num(incoming);
  if (a != null && b != null) return Math.abs(a - b) < 1e-9;
  return text(stored) === text(incoming);
}

const shown = (v) => {
  if (isEmpty(v)) return '';
  if (Array.isArray(v)) return v.map(text).join('; ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return text(v);
};
const BULLETS = { bullet_points: 'Bullets (EN)', bullet_points_fr: 'Bullets (FR)' };
const isGroup = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * What the row would change on the product:
 * [{ key, label, from, to }] — `key` is `col:<column>`, `attr:<attribute>` or
 * `dim:<group>.<axis>`; `from` / `to` are texts to show ('' = empty).
 */
export function rowChanges(row, product) {
  const out = [];
  for (const [col, value] of Object.entries(row.columns ?? {})) {
    if (col === 'sku') continue; // the key, not a field
    const def = DEF.col.get(col);
    if (sameValue(product?.[col], value, def?.type)) continue;
    const view = def?.type === 'description' ? words : shown;
    out.push({ key: `col:${col}`, label: def?.label ?? col, from: view(product?.[col]), to: view(value) });
  }
  const before = product?.attributes ?? {};
  for (const [name, value] of Object.entries(row.attributes ?? {})) {
    if (isGroup(value)) {
      // a dimension group: axis by axis, so an axis the file lacks stays
      const had = isGroup(before[name]) ? before[name] : {};
      for (const [axis, v] of Object.entries(value)) {
        if (sameValue(had[axis], v)) continue;
        out.push({ key: `dim:${name}.${axis}`, label: DEF.dim.get(`${name}.${axis}`)?.label ?? `${name} ${axis}`, from: shown(had[axis]), to: shown(v) });
      }
      continue;
    }
    const def = DEF.attr.get(name);
    if (sameValue(before[name], value, BULLETS[name] ? 'bullets' : def?.type)) continue;
    out.push({ key: `attr:${name}`, label: BULLETS[name] ?? def?.label ?? name, from: shown(before[name]), to: shown(value) });
  }
  return out;
}

/**
 * The update for a product the PIM has: only the fields the row changes
 * (attributes merged into the product's own, a dimension group axis by axis),
 * or null when the row changes nothing.
 */
export function updatePatch(row, product) {
  const changes = rowChanges(row, product);
  if (!changes.length) return null;
  const patch = {};
  let attributes = null;
  for (const c of changes) {
    const cut = c.key.indexOf(':');
    const kind = c.key.slice(0, cut);
    const name = c.key.slice(cut + 1);
    if (kind === 'col') {
      patch[name] = row.columns[name];
      continue;
    }
    attributes ??= { ...(product?.attributes ?? {}) };
    if (kind === 'attr') {
      attributes[name] = row.attributes[name];
    } else {
      const [group, axis] = name.split('.');
      attributes[group] = { ...(isGroup(attributes[group]) ? attributes[group] : {}), [axis]: row.attributes[group][axis] };
    }
  }
  if (attributes) patch.attributes = attributes;
  return patch;
}
