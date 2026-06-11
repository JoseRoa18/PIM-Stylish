/**
 * Normalize inconsistent field values across the catalog.
 *
 * Usage:
 *   node scripts/normalize-values.mjs           → preview only
 *   node scripts/normalize-values.mjs --apply   → apply changes
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of readFileSync(resolve(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const BASE = env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// ---- Canonical value maps (lowercased key → canonical value) ----

const COLUMN_MAPS = {
  material: {
    'stainless steel': 'Stainless Steel',
    't-304 stainless steel': 'Stainless Steel',
    'brushed stainless steel': 'Stainless Steel',
  },
  finish: {
    'brushed stainless steel': 'Brushed Stainless Steel',
    'brushed': 'Brushed Stainless Steel',
    'gray': 'Grey',
  },
  color: {
    'gray': 'Grey',
  },
};

// Attribute values: canonical string, or null to remove the key entirely
const ATTR_MAPS = {
  gauge: { 'no': null },
  basin_split: { 'does not apply': null },
  drain_hole_location: {
    'side drain/ reversible': 'Side Drain / Reversible',
    'side drain/reversible': 'Side Drain / Reversible',
    'center drain/ reversible': 'Center Drain / Reversible',
    'center drain/reversible': 'Center Drain / Reversible',
  },
};

const apply = process.argv.includes('--apply');

const res = await fetch(
  `${BASE}/rest/v1/products?select=sku,material,finish,color,attributes&limit=10000`,
  { headers },
);
if (!res.ok) { console.error(await res.text()); process.exit(1); }
const products = await res.json();
console.log(`Loaded ${products.length} products.\n`);

const changes = [];

for (const p of products) {
  const patch = {};
  const log = [];

  for (const [col, map] of Object.entries(COLUMN_MAPS)) {
    const cur = p[col];
    if (cur == null) continue;
    const target = map[String(cur).trim().toLowerCase()];
    if (target !== undefined && target !== cur) {
      patch[col] = target;
      log.push(`${col}: ${JSON.stringify(cur)} → ${JSON.stringify(target)}`);
    }
  }

  let attrsChanged = false;
  const attrs = { ...(p.attributes ?? {}) };
  for (const [key, map] of Object.entries(ATTR_MAPS)) {
    const cur = attrs[key];
    if (cur == null) continue;
    const target = map[String(cur).trim().toLowerCase()];
    if (target === undefined || target === cur) continue;
    if (target === null) {
      delete attrs[key];
      log.push(`attributes.${key}: ${JSON.stringify(cur)} → (removed)`);
    } else {
      attrs[key] = target;
      log.push(`attributes.${key}: ${JSON.stringify(cur)} → ${JSON.stringify(target)}`);
    }
    attrsChanged = true;
  }
  if (attrsChanged) patch.attributes = attrs;

  if (Object.keys(patch).length > 0) {
    changes.push({ sku: p.sku, patch, log });
  }
}

console.log(`${changes.length} product(s) need normalization.\n`);
for (const c of changes) {
  console.log(c.sku);
  for (const l of c.log) console.log(`   ${l}`);
}

if (changes.length === 0) process.exit(0);

if (!apply) {
  console.log('\nDry run only. Re-run with --apply to write these changes.');
  process.exit(0);
}

console.log('\nApplying…');
let done = 0;
for (let i = 0; i < changes.length; i += 5) {
  const batch = changes.slice(i, i + 5);
  await Promise.all(
    batch.map(async (c) => {
      const r = await fetch(`${BASE}/rest/v1/products?sku=eq.${encodeURIComponent(c.sku)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(c.patch),
      });
      if (!r.ok) throw new Error(`${c.sku}: ${r.status} ${await r.text()}`);
    }),
  );
  done += batch.length;
  console.log(`  ${done}/${changes.length}`);
}
console.log('Done.');
