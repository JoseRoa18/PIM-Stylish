// Survey distinct values of normalizable fields across the catalog.
// Usage: node scripts/survey-values.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of readFileSync(resolve(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const res = await fetch(
  `${env.VITE_SUPABASE_URL}/rest/v1/products?select=sku,material,finish,color,attributes&limit=10000`,
  { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } },
);
if (!res.ok) {
  console.error(await res.text());
  process.exit(1);
}
const products = await res.json();
console.log(`${products.length} products\n`);

const COLUMNS = ['material', 'finish', 'color'];
const ATTRS = [
  'sink_shape', 'bowl_configuration', 'basin_split', 'installation_type',
  'drain_hole_location', 'craftsmanship', 'country_of_origin', 'gauge',
];

function tally(label, getter) {
  const counts = new Map();
  for (const p of products) {
    const v = getter(p);
    if (v == null || v === '') continue;
    const key = String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log(`── ${label} ──`);
  for (const [v, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${JSON.stringify(v)}`);
  }
  console.log();
}

for (const c of COLUMNS) tally(c, (p) => p[c]);
for (const a of ATTRS) tally(`attributes.${a}`, (p) => p.attributes?.[a]);
