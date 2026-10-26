// Publish the PIM's WHERE TO BUY list (product_where_to_buy) to the Stylish
// Canada / USA pages of every product — the same thing the product page's
// "Save and publish" does for one product: read the live page, replace only
// the WHERE TO BUY section (supabase/functions/_shared/whereToBuy.js), push
// with only: ["additionalInfoSections"]. Pages already equal to the PIM are
// skipped, so it is safe to re-run. One page at a time; when Wix asks to
// slow down the page is retried after a pause.
//
//   node scripts/publish-where-to-buy.mjs [--apply] [--sku S-611W] [--site stylish_ca]
//
// Dry run by default (counts what would change). Uses the anon key from
// .env.local for the edge functions and SR_KEY from .env.secrets.local to read.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WTB_SITES, withWhereToBuySection, linksToShow, isHiddenLink } from '../supabase/functions/_shared/whereToBuy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(['.env.local', '.env.secrets.local']
  .flatMap((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/))
  .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const BASE = env.VITE_SUPABASE_URL;
const SR = { apikey: env.SR_KEY, Authorization: `Bearer ${env.SR_KEY}` };
const FN = { apikey: env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${env.VITE_SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes('--apply');
const ONLY_SKU = opt('--sku');
const ONLY_SITE = opt('--site');

async function getAll(q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${BASE}/rest/v1/${q}`, { headers: { ...SR, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function call(fn, body) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`${BASE}/functions/v1/${fn}`, { method: 'POST', headers: FN, body: JSON.stringify(body) });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    const err = !r.ok || j?.error ? (j?.error ?? text.slice(0, 200)) : null;
    if (!err) return j;
    const wait = Number(String(err).match(/retry after ~?(\d+)\s*ms/i)?.[1] ?? 0);
    if (attempt < 4 && (wait || r.status === 429 || /rate|too many|timeout|502|503/i.test(err))) {
      await sleep(Math.max(wait, 15000) + 2000);
      continue;
    }
    throw new Error(err);
  }
}

const links = await getAll(`product_where_to_buy?select=sku,retailer,url${ONLY_SKU ? `&sku=eq.${encodeURIComponent(ONLY_SKU)}` : ''}`);
const bySku = new Map();
for (const l of links) { if (!bySku.has(l.sku)) bySku.set(l.sku, []); bySku.get(l.sku).push({ retailer: l.retailer, url: l.url }); }
const products = new Map((await getAll('products?select=sku,brand')).map((p) => [p.sku, p]));
const wix = new Set((await getAll('wix_links?select=site,sku&site=in.(stylish_ca,stylish_us)')).map((w) => `${w.site}|${w.sku}`));
// Addresses each product's pages leave out (isHiddenLink: broken, opening
// another product / option — "Wrong product" — or sold out), per product: one
// address can be wrong for one SKU and right for another.
const broken = new Map();
for (const r of await getAll('where_to_buy_links?select=sku,url,verdict,sku_check,in_stock&url=not.is.null&or=(verdict.eq.broken,sku_check.in.(variant,other),in_stock.is.false)')) {
  if (!isHiddenLink(r.verdict, r.sku_check, r.in_stock)) continue; // a sold-out "Other finish" page stays
  if (!broken.has(r.sku)) broken.set(r.sku, new Set());
  broken.get(r.sku).add(r.url);
}

const jobs = [];
for (const [sku, list] of bySku) {
  if (/azuni/i.test(products.get(sku)?.brand ?? '')) continue; // never on the Stylish sites
  for (const site of WTB_SITES) {
    if (ONLY_SITE && site.key !== ONLY_SITE) continue;
    if (wix.has(`${site.key}|${sku}`)) jobs.push({ sku, site: site.key, links: list });
  }
}
const t = { pages: jobs.length, published: 0, upToDate: 0, notFound: 0, errors: 0 };
const errors = [];
const started = Date.now();
console.log(`${jobs.length} pages (${new Set(jobs.map((j) => j.sku)).size} products)${APPLY ? '' : ' — dry run'}`);
for (const [i, job] of jobs.entries()) {
  try {
    const read = await call('wix-read-product', { sku: job.sku, site: job.site });
    if (read?.exists === false || !read?.snapshot) { t.notFound += 1; continue; }
    // Every link but the broken, wrong-product and sold-out ones (user, 2026-10-20 / 10-26), as the audit publishes.
    const next = withWhereToBuySection(read.snapshot.additional_info_sections ?? [], linksToShow(job.links, broken.get(job.sku) ?? new Set()), job.site, { owned: job.links.length > 0 });
    if (!next) { t.upToDate += 1; continue; }
    if (APPLY) await call('wix-push-product', { sku: job.sku, site: job.site, fields: { additional_info_sections: next }, only: ['additionalInfoSections'] });
    t.published += 1;
  } catch (e) {
    t.errors += 1;
    errors.push({ sku: job.sku, site: job.site, error: String(e.message).slice(0, 160) });
  }
  if ((i + 1) % 25 === 0) console.log(`${i + 1}/${jobs.length} · ${Math.round((Date.now() - started) / 60000)} min · ${JSON.stringify(t)}`);
}
console.log('done', JSON.stringify(t));
if (errors.length) console.log('errors:', JSON.stringify(errors, null, 1));
if (APPLY && t.published) {
  await fetch(`${BASE}/rest/v1/audit_log`, {
    method: 'POST', headers: { ...SR, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      actor_id: null, actor_email: null, actor_name: 'Where to Buy publish', action: 'push', entity_type: 'channel', entity_id: 'where_to_buy', target: 'wix',
      summary: `Where to Buy sections written from the PIM: ${t.published} Stylish pages updated, ${t.upToDate} already up to date, ${t.errors} errors`,
      metadata: { ...t, errors },
    }),
  });
}
