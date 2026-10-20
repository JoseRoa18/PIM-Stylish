// Load the PIM's WHERE TO BUY list (product_where_to_buy, see
// supabase/migrations/20261019_product_where_to_buy.sql) from the links the
// two Stylish pages carry today — read by the Listing Health scan into
// where_to_buy_links (run "Scan pages" first so it is fresh).
//
// The two pages were edited by hand and never agreed (2026-10-19: 0 of 392
// products had the same links on both), so each product gets ONE address per
// retailer. When the pages disagree, the address the audit found OK wins over
// one not checked yet, over a broken one; then the page of the retailer's own
// country (Amazon.com from the USA page); then the address used most. Every
// such choice is listed in the report. Store-locator and unknown links are not
// kept. Rows already in the table are left alone (--force overwrites them).
//
//   node scripts/import-where-to-buy-from-wix.mjs [--apply] [--force] [--sku S-611W] [--report file.csv]
//
// Dry run by default. Uses the service-role key from .env.secrets.local (SR_KEY).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { retailerForUrl, cleanWtbUrl } from '../supabase/functions/_shared/whereToBuy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env.secrets.local'), 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const REST = 'https://vcmizxflfjcpxeccezlc.supabase.co/rest/v1';
const H = { apikey: env.SR_KEY, Authorization: `Bearer ${env.SR_KEY}`, 'Content-Type': 'application/json' };

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const ONLY_SKU = opt('--sku');
const REPORT = opt('--report') ?? path.join(ROOT, 'where-to-buy-import-report.csv');

async function getAll(pathAndQuery) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${REST}/${pathAndQuery}`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

const VERDICT_RANK = { ok: 0, pending: 1, manual: 1, broken: 2 };
const SITE_OF_MARKET = { ca: 'stylish_ca', us: 'stylish_us' };

const links = await getAll(`where_to_buy_links?select=site,sku,url,verdict&section=eq.where_to_buy&url=not.is.null${ONLY_SKU ? `&sku=eq.${encodeURIComponent(ONLY_SKU)}` : ''}`);
const products = new Set((await getAll('products?select=sku')).map((p) => p.sku));
const existing = new Set((await getAll('product_where_to_buy?select=sku,retailer')).map((r) => `${r.sku}|${r.retailer}`));

// sku|retailer → candidate addresses with where they were seen
const groups = new Map();
let skippedStore = 0;
const notInPim = new Set();
for (const l of links) {
  const r = retailerForUrl(l.url);
  if (!r) { skippedStore += 1; continue; }
  if (!products.has(l.sku)) { notInPim.add(l.sku); continue; }
  const key = `${l.sku}|${r.key}`;
  if (!groups.has(key)) groups.set(key, { sku: l.sku, retailer: r.key, market: r.market, seen: [] });
  groups.get(key).seen.push({ url: cleanWtbUrl(l.url), site: l.site, verdict: l.verdict });
}

const rows = [];
const report = [['sku', 'retailer', 'chosen', 'why', 'other addresses']];
for (const g of groups.values()) {
  const byUrl = new Map();
  for (const s of g.seen) {
    if (!byUrl.has(s.url)) byUrl.set(s.url, { url: s.url, rank: 9, own: false, count: 0, sites: new Set() });
    const c = byUrl.get(s.url);
    c.rank = Math.min(c.rank, VERDICT_RANK[s.verdict] ?? 1);
    c.own ||= s.site === SITE_OF_MARKET[g.market];
    c.count += 1;
    c.sites.add(s.site.replace('stylish_', ''));
  }
  const cands = [...byUrl.values()].sort((a, b) => a.rank - b.rank || Number(b.own) - Number(a.own) || b.count - a.count);
  const chosen = cands[0];
  if (cands.length > 1) {
    const second = cands[1];
    const why = chosen.rank < second.rank ? 'better check result' : chosen.own && !second.own ? `page of its country (${g.market.toUpperCase()})` : 'used most';
    report.push([g.sku, g.retailer, chosen.url, why, cands.slice(1).map((c) => `${c.url} [${[...c.sites].join('+')}]`).join(' | ')]);
  }
  if (existing.has(`${g.sku}|${g.retailer}`) && !FORCE) continue;
  rows.push({ sku: g.sku, retailer: g.retailer, url: chosen.url, source: 'wix_import', updated_by: null });
}

const csv = report.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
fs.writeFileSync(REPORT, csv);
const productsWithLinks = new Set(rows.map((r) => r.sku)).size;
console.log({
  linksRead: links.length, notAStore: skippedStore, skusNotInPim: notInPim.size,
  retailerSlots: groups.size, conflicts: report.length - 1, toWrite: rows.length, productsWithLinks, alreadyInPim: existing.size,
});
console.log(`report: ${REPORT}`);

if (APPLY && rows.length) {
  for (let i = 0; i < rows.length; i += 500) {
    const r = await fetch(`${REST}/product_where_to_buy?on_conflict=sku,retailer`, {
      method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)),
    });
    if (!r.ok) throw new Error(`insert ${r.status} ${await r.text()}`);
  }
  await fetch(`${REST}/audit_log`, {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({
      actor_id: null, actor_email: null, actor_name: 'Where to Buy import', action: 'import', entity_type: 'channel', entity_id: 'where_to_buy', target: 'pim',
      summary: `Where to Buy links loaded from the Stylish pages: ${rows.length} links on ${productsWithLinks} products (${report.length - 1} chosen between two addresses)`,
      metadata: { rows: rows.length, products: productsWithLinks, conflicts: report.length - 1, force: FORCE },
    }),
  });
  console.log(`written: ${rows.length}`);
} else if (APPLY) console.log('nothing to write');
else console.log('dry run — add --apply to write');
