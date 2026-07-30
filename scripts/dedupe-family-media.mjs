/**
 * Deduplicate family-shared media files (videos + documents).
 *
 * Since 2026-07-30 videos and documents are family-shared: one file in
 * Storage, one product_media row per variant pointing at the same URL.
 * Files uploaded BEFORE that were duplicated per variant. This script finds
 * those duplicates — same family, media_type video/document, same file_name
 * and file_size_bytes but different storage objects — keeps one copy,
 * repoints the other rows to it and deletes the redundant Storage files.
 *
 * Usage:
 *   node scripts/dedupe-family-media.mjs           → preview only
 *   node scripts/dedupe-family-media.mjs --apply   → apply changes
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
  console.error('Missing VITE_SUPABASE_URL or service_role key');
  process.exit(1);
}
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const PUBLIC_MARKER = '/storage/v1/object/public/';

async function fetchAll(pathAndQuery) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, {
      headers: { ...headers, Range: `${from}-${from + 999}` },
    });
    if (!res.ok) throw new Error(`${pathAndQuery}: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

function parseStorageObject(url) {
  if (typeof url !== 'string' || !url.includes(PUBLIC_MARKER)) return null;
  const rest = url.slice(url.indexOf(PUBLIC_MARKER) + PUBLIC_MARKER.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  return {
    bucket: rest.slice(0, slash),
    path: rest.slice(slash + 1).split('/').map(decodeURIComponent).join('/'),
  };
}

const fmt = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : (b / 1024 ** 2).toFixed(1) + ' MB');
const apply = process.argv.includes('--apply');

const products = await fetchAll('products?select=sku,family_number&family_number=not.is.null');
const famBySku = new Map(products.map((p) => [p.sku, p.family_number]));
console.log(`${products.length} products in ${new Set(famBySku.values()).size} families.\n`);

const media = await fetchAll(
  'product_media?select=id,sku,media_type,storage_path,file_name,file_size_bytes' +
    '&media_type=in.(video,document)&order=id',
);

// Group Supabase-hosted rows by (family, media_type, file_name, size).
const groups = new Map();
for (const m of media) {
  const fam = famBySku.get(m.sku);
  if (fam == null || !parseStorageObject(m.storage_path)) continue;
  const key = `${fam}|${m.media_type}|${m.file_name}|${m.file_size_bytes ?? '?'}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(m);
}

let bytesSaved = 0;
let filesRemoved = 0;
const plan = []; // { keepUrl, repointIds, deleteObjects }
for (const [key, rows] of groups) {
  const byUrl = new Map();
  for (const r of rows) {
    if (!byUrl.has(r.storage_path)) byUrl.set(r.storage_path, []);
    byUrl.get(r.storage_path).push(r);
  }
  if (byUrl.size < 2) continue; // already one object (or already deduped)

  const urls = [...byUrl.keys()].sort();
  const keepUrl = urls[0];
  const [, type, name, size] = key.split('|');
  const dupUrls = urls.slice(1);
  const repointIds = dupUrls.flatMap((u) => byUrl.get(u).map((r) => r.id));
  const sizeBytes = Number(size) || 0;
  bytesSaved += sizeBytes * dupUrls.length;
  filesRemoved += dupUrls.length;
  plan.push({ keepUrl, repointIds, deleteObjects: dupUrls.map(parseStorageObject) });
  console.log(
    `family ${key.split('|')[0]} · ${type} "${name}" (${fmt(sizeBytes)}): ` +
      `${urls.length} copies → keep 1, drop ${dupUrls.length} ` +
      `[${rows.map((r) => r.sku).join(', ')}]`,
  );
}

console.log(`\n${plan.length} duplicate group(s) — ${filesRemoved} redundant file(s), ~${fmt(bytesSaved)} to free.`);
if (plan.length === 0) process.exit(0);
if (!apply) {
  console.log('\nDry run only. Re-run with --apply to repoint rows and delete redundant files.');
  process.exit(0);
}

console.log('\nApplying…');
for (const step of plan) {
  // Repoint duplicate rows at the kept object…
  for (const id of step.repointIds) {
    const res = await fetch(`${BASE}/rest/v1/product_media?id=eq.${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ storage_path: step.keepUrl }),
    });
    if (!res.ok) throw new Error(`repoint ${id}: ${res.status} ${await res.text()}`);
  }
  // …then delete the now-unreferenced objects. NOTE: no Content-Type header —
  // the storage API rejects a bodyless DELETE that claims application/json.
  for (const obj of step.deleteObjects) {
    const res = await fetch(`${BASE}/storage/v1/object/${obj.bucket}/${obj.path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    if (!res.ok && res.status !== 404) {
      console.warn(`  ! delete ${obj.bucket}/${obj.path}: ${res.status} ${await res.text()}`);
    }
  }
  console.log(`  ✓ kept ${step.keepUrl.split('/').slice(-2).join('/')} — repointed ${step.repointIds.length} row(s), deleted ${step.deleteObjects.length} file(s)`);
}
console.log('\nDone.');
