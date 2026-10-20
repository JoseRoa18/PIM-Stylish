// Load the product links of the dealers watched for price only (Aquarina,
// Plumbing Market, Vatero — DEALER_STORES in supabase/functions/_shared/
// pageStores.js) from Price2Spy's matrix reports (user, 2026-10-20: cover what
// Price2Spy watched before it is cancelled). The links are kept apart from the
// Stylish pages' Where to Buy: rows of where_to_buy_links with site "dealers"
// and section "price_watch", read by the audit's checks like any store link
// and compared in Pricing → Price Alignment. They never reach a Stylish page.
//
//   node scripts/import-dealer-links.mjs <report.xlsx> [<report.xlsx>…] [--apply]
//
// A report's first column is the product (our SKU, sometimes a name with the
// model in it); a row is kept only when it names one PIM product. A link
// already loaded is left as it is (its checks carry on); a dealer's link to a
// product that changed is added next to the old one. Dry run by default.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { DEALER_STORES } from '../supabase/functions/_shared/pageStores.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(['.env.local', '.env.secrets.local']
  .flatMap((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/))
  .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const BASE = env.VITE_SUPABASE_URL;
const SR = { apikey: env.SR_KEY, Authorization: `Bearer ${env.SR_KEY}`, 'Content-Type': 'application/json' };

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('usage: node scripts/import-dealer-links.mjs <report.xlsx>… [--apply]'); process.exit(1); }

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

// ---------------------------------------------------------------- the report
const unesc = (t) => String(t ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const colIdx = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

// Every product row of the first sheet: { product, links: [{ url }] } — a link
// is a cell's hyperlink whose host is one of the dealers.
async function readReport(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const rd = async (p) => (zip.file(p) ? zip.file(p).async('string') : '');
  const ss = [...(await rd('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  const sheet = await rd('xl/worksheets/sheet1.xml');
  const rels = await rd('xl/worksheets/_rels/sheet1.xml.rels');
  const target = {};
  for (const r of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = r[0].match(/Id="([^"]+)"/)?.[1];
    const t = r[0].match(/Target="([^"]+)"/)?.[1];
    if (id && t) target[id] = unesc(t);
  }
  const linkAt = {};
  for (const h of sheet.matchAll(/<hyperlink\b[^>]*>/g)) {
    const ref = h[0].match(/ref="([^"]+)"/)?.[1];
    const id = h[0].match(/r:id="([^"]+)"/)?.[1];
    if (ref && id && target[id]) linkAt[ref] = target[id];
  }
  const rows = [];
  let header = null;
  for (const row of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of row[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = c[1].match(/r="([A-Z]+)(\d+)"/);
      if (!ref) continue;
      const t = c[1].match(/t="([^"]+)"/)?.[1];
      const v = (c[2] ?? '').match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
      cells[colIdx(ref[1])] = {
        v: t === 's' ? ss[Number(v)] : t === 'inlineStr' ? unesc((c[2] ?? '').match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1]) : unesc(v),
        link: linkAt[ref[1] + ref[2]] ?? null,
      };
    }
    if (!header) {
      if (cells.some((c) => String(c?.v ?? '').trim().toLowerCase() === 'product name')) header = cells.map((c) => String(c?.v ?? '').trim());
      continue;
    }
    const skuCol = header.findIndex((h) => /^sku$/i.test(h));
    rows.push({ product: String(cells[skuCol >= 0 ? skuCol : 0]?.v ?? '').trim(), links: cells.filter((c) => c?.link).map((c) => c.link) });
  }
  if (!header) throw new Error(`${path.basename(file)}: no "Product name" header — not a Price2Spy matrix report`);
  return rows;
}

// ---------------------------------------------------------------- the PIM product
const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const spelled = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, '');
// The PIM SKU a report row names: the cell itself, else a model written in it
// ("STYLISH S-01N 240ml Soap Dispenser" → S-01N). Between a Stylish SKU and its
// Azuni twin (A-906 / A906) only the exact spelling counts.
function skuOf(product, bySku) {
  const pick = (code) => {
    const skus = bySku.get(norm(code)) ?? [];
    return skus.find((s) => spelled(s) === spelled(code)) ?? (skus.length === 1 ? skus[0] : null);
  };
  const whole = pick(product);
  if (whole) return whole;
  for (const m of String(product).toUpperCase().matchAll(/\b[A-Z]{1,3}-?\d{2,4}[A-Z0-9]*(?:-\d)?\b/g)) {
    const found = pick(m[0]);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------- run
const products = await getAll('products?select=sku');
const bySku = new Map();
for (const p of products) bySku.set(norm(p.sku), [...(bySku.get(norm(p.sku)) ?? []), p.sku]);
const storeOf = (url) => {
  try { const host = new URL(url).hostname.toLowerCase(); return DEALER_STORES.find((s) => s.host.test(host)) ?? null; } catch { return null; }
};

const found = new Map(); // retailer|sku|url → row
const unknown = new Set();
for (const file of files) {
  for (const r of await readReport(file)) {
    for (const url of r.links) {
      const store = storeOf(url);
      if (!store) continue;
      const sku = skuOf(r.product, bySku);
      if (!sku) { unknown.add(r.product); continue; }
      const host = new URL(url).hostname.toLowerCase();
      found.set(`${store.key}|${sku}|${url}`, {
        site: 'dealers', section: 'price_watch', sku, retailer: store.key, label: store.label, market: store.market,
        url, host, verdict: 'pending', note: null, scanned_at: new Date().toISOString(),
      });
    }
  }
}
const existing = new Set((await getAll('where_to_buy_links?select=retailer,sku,url&site=eq.dealers')).map((r) => `${r.retailer}|${r.sku}|${r.url}`));
const fresh = [...found.entries()].filter(([k]) => !existing.has(k)).map(([, v]) => v);

const tally = {};
for (const r of found.values()) tally[r.retailer] = (tally[r.retailer] ?? 0) + 1;
console.log(`Links in the reports: ${found.size} (${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(', ')}); already loaded ${found.size - fresh.length}; new ${fresh.length}`);
if (unknown.size) console.log(`Rows naming no PIM product (left out): ${unknown.size} — e.g. ${[...unknown].slice(0, 8).join(' | ')}`);
if (!APPLY) { console.log('Dry run — add --apply to load them.'); process.exit(0); }
for (let i = 0; i < fresh.length; i += 500) {
  const r = await fetch(`${BASE}/rest/v1/where_to_buy_links`, { method: 'POST', headers: { ...SR, Prefer: 'return=minimal' }, body: JSON.stringify(fresh.slice(i, i + 500)) });
  if (!r.ok) throw new Error(`insert ${r.status}: ${(await r.text()).slice(0, 300)}`);
}
console.log(`Loaded ${fresh.length} links — the audit's checks read them over the next hours (Aquarina through Bright Data).`);
