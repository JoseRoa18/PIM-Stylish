// Load a price list into one products price column from a TSV:
//   SKU<tab>PRICE   (one per line; $ signs and thousands commas tolerated)
//
//   node scripts/load-price-list.mjs <file.tsv> --column map_usd           # dry run
//   node scripts/load-price-list.mjs <file.tsv> --column map_usd --apply   # write
//
// Pricing is per-market (USA in USD, Canada in CAD). Both markets carry
// MSRP and MAP (the CAD MAP covers all marketplaces); costs are per channel
// group — three US lists, two Canadian lists:
//   msrp_usd | map_usd | cost_usd_lowes_sod_bbb | cost_usd_wayfair | cost_usd_menards
//   msrp_cad | map_cad | cost_cad_rona_hd | cost_cad_wayfair_sod
//
// SKUs match EXACTLY: dashed and dashless SKUs (A-906 vs A906) are different
// brands and price lists carry both. Rows whose SKU isn't in the PIM are
// reported, never created.

import { readFileSync } from 'node:fs';

const COLUMNS = [
  'msrp_usd', 'map_usd', 'cost_usd_lowes_sod_bbb', 'cost_usd_wayfair', 'cost_usd_menards',
  'msrp_cad', 'map_cad', 'cost_cad_rona_hd', 'cost_cad_wayfair_sod',
];

function readEnv(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const env = readEnv('.env.local');
const secrets = readEnv('.env.secrets.local');
const URL_BASE = env.VITE_SUPABASE_URL;
const SR = secrets.SR_KEY;
const HEADERS = { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' };

const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
const column = process.argv[process.argv.indexOf('--column') + 1];
if (!file || !COLUMNS.includes(column)) {
  console.error(`usage: node scripts/load-price-list.mjs <file.tsv> --column <${COLUMNS.join('|')}> [--apply]`);
  process.exit(1);
}

const list = new Map();
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t) continue;
  const [sku, raw] = t.split('\t').map((x) => x?.trim());
  const price = Number(String(raw ?? '').replace(/[$,\s]/g, ''));
  if (!sku || !Number.isFinite(price)) {
    console.log(`  skipped unparseable line: ${t.slice(0, 60)}`);
    continue;
  }
  if (list.has(sku) && list.get(sku) !== price) {
    console.log(`  WARNING duplicate SKU with different price: ${sku} ${list.get(sku)} vs ${price} (keeping last)`);
  }
  list.set(sku, price);
}
console.log(`price list rows: ${list.size} → column ${column}`);

const res = await fetch(`${URL_BASE}/rest/v1/products?select=sku,${column}`, { headers: HEADERS });
const products = await res.json();
const pimValues = new Map(products.map((p) => [p.sku, p[column]]));

const toSet = [];
let unchanged = 0;
const notInPim = [];
for (const [sku, price] of list) {
  if (!pimValues.has(sku)) { notInPim.push(sku); continue; }
  if (Number(pimValues.get(sku)) === price) { unchanged += 1; continue; }
  toSet.push({ sku, price });
}
const pimWithout = products.filter((p) => p[column] == null && !list.has(p.sku)).map((p) => p.sku);

console.log(`to write: ${toSet.length} | already equal: ${unchanged}`);
console.log(`list SKUs not in PIM (${notInPim.length}):`, notInPim.join(' '));
console.log(`PIM products this list leaves without ${column} (${pimWithout.length}):`, pimWithout.join(' '));

if (!APPLY) {
  console.log('\nDry run — re-run with --apply to write.');
  process.exit(0);
}

// Group by price so each PATCH covers every SKU sharing that value.
const byPrice = new Map();
for (const { sku, price } of toSet) {
  if (!byPrice.has(price)) byPrice.set(price, []);
  byPrice.get(price).push(sku);
}
let written = 0;
for (const [price, skus] of byPrice) {
  for (let i = 0; i < skus.length; i += 80) {
    const chunk = skus.slice(i, i + 80);
    const r = await fetch(
      `${URL_BASE}/rest/v1/products?sku=in.(${chunk.map((x) => `"${x}"`).join(',')})`,
      { method: 'PATCH', headers: HEADERS, body: JSON.stringify({ [column]: price }) },
    );
    if (!r.ok) throw new Error(`patch ${r.status}: ${await r.text()}`);
    written += chunk.length;
  }
}
console.log(`written: ${written}`);
