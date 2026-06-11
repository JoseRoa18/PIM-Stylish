/**
 * Regroup variant families strictly by base model number.
 *
 * Rule: base model = SKU prefix "LETTERS-DIGITS" (S-300XG → S-300).
 * Groups with 2+ products share a family_number; singletons get NULL.
 *
 * Usage:
 *   node scripts/fix-variant-families.mjs           → preview only
 *   node scripts/fix-variant-families.mjs --apply   → apply changes
 *
 * Requires VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const env = {};
  const text = readFileSync(resolve(root, '.env.local'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv();
const URL_BASE = env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_BASE || !KEY) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

async function fetchAllProducts() {
  const res = await fetch(
    `${URL_BASE}/rest/v1/products?select=sku,family_number,model_name&order=sku`,
    { headers },
  );
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function updateFamily(sku, family_number) {
  const res = await fetch(
    `${URL_BASE}/rest/v1/products?sku=eq.${encodeURIComponent(sku)}`,
    { method: 'PATCH', headers, body: JSON.stringify({ family_number }) },
  );
  if (!res.ok) throw new Error(`Update ${sku} failed: ${res.status} ${await res.text()}`);
}

const apply = process.argv.includes('--apply');

const products = await fetchAllProducts();
console.log(`Loaded ${products.length} products.\n`);

// Group by base model
const groups = new Map();
for (const p of products) {
  // Base model: letters + optional dash + digits (S-831WNK → S-831, C126L → C126)
  const m = p.sku.match(/^([A-Za-z]+-?\d+)/);
  const base = m ? m[1].toUpperCase() : null;
  if (!base) {
    console.warn(`  ! ${p.sku} doesn't match the LETTERS-DIGITS pattern — left untouched`);
    continue;
  }
  if (!groups.has(base)) groups.set(base, []);
  groups.get(base).push(p);
}

// Assign sequential family numbers to multi-product groups
const sorted = [...groups.keys()].sort();
let nextFamily = 1;
const plan = [];

for (const base of sorted) {
  const members = groups.get(base);
  const target = members.length >= 2 ? nextFamily++ : null;
  for (const p of members) {
    if (p.family_number !== target) {
      plan.push({ sku: p.sku, from: p.family_number, to: target });
    }
  }
  const label = target === null ? 'no family (single)' : `family ${target}`;
  console.log(`${base.padEnd(10)} → ${label.padEnd(20)} ${members.map((p) => p.sku).join(', ')}`);
}

console.log(`\n${plan.length} product(s) need a family change.`);

if (plan.length === 0) {
  console.log('Nothing to do — families already match the base-model rule.');
  process.exit(0);
}

if (!apply) {
  console.log('\nDry run only. Re-run with --apply to write these changes:');
  for (const c of plan) console.log(`  ${c.sku}: ${c.from ?? 'null'} → ${c.to ?? 'null'}`);
  process.exit(0);
}

console.log('\nApplying…');
for (const c of plan) {
  await updateFamily(c.sku, c.to);
  console.log(`  ✓ ${c.sku}: ${c.from ?? 'null'} → ${c.to ?? 'null'}`);
}
console.log('\nDone.');
