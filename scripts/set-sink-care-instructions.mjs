/**
 * Fill in Care Instructions (attributes.product_care) on every sink.
 *
 * The care text is a property of the MATERIAL, not of the SKU. The supplier
 * sheet this came from proved it: across 92 filled-in rows no wording ever
 * crossed a material boundary. What it did have was drift — four different
 * wordings of the same advice for stainless steel, all on the same
 * `Brushed Stainless Steel` finish — plus 41 blank rows and stray leading
 * whitespace. So instead of importing the sheet row by row, this writes one
 * canonical text per material, which also covers the blanks and the six
 * granite variants the sheet never listed.
 *
 * Scoped to sinks on purpose: 106 non-sink products share these materials
 * (71 kitchen faucets among them) and must NOT be told to use a sink grid.
 *
 * Usage:
 *   node scripts/set-sink-care-instructions.mjs           → preview only
 *   node scripts/set-sink-care-instructions.mjs --apply   → write
 *
 * Reads VITE_SUPABASE_URL from .env.local and the service_role key from
 * SUPABASE_SERVICE_ROLE_KEY (.env.local) or SR_KEY (.env.secrets.local).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const env = {};
for (const file of ['.env.local', '.env.secrets.local']) {
  const p = resolve(root, file);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const BASE = env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SR_KEY;
if (!BASE || !KEY) {
  console.error('Missing VITE_SUPABASE_URL or the service_role key.');
  process.exit(1);
}
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const APPLY = process.argv.includes('--apply');

// One canonical text per material. Materials not listed here are left alone.
const CARE_BY_MATERIAL = {
  'Stainless Steel':
    'Rinse and dry your sink with a soft cloth, following the grain. Use a mild '
    + 'water and vinegar solution to remove mineral deposits. Avoid harsh cleaners '
    + "with chlorine or acids to preserve the sink's appearance. Rinse thoroughly "
    + 'and dry after cleaning. Consider using a stainless steel grid to prevent scratches.',
  'Composite Granite':
    'Wash with warm water and mild dish soap using a sponge, then rinse and dry '
    + 'with a soft cloth. Apply a little mineral oil occasionally to restore shine.',
  Porcelain:
    'Clean with a soft cloth and mild soap or a non-abrasive bathroom cleaner. '
    + 'Rinse and dry after use to prevent water spots. Avoid abrasive pads, scouring '
    + 'powders, and cleaners containing bleach, ammonia or acids, which can dull the glaze.',
};

async function fetchAllSinks() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(
      `${BASE}/rest/v1/products?select=sku,category,material,attributes`,
      { headers: { ...HEADERS, Range: `${from}-${from + 999}` } },
    );
    if (!res.ok) throw new Error(`products fetch failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out.filter((p) => p.category?.includes('sink'));
}

const sinks = await fetchAllSinks();
console.log(`Sinks in the catalog: ${sinks.length}\n`);

const planned = [];
const skipped = new Map();

for (const p of sinks) {
  const text = CARE_BY_MATERIAL[p.material];
  if (!text) {
    const k = p.material ?? '(no material)';
    skipped.set(k, (skipped.get(k) ?? 0) + 1);
    continue;
  }
  const current = p.attributes?.product_care ?? null;
  if (current === text) continue; // already correct — nothing to write
  planned.push({ sku: p.sku, material: p.material, attributes: p.attributes ?? {}, text, current });
}

const byMaterial = new Map();
for (const p of planned) {
  if (!byMaterial.has(p.material)) byMaterial.set(p.material, { fresh: 0, overwrite: 0 });
  const e = byMaterial.get(p.material);
  if (p.current) e.overwrite += 1;
  else e.fresh += 1;
}

console.log('Planned writes');
console.log('  material               new   replacing   total');
for (const [m, e] of [...byMaterial].sort((a, b) => (b[1].fresh + b[1].overwrite) - (a[1].fresh + a[1].overwrite))) {
  console.log(`  ${m.padEnd(22)}${String(e.fresh).padStart(5)}${String(e.overwrite).padStart(12)}${String(e.fresh + e.overwrite).padStart(8)}`);
}
console.log(`  ${'TOTAL'.padEnd(22)}${String(planned.length).padStart(25)}`);

if (skipped.size) {
  console.log('\nLeft untouched (no canonical text for this material)');
  for (const [m, n] of skipped) console.log(`  ${String(m).padEnd(22)}${String(n).padStart(5)}`);
}

console.log('\nText per material');
for (const [m, t] of Object.entries(CARE_BY_MATERIAL)) {
  console.log(`\n  ${m} (${t.length} chars)`);
  console.log(`    ${t}`);
}

if (!APPLY) {
  console.log('\n--- preview only. Re-run with --apply to write. ---');
  process.exit(0);
}

console.log('\nWriting…');
let done = 0;
let failed = 0;
for (const p of planned) {
  // Merge into the existing attributes object so nothing else is dropped.
  const next = { ...p.attributes, product_care: p.text };
  const res = await fetch(`${BASE}/rest/v1/products?sku=eq.${encodeURIComponent(p.sku)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify({ attributes: next }),
  });
  if (res.ok) {
    done += 1;
    if (done % 25 === 0) console.log(`  ${done}/${planned.length}`);
  } else {
    failed += 1;
    console.error(`  FAILED ${p.sku}: ${res.status} ${await res.text()}`);
  }
}
console.log(`\nDone. ${done} updated, ${failed} failed.`);

// Read back and confirm what actually landed.
const after = await fetchAllSinks();
const counts = new Map();
for (const p of after) {
  const ok = p.attributes?.product_care === CARE_BY_MATERIAL[p.material];
  const k = `${p.material ?? '(none)'} ${ok ? 'ok' : 'MISSING/other'}`;
  counts.set(k, (counts.get(k) ?? 0) + 1);
}
console.log('\nVerification (re-read from the database)');
for (const [k, n] of [...counts].sort()) console.log(`  ${k.padEnd(34)}${String(n).padStart(5)}`);
