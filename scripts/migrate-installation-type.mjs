/**
 * Convert attributes.installation_type from "A; B" strings to arrays ["A","B"].
 *
 * Usage:
 *   node scripts/migrate-installation-type.mjs           → preview
 *   node scripts/migrate-installation-type.mjs --apply   → apply
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

const apply = process.argv.includes('--apply');

const res = await fetch(`${BASE}/rest/v1/products?select=sku,attributes&limit=10000`, { headers });
if (!res.ok) { console.error(await res.text()); process.exit(1); }
const products = await res.json();

const changes = [];
for (const p of products) {
  const cur = p.attributes?.installation_type;
  if (typeof cur !== 'string' || !cur.trim()) continue;
  const arr = cur.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  changes.push({
    sku: p.sku,
    from: cur,
    to: arr,
    attributes: { ...p.attributes, installation_type: arr },
  });
}

console.log(`${changes.length} product(s) to convert.\n`);
const sample = new Map();
for (const c of changes) {
  const k = c.from;
  if (!sample.has(k)) sample.set(k, { to: c.to, count: 0 });
  sample.get(k).count++;
}
for (const [from, { to, count }] of sample) {
  console.log(`  ${String(count).padStart(4)}× ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
}

if (changes.length === 0 || !apply) {
  if (changes.length > 0) console.log('\nDry run. Re-run with --apply to write.');
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
        body: JSON.stringify({ attributes: c.attributes }),
      });
      if (!r.ok) throw new Error(`${c.sku}: ${r.status} ${await r.text()}`);
    }),
  );
  done += batch.length;
}
console.log(`Done — ${done} updated.`);
