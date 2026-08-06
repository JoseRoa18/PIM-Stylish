/**
 * Generate search keywords (EN + FR) for every product, using Gemini.
 *
 * Keywords are what a shopper types into a marketplace search box — not a
 * restatement of the product title. A formula built from the structured fields
 * ("kitchen_sink, Undermount, Brushed Stainless Steel, Stylish") only ever
 * repeats what the listing already says, so this reads each product's title,
 * description, bullets and attributes and writes the phrases a buyer would
 * actually search for.
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
import { GoogleGenAI } from '@google/genai';

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
// An alias rather than a pinned version, so this doesn't rot as models ship.
// Flash is the right tier: short, well-specified generation, run 300+ times.
const MODEL = arg('--model', 'gemini-flash-latest');
const CONCURRENCY = 4;

const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });

if (LIST_MODELS) {
  const pager = await ai.models.list();
  for await (const m of pager) {
    const methods = m.supportedActions ?? m.supportedGenerationMethods ?? [];
    if (methods.length && !methods.includes('generateContent')) continue;
    console.log(`${m.name}${m.displayName ? `  — ${m.displayName}` : ''}`);
  }
  process.exit(0);
}

if (!BASE || !KEY) {
  console.error('Missing VITE_SUPABASE_URL or the service_role key.');
  process.exit(1);
}

const SYSTEM = `You write marketplace search keywords for a kitchen and bath fixtures catalog (sinks, faucets, and accessories sold on Amazon, Walmart, Wayfair, Home Depot and Best Buy in the US and Canada).

Your job is to produce the phrases a shopper actually types into a search box when they are looking for a product like this one. That is a different thing from the product's title, and the difference is the whole point of the task.

What makes a good keyword here:
- It is how a buyer describes the product in their own words, including the words the catalog does not use. A "Composite Granite" sink is searched for as "granite composite sink", "black granite sink", and "stone kitchen sink".
- It combines the attributes buyers actually filter on: size, installation type, bowl count, material, finish, shape. "33 inch undermount single bowl sink" is a real search; "sink" is not.
- It covers the buying intent behind the product: "farmhouse apron front sink", "workstation sink with cutting board", "bar prep sink small".
- It includes common synonyms and the informal names for the category ("kitchen faucet with sprayer", "pull down faucet", "gooseneck faucet").

What to avoid:
- Do not repeat the model name or SKU. Nobody searches those.
- Do not include the brand name; it is added separately.
- Do not produce near-duplicates that differ by one filler word.
- Do not invent specifications the product data does not support. If you do not know the width, do not write a width.
- No punctuation beyond spaces and hyphens. All lowercase. This rule is about punctuation only: French keywords keep their accents and apostrophes, spelled the normal way ("évier", "poignées", "rinçage", "robinet d'évier"). Never strip an accent to satisfy the punctuation rule.

Return 8 to 14 keywords per language.

The French list is for Canadian marketplaces. Write it as French-Canadian shoppers actually search, not as a word-for-word translation of the English list — the phrasing, and sometimes the concepts, differ ("évier de cuisine sous plan", "robinet de cuisine rétractable").`;

const SCHEMA = {
  type: 'object',
  properties: {
    keywords_en: { type: 'array', items: { type: 'string' } },
    keywords_fr: { type: 'array', items: { type: 'string' } },
  },
  required: ['keywords_en', 'keywords_fr'],
  propertyOrdering: ['keywords_en', 'keywords_fr'],
};

const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// Only the attributes a shopper would search on — the full blob is mostly
// compliance fields and would just dilute the prompt.
const USEFUL_ATTRS = [
  'installation_type', 'mounting_type', 'sink_shape', 'number_of_bowls',
  'bowl_configuration', 'gauge', 'craftsmanship', 'external_dimensions_in',
  'spout_type', 'number_of_handles', 'spray_included', 'spray_type',
  'max_flow_rate', 'application', 'number_of_faucet_holes', 'overflow',
  'accessories_included', 'includes_grids', 'product_type',
];

function describe(p) {
  const a = p.attributes ?? {};
  const lines = [
    `SKU: ${p.sku}`,
    `Category: ${p.category ?? '—'}`,
    p.product_type && `Product type: ${p.product_type}`,
    `Material: ${p.material ?? '—'}`,
    `Finish: ${p.finish ?? '—'}`,
    a.general_title_en && `Title: ${a.general_title_en}`,
  ].filter(Boolean);

  for (const k of USEFUL_ATTRS) {
    const v = a[k];
    if (v == null || v === '') continue;
    const text = Array.isArray(v)
      ? v.join(', ')
      : (typeof v === 'object' ? Object.entries(v).map(([kk, vv]) => `${kk} ${vv}`).join(' x ') : String(v));
    if (text) lines.push(`${k.replace(/_/g, ' ')}: ${text}`);
  }

  const desc = stripHtml(p.description).slice(0, 700);
  if (desc) lines.push(`Description: ${desc}`);

  const bullets = Array.isArray(a.bullet_points) ? a.bullet_points.filter(Boolean).slice(0, 6) : [];
  if (bullets.length) lines.push(`Features:\n- ${bullets.map(stripHtml).join('\n- ')}`);

  return lines.join('\n');
}

async function keywordsFor(p) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: describe(p),
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: 'application/json',
      responseJsonSchema: SCHEMA,
      maxOutputTokens: 4096,
    },
  });

  const text = response.text;
  if (!text) {
    const reason = response.candidates?.[0]?.finishReason ?? 'no text in response';
    throw new Error(String(reason));
  }
  const parsed = JSON.parse(text);
  const clean = (arr) => [...new Set(
    (Array.isArray(arr) ? arr : []).map((s) => String(s).trim().toLowerCase()).filter(Boolean),
  )];
  return {
    keywords_en: clean(parsed.keywords_en),
    keywords_fr: clean(parsed.keywords_fr),
    usage: response.usageMetadata ?? {},
  };
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
    const { keywords_en, keywords_fr, usage } = await keywordsFor(p);
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
