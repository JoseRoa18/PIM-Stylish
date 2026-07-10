// Media worker: downloads Dropbox temp-link images, resizes to max 2272px,
// uploads to Supabase Storage (product-images/<SKU>/) and inserts product_media
// rows following the existing conventions (00 image = primary, order = index).
//
// Usage: node media_worker.mjs <manifest.json>
// Manifest: [{ "sku": "B-112N", "files": [{ "url": "...", "name": "b_112n_....jpg" }, ...] }]
// File order in the manifest = display_order; index 0 = is_primary.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('e:/Trabajo/PIM/stylish-pim/package.json');
const sharp = require('sharp');

const SR = fs.readFileSync('e:/Trabajo/PIM/stylish-pim/.env.secrets.local', 'utf8')
  .split(/\r?\n/).find(l => l.startsWith('SR_KEY=')).slice(7).trim();
const BASE = 'https://vcmizxflfjcpxeccezlc.supabase.co';
const H = { apikey: SR, Authorization: `Bearer ${SR}` };
const MAX_PX = 2272;

const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const rand = () => Math.random().toString(36).slice(2, 8);

async function existingCount(sku) {
  const r = await fetch(`${BASE}/rest/v1/product_media?select=id&media_type=eq.image&sku=eq.${encodeURIComponent(sku)}&limit=1`, { headers: H });
  return (await r.json()).length;
}

let totalUp = 0, totalErr = 0;
for (const item of manifest) {
  const { sku, files } = item;
  if (await existingCount(sku)) { console.log(`SKIP ${sku} (already has images)`); continue; }
  let order = 0, up = 0;
  for (const f of files) {
    try {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());

      let img = sharp(buf, { failOn: 'none' }).rotate();
      const meta = await img.metadata();
      if ((meta.width ?? 0) > MAX_PX || (meta.height ?? 0) > MAX_PX) {
        img = img.resize(MAX_PX, MAX_PX, { fit: 'inside', withoutEnlargement: true });
      }
      const out = await img.jpeg({ quality: 85, mozjpeg: true }).toBuffer();

      const safe = f.name.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9_]+/g, '_');
      const target = `${sku}/${safe}-${rand()}.jpg`;
      const upRes = await fetch(`${BASE}/storage/v1/object/product-images/${target}`, {
        method: 'POST', headers: { ...H, 'Content-Type': 'image/jpeg' }, body: out,
      });
      if (!upRes.ok) throw new Error(`upload ${upRes.status}: ${(await upRes.text()).slice(0, 120)}`);

      const publicUrl = `${BASE}/storage/v1/object/public/product-images/${target}`;
      const insRes = await fetch(`${BASE}/rest/v1/product_media`, {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          sku, media_type: 'image', storage_path: publicUrl, file_name: f.name,
          file_size_bytes: out.length, mime_type: 'image/jpeg',
          is_primary: order === 0, display_order: order,
        }),
      });
      if (!insRes.ok) throw new Error(`insert ${insRes.status}: ${(await insRes.text()).slice(0, 120)}`);
      order++; up++; totalUp++;
    } catch (err) {
      totalErr++;
      console.log(`ERR ${sku} ${f.name}: ${err.message}`);
    }
  }
  console.log(`OK ${sku}: ${up}/${files.length} images`);
}
console.log(`DONE uploaded=${totalUp} errors=${totalErr}`);
