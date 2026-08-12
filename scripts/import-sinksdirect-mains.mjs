// Import each linked product's CURRENT Wix main image into the PIM as its
// SinksDirect hero (product_media.image_role = 'sinksdirect_main').
//
// Why: products have two mains — a gray-background hero used only on the
// SinksDirect site and a white-background one for every other marketplace.
// The gray heroes only exist on Wix today; whatever Wix shows first IS the
// SinksDirect main by definition, so this pulls it into the PIM where the
// Wix media push can keep it first from now on.
//
//   node scripts/import-sinksdirect-mains.mjs                # dry run
//   node scripts/import-sinksdirect-mains.mjs --apply        # import all
//   node scripts/import-sinksdirect-mains.mjs --sku S-822H --apply
//
// Idempotent: SKUs that already carry a sinksdirect_main row are skipped.

import { readFileSync } from 'node:fs';

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
const ANON = env.VITE_SUPABASE_ANON_KEY;
const SR = secrets.SR_KEY;
const SRH = { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json' };

const APPLY = process.argv.includes('--apply');
const onlySku = process.argv.includes('--sku') ? process.argv[process.argv.indexOf('--sku') + 1] : null;

// The edge function needs a real admin/editor session.
async function login() {
  const gl = await fetch(`${URL_BASE}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: SRH,
    body: JSON.stringify({ type: 'magiclink', email: 'pricing@stylishkb.com' }),
  });
  const { hashed_token } = await gl.json();
  const v = await fetch(`${URL_BASE}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed_token }),
  });
  const sess = await v.json();
  if (!sess.access_token) throw new Error('login failed');
  return sess.access_token;
}

const token = await login();

const prodRes = await fetch(
  `${URL_BASE}/rest/v1/products?select=sku,wix_product_id&wix_product_id=not.is.null&order=sku${onlySku ? `&sku=eq.${encodeURIComponent(onlySku)}` : ''}`,
  { headers: SRH },
);
const linked = await prodRes.json();

const haveRes = await fetch(
  `${URL_BASE}/rest/v1/product_media?select=sku&image_role=eq.sinksdirect_main`,
  { headers: SRH },
);
const alreadyHave = new Set((await haveRes.json()).map((r) => r.sku));

console.log(`linked products: ${linked.length} | already have a SinksDirect main: ${alreadyHave.size}`);

let imported = 0;
let skippedHave = 0;
let noMedia = 0;
const failures = [];

for (const { sku } of linked) {
  if (alreadyHave.has(sku)) { skippedHave += 1; continue; }
  // Our earlier media tests replaced this hidden product's gallery with the
  // PIM's white set — its Wix main is no longer the SinksDirect hero.
  if (sku === 'S-828WHK') { skippedHave += 1; continue; }

  try {
    const read = await fetch(`${URL_BASE}/functions/v1/wix-read-product`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku }),
    });
    const data = await read.json();
    const first = data?.snapshot?._wix_media?.[0]?.storage_path;
    if (!first) { noMedia += 1; continue; }

    if (!APPLY) { imported += 1; continue; }

    // Original file, not the resized render.
    const originalUrl = first.replace(/\/v1\/.*$/, '');
    const img = await fetch(originalUrl);
    if (!img.ok) throw new Error(`image download ${img.status}`);
    const buf = Buffer.from(await img.arrayBuffer());
    const mime = img.headers.get('content-type') ?? 'image/jpeg';
    const ext = mime.includes('png') ? 'png' : 'jpg';
    const fileName = `${sku.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_sinksdirect_main.${ext}`;
    const objectPath = `${sku}/${fileName}`;

    const up = await fetch(`${URL_BASE}/storage/v1/object/product-images/${objectPath}`, {
      method: 'POST',
      headers: { ...SRH, 'Content-Type': mime, 'x-upsert': 'true' },
      body: buf,
    });
    if (!up.ok) throw new Error(`upload ${up.status}: ${(await up.text()).slice(0, 120)}`);

    const publicUrl = `${URL_BASE}/storage/v1/object/public/product-images/${objectPath}`;
    const ins = await fetch(`${URL_BASE}/rest/v1/product_media`, {
      method: 'POST',
      headers: { ...SRH, Prefer: 'return=minimal' },
      body: JSON.stringify({
        sku,
        media_type: 'image',
        storage_path: publicUrl,
        file_name: fileName,
        file_size_bytes: buf.length,
        mime_type: mime,
        is_primary: false,
        display_order: 0,
        image_role: 'sinksdirect_main',
      }),
    });
    if (!ins.ok) throw new Error(`insert ${ins.status}: ${(await ins.text()).slice(0, 120)}`);
    imported += 1;
    if (imported % 25 === 0) console.log(`  ...${imported} imported`);
  } catch (err) {
    failures.push(`${sku}: ${err.message}`);
  }
}

console.log(`${APPLY ? 'imported' : 'would import'}: ${imported}`);
console.log(`skipped (already have / test product): ${skippedHave} | no Wix media: ${noMedia}`);
if (failures.length) {
  console.log(`FAILURES (${failures.length}):`);
  for (const f of failures) console.log('  ' + f);
}
