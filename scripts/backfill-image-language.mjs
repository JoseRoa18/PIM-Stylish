// Backfill product_media.language for images from the language suffix in the
// file name (marketing names every localized set: _e_f, _e_s, _esp_eng, _fr…).
// Only rows where language IS NULL are touched; rows with no recognizable
// suffix stay null (= universal artwork). Channel pushes (wix-push-media)
// select images by this column, so untagged localized sets would otherwise
// dodge the language filter.
//
//   node scripts/backfill-image-language.mjs           # dry run (report only)
//   node scripts/backfill-image-language.mjs --apply   # write the changes
//
// `_fr`-only sets (K-146 family) are tagged en_fr: they're the only images
// those SKUs have, and on the bilingual Canadian site French-labeled artwork
// belongs in the same tier as EN/FR.

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
const SR = secrets.SR_KEY;
if (!URL_BASE || !SR) {
  console.error('Missing VITE_SUPABASE_URL or SR_KEY');
  process.exit(1);
}
const HEADERS = {
  apikey: SR,
  Authorization: `Bearer ${SR}`,
  'Content-Type': 'application/json',
};
const APPLY = process.argv.includes('--apply');

// Order matters: bilingual pairs before single-language suffixes so
// `_esp_eng` never reads as plain `_eng`.
const RULES = [
  [/_(e_f|f_e|en_fr|fr_en)_?$/, 'en_fr'],
  [/_(e_s|s_e|en_es|es_en)_?$/, 'en_es'],
  [/_(esp_eng|eng_esp)(_\d+)?_?$/, 'en_es'],
  [/_(fr|french)_?$/, 'en_fr'],
  [/_(en|eng|english)_?$/, 'en'],
];

function languageFromFileName(fileName) {
  const stem = String(fileName ?? '')
    .toLowerCase()
    .replace(/(\.[a-z0-9]+)+$/, '');
  for (const [re, lang] of RULES) {
    if (re.test(stem)) return lang;
  }
  // Suffix may sit before a shot number: ..._esp_eng_01
  const beforeShot = stem.replace(/_\d+$/, '');
  for (const [re, lang] of RULES) {
    if (re.test(beforeShot)) return lang;
  }
  return null;
}

async function fetchAllImages() {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(
      `${URL_BASE}/rest/v1/product_media?select=id,sku,language,file_name&media_type=eq.image&limit=1000&offset=${offset}`,
      { headers: HEADERS },
    );
    if (!res.ok) throw new Error(`fetch ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 1000) break;
  }
  return all;
}

const rows = await fetchAllImages();
console.log(`image rows: ${rows.length}`);

const updates = new Map(); // language -> [ids]
let stillNull = 0;
let fixes = 0;
let mismatches = 0;
for (const row of rows) {
  const derived = languageFromFileName(row.file_name);
  if (row.language != null) {
    if (derived && derived !== row.language) {
      // A bilingual filename suffix (_e_f/_e_s) is marketing's own naming —
      // a plain `en` tag on such a file is an import default, not a choice.
      const fixable = row.language === 'en' && (derived === 'en_fr' || derived === 'en_es');
      if (fixable) {
        fixes += 1;
        if (!updates.has(derived)) updates.set(derived, []);
        updates.get(derived).push(row.id);
        if (fixes <= 10) {
          console.log(`  fix en -> ${derived}: ${row.sku} ${row.file_name}`);
        }
      } else {
        mismatches += 1;
        if (mismatches <= 10) {
          console.log(`  mismatch (kept): ${row.sku} ${row.file_name} tagged=${row.language} filename=${derived}`);
        }
      }
    }
    continue;
  }
  if (!derived) {
    stillNull += 1;
    continue;
  }
  if (!updates.has(derived)) updates.set(derived, []);
  updates.get(derived).push(row.id);
}

for (const [lang, ids] of updates) {
  console.log(`null -> ${lang}: ${ids.length}`);
}
console.log(`stays null (universal): ${stillNull}`);
console.log(`already-tagged rows disagreeing with filename (untouched): ${mismatches}`);

if (!APPLY) {
  console.log('\nDry run — re-run with --apply to write.');
  process.exit(0);
}

for (const [lang, ids] of updates) {
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await fetch(
      `${URL_BASE}/rest/v1/product_media?id=in.(${chunk.join(',')})`,
      { method: 'PATCH', headers: HEADERS, body: JSON.stringify({ language: lang }) },
    );
    if (!res.ok) throw new Error(`patch ${res.status}: ${await res.text()}`);
  }
  console.log(`applied ${lang}: ${ids.length}`);
}
console.log('Done.');
