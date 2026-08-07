/**
 * Generate search keywords (EN + FR) for every product, using Gemini.
 *
 * This is the BACKFILL tool: it sweeps the whole catalog and fills products
 * that have no keywords yet. Day-to-day generation happens from the PIM UI
 * (product page + bulk actions), which calls the generate-keywords edge
 * function. Both share the same prompt, schema and Gemini call — see
 * supabase/functions/_shared/keywords.js. Change the prompt there, redeploy
 * the function, and this script picks it up automatically.
 *
 * Written to attributes.keywords_en / attributes.keywords_fr, both editable
 * afterwards in the product's Content tab. Products that already have keywords
 * are skipped unless --force, so the script is safe to re-run for new items.
 *
 * Usage:
 *   node scripts/generate-keywords.mjs                  → preview 5 products
 *   node scripts/generate-keywords.mjs --limit 20       → preview 20
 *   node scripts/generate-keywords.mjs --all            → preview every product
 *   node scripts/generate-keywords.mjs --all --apply    → generate and write
 *   node scripts/generate-keywords.mjs --all --apply --force  → also redo existing
 *   node scripts/generate-keywords.mjs --sku A,B --apply → redo specific SKUs
 *   node scripts/generate-keywords.mjs --list-models    → what this key can use
 *   node scripts/generate-keywords.mjs --model <id>     → override the model
 *
 * Reads VITE_SUPABASE_URL from .env.local, the service_role key from
 * SUPABASE_SERVICE_ROLE_KEY (.env.local) or SR_KEY (.env.secrets.local), and
 * GEMINI_API_KEY from the environment or .env.secrets.local.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KEYWORDS_MODEL,
  generateKeywordsForProduct,
} from '../supabase/functions/_shared/keywords.js';

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
const GEMINI_KEY = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY;

if (!GEMINI_KEY) {
  console.error('Missing GEMINI_API_KEY — add it to .env.secrets.local or export it.');
  process.exit(1);
}

const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const ALL = process.argv.includes('--all');
const LIST_MODELS = process.argv.includes('--list-models');
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : fallback;
};
const LIMIT = Number(arg('--limit', ALL ? Infinity : 5));
const MODEL = arg('--model', KEYWORDS_MODEL);
const CONCURRENCY = 4;

if (LIST_MODELS) {
  let pageToken = '';
  do {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=50${pageToken ? `&pageToken=${pageToken}` : ''}`,
      { headers: { 'x-goog-api-key': GEMINI_KEY } },
    );
    if (!res.ok) { console.error(`models list failed: ${res.status}`); process.exit(1); }
    const data = await res.json();
    for (const m of data.models ?? []) {
      if (!(m.supportedGenerationMethods ?? []).includes('generateContent')) continue;
      console.log(`${m.name}${m.displayName ? `  — ${m.displayName}` : ''}`);
    }
    pageToken = data.nextPageToken ?? '';
  } while (pageToken);
  process.exit(0);
}

if (!BASE || !KEY) {
  console.error('Missing VITE_SUPABASE_URL or the service_role key.');
  process.exit(1);
}

async function fetchProducts() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(
      `${BASE}/rest/v1/products?select=sku,category,product_type,material,finish,brand,model_name,description,attributes&order=sku`,
      { headers: { ...HEADERS, Range: `${from}-${from + 999}` } },
    );
    if (!res.ok) throw new Error(`products fetch failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

const all = await fetchProducts();
// --sku redoes named products regardless of what they already have — for
// fixing a bad generation without touching the other 300.
const only = arg('--sku', null)?.split(',').map((s) => s.trim()).filter(Boolean);
const pending = only
  ? all.filter((p) => only.includes(p.sku))
  : all.filter((p) => FORCE || !(p.attributes?.keywords_en?.length));
const targets = pending.slice(0, LIMIT === Infinity ? undefined : LIMIT);

console.log(`Model: ${MODEL}`);
console.log(`Products: ${all.length}  |  without keywords: ${pending.length}  |  this run: ${targets.length}`);
console.log(APPLY ? 'Mode: WRITE\n' : 'Mode: preview only (add --apply to write)\n');

let done = 0;
let failed = 0;
let promptTokens = 0;
let outputTokens = 0;

async function handle(p) {
  try {
    const { keywords_en, keywords_fr, usage } = await generateKeywordsForProduct(
      fetch, GEMINI_KEY, p, MODEL,
    );
    promptTokens += usage.promptTokenCount ?? 0;
    outputTokens += usage.candidatesTokenCount ?? 0;

    if (APPLY) {
      const next = { ...(p.attributes ?? {}), keywords_en, keywords_fr };
      const res = await fetch(`${BASE}/rest/v1/products?sku=eq.${encodeURIComponent(p.sku)}`, {
        method: 'PATCH',
        headers: { ...HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({ attributes: next }),
      });
      if (!res.ok) throw new Error(`write failed: ${res.status} ${await res.text()}`);
    }

    done += 1;
    if (!APPLY || done <= 3) {
      console.log(`\n${p.sku} — ${p.model_name ?? ''} (${p.category})`);
      console.log(`  EN: ${keywords_en.join(' | ')}`);
      console.log(`  FR: ${keywords_fr.join(' | ')}`);
    } else if (done % 25 === 0) {
      console.log(`  ${done}/${targets.length}`);
    }
  } catch (err) {
    failed += 1;
    console.error(`  FAILED ${p.sku}: ${err.message}`);
  }
}

// Fixed-size worker pool over the queue.
const queue = [...targets];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) await handle(queue.shift());
  }),
);

console.log(`\n${done} generated, ${failed} failed.`);
console.log(`Tokens — prompt ${promptTokens}, output ${outputTokens}`);
if (!APPLY) console.log('\n--- preview only. Re-run with --apply to write. ---');
