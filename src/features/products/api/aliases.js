import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { WIX_SITES } from '@/features/syndication/lib/wixSites';

/**
 * Every name a product answers to outside the PIM.
 *
 * Two sources feed the Aliases tab:
 *   - linked systems the PIM already talks to (Wix product ids, Wayfair
 *     listing ids, Amazon seller SKUs + ASINs) — shown as they are, and the
 *     Amazon ones can be added here because Amazon files are keyed by them;
 *   - product_aliases, the free list for every other marketplace (Home
 *     Depot item numbers, Lowe's, Menards, Walmart, Rona, Best Buy, BB&B…).
 */

export const ALIAS_MARKETPLACES = [
  'Home Depot CA',
  'Home Depot US',
  "Lowe's CA",
  "Lowe's US",
  'Menards',
  'Walmart CA',
  'Walmart US',
  'Rona',
  'Best Buy CA',
  'BB&B / Overstock',
  'Costco',
  'Other',
];

export const ALIAS_KINDS = [
  { value: 'sku', label: 'Marketplace SKU' },
  { value: 'item_id', label: 'Item / listing id' },
  { value: 'upc', label: 'UPC / GTIN' },
  { value: 'other', label: 'Other' },
];

/** One flat list for the tab: system rows first, then the manual ones. */
export async function loadAliases(product) {
  const sku = product.sku;
  const [{ data: wix }, { data: amazon }, { data: manual }] = await Promise.all([
    supabase.from('wix_links').select('site, wix_product_id').eq('sku', sku),
    supabase.from('amazon_links').select('marketplace, seller_sku, asin, fulfillment').eq('sku', sku).order('seller_sku'),
    supabase.from('product_aliases').select('*').eq('sku', sku).order('marketplace').order('alias'),
  ]);
  const rows = [];
  for (const l of wix ?? []) {
    rows.push({ id: `wix:${l.site}`, marketplace: WIX_SITES[l.site]?.label ?? l.site, alias: l.wix_product_id, kind: 'Product id', source: 'wix', locked: true, note: 'Managed by the store link' });
  }
  if (!(wix ?? []).some((l) => l.site === 'sinksdirect_ca') && product.wix_product_id) {
    rows.push({ id: 'wix:sinksdirect_ca', marketplace: WIX_SITES.sinksdirect_ca.label, alias: product.wix_product_id, kind: 'Product id', source: 'wix', locked: true, note: 'Managed by the store link' });
  }
  if (product.wayfair_item_group_id) rows.push({ id: 'wayfair:ca', marketplace: 'Wayfair Canada', alias: product.wayfair_item_group_id, kind: 'Listing id', source: 'wayfair', locked: true, note: 'Managed by the Wayfair card' });
  if (product.wayfair_usa_item_group_id) rows.push({ id: 'wayfair:us', marketplace: 'Wayfair USA', alias: product.wayfair_usa_item_group_id, kind: 'Listing id', source: 'wayfair', locked: true, note: 'Managed by the Wayfair card' });
  for (const a of amazon ?? []) {
    rows.push({ id: `amazon:${a.marketplace}:${a.seller_sku}`, marketplace: a.marketplace === 'us' ? 'Amazon USA' : 'Amazon Canada', alias: a.seller_sku, kind: 'Seller SKU', source: 'amazon', amazonMarketplace: a.marketplace, note: [a.asin ? `ASIN ${a.asin}` : null, a.fulfillment].filter(Boolean).join(' · ') || null });
  }
  for (const a of manual ?? []) {
    rows.push({ id: a.id, marketplace: a.marketplace, alias: a.alias, kind: ALIAS_KINDS.find((k) => k.value === a.kind)?.label ?? a.kind, kindValue: a.kind, source: 'manual', note: a.note });
  }
  return rows;
}

