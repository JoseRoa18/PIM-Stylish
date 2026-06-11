// Quick inspection helper: node scripts/inspect-products.mjs SKU1 SKU2 ...
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of readFileSync(resolve(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const base = env.VITE_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const skus = process.argv.slice(2);
if (skus.length === 0) {
  console.error('Usage: node scripts/inspect-products.mjs SKU1 SKU2 ...');
  process.exit(1);
}

const res = await fetch(
  `${base}/rest/v1/products?sku=in.(${skus.map(encodeURIComponent).join(',')})&select=sku,model_name,material,finish,color,attributes`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } },
);
if (!res.ok) {
  console.error(`Fetch failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
for (const p of await res.json()) {
  console.log(`${p.sku} | ${p.model_name}`);
  console.log(`  material: ${JSON.stringify(p.material)}  finish: ${JSON.stringify(p.finish)}  color: ${JSON.stringify(p.color)}`);
  const a = p.attributes ?? {};
  console.log(`  gauge: ${JSON.stringify(a.gauge)}  bowls: ${JSON.stringify(a.number_of_bowls)}  config: ${JSON.stringify(a.bowl_configuration)}`);
}
