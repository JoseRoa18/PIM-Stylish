// Backfill the PIM's own image thumbnails (bucket product-thumbs, see
// supabase/migrations/20260929_product_thumbs.sql): for every product image
// in product-images/<path>, two square WebP copies <path>.w200.webp and
// <path>.w480.webp — the same "cover" crop the weserv proxy made. The app
// creates them itself on upload; this covers images that existed before, or
// came in through a script. Safe to re-run: existing thumbnails are skipped
// (--force regenerates).
//
//   npm i --no-save sharp            (or: SHARP_FROM=<dir with sharp>/package.json)
//   node scripts/backfill-thumbnails.mjs [--limit N] [--sku S-414T] [--force] [--dry-run]
//
// Uses the service-role key from .env.secrets.local (SR_KEY).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(process.env.SHARP_FROM ?? path.join(ROOT, 'package.json'));
let sharp;
try {
  sharp = require('sharp');
} catch {
  console.error('sharp is not installed — run `npm i --no-save sharp` (or set SHARP_FROM to a package.json next to it).');
  process.exit(1);
}

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env.secrets.local'), 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const URL_BASE = 'https://vcmizxflfjcpxeccezlc.supabase.co';
const KEY = env.SR_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const MARK = '/storage/v1/object/public/product-images/';
const SIZES = [200, 480];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const LIMIT = Number(opt('--limit') ?? 0) || Infinity;
const ONLY_SKU = opt('--sku');
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');
const CONCURRENCY = Number(opt('--concurrency') ?? 6);

async function getAll(q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${URL_BASE}/rest/v1/${q}`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${q} ${r.status} ${await r.text()}`);
    const d = await r.json();
    out.push(...d);
    if (d.length < 1000) break;
  }
  return out;
}

// Existing thumbnails of one SKU folder (so a re-run only fills what is missing).
async function existingThumbs(folder) {
  const names = new Set();
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${URL_BASE}/storage/v1/object/list/product-thumbs`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: `${folder}/`, limit: 1000, offset }),
    });
    if (!r.ok) throw new Error(`list ${folder} ${r.status} ${(await r.text()).slice(0, 120)}`);
    const d = await r.json();
    for (const o of d) names.add(`${folder}/${o.name}`);
    if (d.length < 1000) break;
  }
  return names;
}

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

const skuFilter = ONLY_SKU ? `&sku=eq.${encodeURIComponent(ONLY_SKU)}` : '';
// Product images, plus video posters picked from our storage (the Media tab
// shows those as thumbnails too).
const images = await getAll(`product_media?select=storage_path&media_type=eq.image${skuFilter}&order=sku`);
const posters = await getAll(`product_media?select=storage_path:thumbnail_path&media_type=eq.video&thumbnail_path=not.is.null${skuFilter}&order=sku`);
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
const objects = [...new Set([...images, ...posters]
  .map((r) => r.storage_path)
  .filter((p) => p?.includes(MARK))
  .map((p) => decodeURIComponent(p.slice(p.indexOf(MARK) + MARK.length).split(/[?#]/)[0]))
  .filter((p) => IMAGE_EXT.test(p)))];
console.log(`${objects.length} images in product-images${ONLY_SKU ? ` for ${ONLY_SKU}` : ''}`);

const folders = [...new Set(objects.map((o) => o.split('/')[0]))];
const have = new Set();
if (!FORCE) {
  for (const f of folders) {
    // A folder whose listing keeps failing is simply regenerated (uploads upsert).
    try {
      for (const n of await withRetry(() => existingThumbs(f), 4)) have.add(n);
    } catch (err) {
      console.warn(`  could not list ${f} (${err.message}) — its thumbnails will be regenerated`);
    }
  }
}

const todo = objects.filter((o) => FORCE || SIZES.some((s) => !have.has(`${o}.w${s}.webp`))).slice(0, LIMIT);
console.log(`${todo.length} need thumbnails${DRY ? ' (dry run — nothing written)' : ''}`);

let done = 0, failed = 0, bytesIn = 0, bytesOut = 0;
const started = Date.now();
const errors = [];
async function one(obj) {
  const src = `${URL_BASE}/storage/v1/object/public/product-images/${obj.split('/').map(encodeURIComponent).join('/')}`;
  const buf = await withRetry(async () => {
    const r = await fetch(src, { signal: AbortSignal.timeout(90000) });
    if (!r.ok) throw new Error(`download ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  });
  bytesIn += buf.length;
  for (const size of SIZES) {
    const out = await sharp(buf, { failOn: 'none' }).rotate().resize(size, size, { fit: 'cover', position: 'centre' }).webp({ quality: 80 }).toBuffer();
    bytesOut += out.length;
    if (DRY) continue;
    const key = `${obj}.w${size}.webp`.split('/').map(encodeURIComponent).join('/');
    await withRetry(async () => {
      const r = await fetch(`${URL_BASE}/storage/v1/object/product-thumbs/${key}`, {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'image/webp', 'x-upsert': 'true', 'Cache-Control': 'max-age=2592000' },
        body: out,
      });
      if (!r.ok) throw new Error(`upload ${r.status} ${(await r.text()).slice(0, 120)}`);
    });
  }
}
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < todo.length) {
    const obj = todo[next++];
    try { await one(obj); done++; } catch (err) { failed++; if (errors.length < 20) errors.push(`${obj}: ${err.message}`); }
    if ((done + failed) % 100 === 0) {
      const s = (Date.now() - started) / 1000;
      console.log(`  ${done + failed}/${todo.length} · ${Math.round(bytesIn / 1048576)} MB read · ${(bytesOut / 1048576).toFixed(1)} MB written · ${Math.round(s)} s`);
    }
  }
}));
const s = Math.round((Date.now() - started) / 1000);
console.log(`done: ${done} ok, ${failed} failed in ${s} s — read ${Math.round(bytesIn / 1048576)} MB, thumbnails ${(bytesOut / 1048576).toFixed(1)} MB (avg ${done ? Math.round(bytesOut / done / SIZES.length / 1024) : 0} KB each)`);
if (errors.length) console.log(errors.join('\n'));