/** Add an alias. Amazon marketplaces write amazon_links; the rest product_aliases. */
export async function addAlias(sku, { marketplace, alias, kind = 'sku', note = null }) {
  const value = String(alias ?? '').trim();
  if (!value) throw new Error('Type the alias.');
  const amazon = /^amazon (canada|usa)$/i.test(marketplace) ? (/usa/i.test(marketplace) ? 'us' : 'ca') : null;
  if (amazon) {
    const { error } = await supabase.from('amazon_links').insert({ marketplace: amazon, seller_sku: value, sku });
    if (error) throw new Error(/duplicate|unique/i.test(error.message) ? `${value} is already the Amazon ${amazon.toUpperCase()} seller SKU of another product.` : error.message);
  } else {
    const { error } = await supabase.from('product_aliases').insert({ sku, marketplace, alias: value, kind, note: note || null });
    if (error) throw new Error(/duplicate|unique/i.test(error.message) ? `${value} is already an alias of another product on ${marketplace}.` : error.message);
  }
  logActivity({ action: 'update', entityType: 'product', entityId: sku, target: 'pim', summary: `Added alias ${value} (${marketplace}) to ${sku}`, metadata: { marketplace, alias: value, kind } });
}

export async function removeAlias(sku, row) {
  if (row.source === 'amazon') {
    const { error } = await supabase.from('amazon_links').delete().eq('marketplace', row.amazonMarketplace).eq('seller_sku', row.alias);
    if (error) throw error;
  } else if (row.source === 'manual') {
    const { error } = await supabase.from('product_aliases').delete().eq('id', row.id);
    if (error) throw error;
  } else {
    throw new Error('This alias is managed by its channel link.');
  }
  logActivity({ action: 'update', entityType: 'product', entityId: sku, target: 'pim', summary: `Removed alias ${row.alias} (${row.marketplace}) from ${sku}`, metadata: { marketplace: row.marketplace, alias: row.alias } });
}

/**
 * Paste a list ("alias<TAB>sku" or "alias,sku" per line) for one marketplace.
 * Lines whose SKU is not in the PIM are reported, never written.
 */
export async function importAliasList(marketplace, text, kind = 'sku') {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pairs = [];
  for (const line of lines) {
    const [a, b] = line.split(/\t|,|;/).map((s) => s?.trim());
    if (!a || !b || /^(seller[- _]?sku|alias)$/i.test(a)) continue;
    pairs.push({ alias: a, sku: b });
  }
  if (!pairs.length) throw new Error('No "alias, SKU" lines found. One pair per line, separated by a tab or a comma.');
  const skus = [...new Set(pairs.map((p) => p.sku))];
  const known = new Set();
  for (let i = 0; i < skus.length; i += 200) {
    const { data } = await supabase.from('products').select('sku').in('sku', skus.slice(i, i + 200));
    for (const p of data ?? []) known.add(p.sku);
  }
  const usable = pairs.filter((p) => known.has(p.sku));
  const notInPim = [...new Set(pairs.filter((p) => !known.has(p.sku)).map((p) => p.sku))];
  const amazon = /^amazon (canada|usa)$/i.test(marketplace) ? (/usa/i.test(marketplace) ? 'us' : 'ca') : null;
  let written = 0;
  for (let i = 0; i < usable.length; i += 200) {
    const chunk = usable.slice(i, i + 200);
    const { error } = amazon
      ? await supabase.from('amazon_links').upsert(chunk.map((p) => ({ marketplace: amazon, seller_sku: p.alias, sku: p.sku })), { onConflict: 'marketplace,seller_sku' })
      : await supabase.from('product_aliases').upsert(chunk.map((p) => ({ marketplace, alias: p.alias, sku: p.sku, kind })), { onConflict: 'marketplace,alias' });
    if (error) throw error;
    written += chunk.length;
  }
  logActivity({ action: 'import', entityType: 'product', entityId: `${written} aliases`, target: 'pim', summary: `Imported ${written} ${marketplace} aliases${notInPim.length ? ` · ${notInPim.length} SKUs not in the PIM` : ''}`, metadata: { marketplace, written, notInPim: notInPim.slice(0, 50) } });
  return { written, notInPim };
}
