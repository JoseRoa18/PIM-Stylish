import { supabase } from '@/lib/supabase';
import { etToday, promoWindow } from '../lib/promoCalendar';
import { logActivity, getActivityActor } from '@/features/activity/api/activityLog';
import { pushProductToWix } from '@/features/syndication/api/wixSync';
import { pushBestBuyPrices } from '@/features/syndication/api/bestbuySync';
import { getAppSetting } from '@/features/settings/api/appSettings';

/**
 * Monthly promotions. Promo prices come from the user's official lists (one
 * price per SKU — never computed), one promotion per month, applying to all
 * marketplaces. "Apply" copies the CAD promo price into the products'
 * on_sale/sale_price_cad (what the Wix push reads).
 *
 * Application is AUTOMATED where an API can write prices (rule of 2026-08-18,
 * switches in /settings): the promo-apply cron applies the month's promo at
 * 00:00 on the 1st (VET) and pushes the SinksDirect Wix sites; Best Buy gets
 * its discounts SCHEDULED in Mirakl when the list is loaded (see
 * autoScheduleBestBuyPromo) and Mirakl flips them at the start date itself.
 * Everything else (content pushes, channels without a price API) stays manual.
 */

export async function listPromotions() {
  const { data, error } = await supabase
    .from('promotions')
    .select('id, name, period, status, kind, marketplaces, starts_on, ends_on, created_at, created_by, activated_at, ended_at, bb_scheduled_at, bb_schedule, promotion_prices(count), creator:profiles(full_name, email)')
    .order('period', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((p) => ({
    ...p,
    sku_count: p.promotion_prices?.[0]?.count ?? 0,
    created_by_name: p.creator?.full_name || p.creator?.email || null,
  }));
}

export async function getPromotionPrices(promotionId) {
  const { data, error } = await supabase
    .from('promotion_prices')
    .select('id, sku, promo_price_cad, promo_price_usd, promo_costs')
    .eq('promotion_id', promotionId)
    .order('sku');
  if (error) throw error;
  return data ?? [];
}

/**
 * SKUs (among `skus`) switched off for a marketplace — products.channel_exclusions
 * carries the promo channel keys a product must stay out of (rule 2026-09-22).
 */
export async function excludedSkus(channelKey, skus) {
  const out = new Set();
  const list = [...new Set(skus)];
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await supabase
      .from('products')
      .select('sku')
      .contains('channel_exclusions', [channelKey])
      .in('sku', list.slice(i, i + 200));
    if (error) throw error;
    for (const p of data ?? []) out.add(p.sku);
  }
  return out;
}

/** The promotion's price rows minus the products excluded on `channelKey`. */
export async function promotionMembersFor(promotion, channelKey) {
  const prices = await getPromotionPrices(promotion.id);
  const ex = channelKey ? await excludedSkus(channelKey, prices.map((r) => r.sku)) : new Set();
  return { rows: prices.filter((r) => !ex.has(r.sku)), excluded: [...ex].sort() };
}

/**
 * Parse a pasted price list ("SKU<tab or spaces>price" per line; $ and
 * thousands commas tolerated). Returns { rows, skipped } — rows are NOT
 * validated against the PIM here; createPromotion does that.
 */
export function parsePriceList(text) {
  const rows = [];
  const skipped = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\S+)[\s\t]+\$?([\d,]+(?:\.\d+)?)\s*$/);
    if (!m) { skipped.push(line); continue; }
    const price = Number(m[2].replace(/,/g, ''));
    if (!Number.isFinite(price) || price <= 0) { skipped.push(line); continue; }
    rows.push({ sku: m[1], price });
  }
  return { rows, skipped };
}

/**
 * Create a promotion with its price rows. `currency` decides which column
 * the pasted prices fill ('cad' | 'usd'). SKUs missing from the PIM are
 * returned, never inserted (FK would reject them anyway).
 */
/**
 * Parse a pasted SKU list: one SKU per line (a price after it, if any, is
 * ignored — prices come from the product's price level). Returns unique
 * SKUs in order and the lines that held nothing usable.
 */
export function parseSkuList(text) {
  const skus = [];
  const seen = new Set();
  const skipped = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:[\s,;].*)?$/);
    if (!m) { skipped.push(line); continue; }
    const sku = m[1].toUpperCase();
    if (seen.has(sku)) continue;
    seen.add(sku);
    skus.push(sku);
  }
  return { skus, skipped };
}

// The product columns that hold each price level, keyed like the promotion
// rows (promo_price_* and the promo_costs slugs), so a promotion built from
// a level carries the same shape the channels already read.
export const LEVEL_FIELDS = {
  orange: {
    promo_price_cad: 'map_orange_cad',
    promo_price_usd: 'map_orange_usd',
    costs: { rona_hd_cad: 'cost_cad_rona_hd_orange', sod_cad: 'cost_cad_wayfair_sod_orange', lowes_sod_bbb_usd: 'cost_usd_lowes_sod_bbb_orange', wayfair_usd: 'cost_usd_wayfair_orange', menards_usd: 'cost_usd_menards_orange' },
  },
  purple: {
    promo_price_cad: 'map_purple_cad',
    promo_price_usd: 'map_purple_usd',
    costs: { rona_hd_cad: 'cost_cad_rona_hd_purple', sod_cad: 'cost_cad_wayfair_sod_purple', lowes_sod_bbb_usd: 'cost_usd_lowes_sod_bbb_purple', wayfair_usd: 'cost_usd_wayfair_purple', menards_usd: 'cost_usd_menards_purple' },
  },
};

/**
 * Create a promotion from a SKU list, taking every price from the products'
 * price level (Purple for flash deals and special events, Orange for a
 * monthly promotion): promo MAP CAD/USD and the WC of each channel group.
 * Returns the SKUs not in the PIM and those with no price on that level in
 * either market (added anyway, so the files can report them).
 */
/**
 * The promotion rows a SKU list gets from a price level: promo MAP CAD/USD
 * and the WC of each channel group, read from the products. SKUs not in the
 * PIM are reported, and so are those with no price on that level at all
 * (still returned, so the files can report them).
 */
async function levelPriceRows(skus, tier) {
  const level = LEVEL_FIELDS[tier];
  if (!level) throw new Error(`Unknown price level "${tier}".`);
  const wanted = [...new Set(skus)];
  const cols = ['sku', level.promo_price_cad, level.promo_price_usd, ...Object.values(level.costs)].join(', ');
  const found = new Map();
  for (let i = 0; i < wanted.length; i += 200) {
    const { data, error } = await supabase.from('products').select(cols).in('sku', wanted.slice(i, i + 200));
    if (error) throw error;
    for (const p of data ?? []) found.set(p.sku, p);
  }
  const valid = wanted.filter((s) => found.has(s));
  const notInPim = wanted.filter((s) => !found.has(s));
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const noLevel = [];
  const rows = valid.map((sku) => {
    const p = found.get(sku);
    const costs = {};
    for (const [slug, col] of Object.entries(level.costs)) if (num(p[col]) != null) costs[slug] = num(p[col]);
    const row = { sku, promo_price_cad: num(p[level.promo_price_cad]), promo_price_usd: num(p[level.promo_price_usd]), promo_costs: costs };
    if (row.promo_price_cad == null && row.promo_price_usd == null && !Object.keys(costs).length) noLevel.push(sku);
    return row;
  });
  return { rows, valid, notInPim, noLevel };
}

/**
 * Replace the SKU list of a flash deal / special event: SKUs added get
 * their prices from the level, SKUs no longer listed are removed, the rest
 * keep what they have. Returns what changed.
 */
export async function setPromotionSkusFromLevel(promotion, skus, tier = 'purple') {
  const wanted = [...new Set((skus ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) throw new Error('Keep at least one SKU.');
  const current = await getPromotionPrices(promotion.id);
  const have = new Set(current.map((r) => r.sku));
  const toAdd = wanted.filter((s) => !have.has(s));
  const keep = new Set(wanted);
  const toRemove = current.filter((r) => !keep.has(r.sku));
  const { rows, valid, notInPim, noLevel } = toAdd.length ? await levelPriceRows(toAdd, tier) : { rows: [], valid: [], notInPim: [], noLevel: [] };
  if (!valid.length && toRemove.length === current.length) throw new Error('None of the SKUs in the list exist in the PIM.');
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from('promotion_prices').insert(rows.slice(i, i + 200).map((r) => ({ promotion_id: promotion.id, ...r })));
    if (error) throw error;
  }
  if (toRemove.length) {
    const { error } = await supabase.from('promotion_prices').delete().in('id', toRemove.map((r) => r.id));
    if (error) throw error;
  }
  logActivity({
    action: 'update',
    entityType: 'promotion',
    entityId: String(promotion.id),
    summary: `SKUs of "${promotion.name}" changed: ${valid.length} added, ${toRemove.length} removed (${tier} level)`,
    metadata: { added: valid.slice(0, 100), removed: toRemove.map((r) => r.sku).slice(0, 100), not_in_pim: notInPim.slice(0, 50), no_level: noLevel.slice(0, 50), tier },
  });
  return { added: valid.length, removed: toRemove.length, notInPim, noLevel };
}

// `marketplaces` are the PROMO_CHANNELS keys the promotion is made for
// (flash deals and special events go to the portals picked on creation,
// one or several); empty/null means every marketplace (monthly).
export async function createPromotionFromLevels({ name, period, kind = 'flash', starts_on = null, ends_on = null, skus, tier = 'purple', marketplaces = [] }) {
  assertKindDates(kind, starts_on, ends_on);
  const portals = [...new Set((marketplaces ?? []).filter(Boolean))];
  if (kind !== 'monthly' && !portals.length) throw new Error(`Pick at least one portal this ${PROMOTION_KINDS[kind]?.toLowerCase() ?? kind} is for.`);
  const wanted = [...new Set(skus)];
  if (!wanted.length) throw new Error('Paste at least one SKU.');
  const { rows, valid, notInPim, noLevel } = await levelPriceRows(wanted, tier);
  if (!valid.length) throw new Error('None of the SKUs in the list exist in the PIM.');

  const { data: promo, error } = await supabase
    .from('promotions')
    .insert({ name, period, status: 'draft', kind, starts_on, ends_on, marketplaces: portals.length ? portals : null, created_by: getActivityActor()?.id ?? null })
    .select()
    .single();
  if (error) throw error;

  const priceRows = rows.map((r) => ({ promotion_id: promo.id, ...r }));
  for (let i = 0; i < priceRows.length; i += 200) {
    const { error: insErr } = await supabase.from('promotion_prices').insert(priceRows.slice(i, i + 200));
    if (insErr) throw insErr;
  }

  logActivity({
    action: 'create',
    entityType: 'promotion',
    entityId: String(promo.id),
    summary: `Created ${PROMOTION_KINDS[kind]?.toLowerCase() ?? kind} "${name}" from the ${tier} level (${valid.length} SKUs${portals.length ? `, for ${portals.join(', ')}` : ''})`,
    metadata: { period, kind, tier, marketplaces: portals, skus: valid.length, not_in_pim: notInPim.length, no_level: noLevel.length },
  });
  return { promotion: promo, added: valid.length, notInPim, noLevel };
}

/** Change the portals a flash deal / special event goes to (at least one). */
export async function updatePromotionMarketplaces(promotion, marketplaces) {
  const portals = [...new Set((marketplaces ?? []).filter(Boolean))];
  if ((promotion.kind ?? 'monthly') !== 'monthly' && !portals.length) throw new Error('Keep at least one portal.');
  const { error } = await supabase.from('promotions').update({ marketplaces: portals.length ? portals : null }).eq('id', promotion.id);
  if (error) throw error;
  logActivity({
    action: 'update',
    entityType: 'promotion',
    entityId: String(promotion.id),
    summary: `Portals of "${promotion.name}" set to ${portals.join(', ') || 'every marketplace'}`,
    metadata: { before: promotion.marketplaces ?? [], after: portals },
  });
  return portals;
}

// Promotion kinds: 'monthly' follows the market calendar and is automated on
// its boundaries; 'flash' (flash deal) and 'special' (special event) always run
// on their own dates and are pushed / exported by hand from their sections.
export const PROMOTION_KINDS = { monthly: 'Monthly promotion', flash: 'Flash deal', special: 'Special event' };
function assertKindDates(kind, starts_on, ends_on) {
  if (kind !== 'monthly' && !(starts_on && ends_on)) throw new Error(`A ${PROMOTION_KINDS[kind]?.toLowerCase() ?? kind} needs a first and a last day.`);
}

export async function createPromotion({ name, period, currency, rows, kind = 'monthly', starts_on = null, ends_on = null }) {
  assertKindDates(kind, starts_on, ends_on);
  const { data: prods, error: prodErr } = await supabase.from('products').select('sku');
  if (prodErr) throw prodErr;
  const pimSkus = new Set((prods ?? []).map((p) => p.sku));

  const valid = rows.filter((r) => pimSkus.has(r.sku));
  const notInPim = rows.filter((r) => !pimSkus.has(r.sku)).map((r) => r.sku);
  if (!valid.length) throw new Error('None of the SKUs in the list exist in the PIM.');

  const { data: promo, error } = await supabase
    .from('promotions')
    .insert({ name, period, status: 'draft', kind, starts_on, ends_on, created_by: getActivityActor()?.id ?? null })
    .select()
    .single();
  if (error) throw error;

  const col = currency === 'usd' ? 'promo_price_usd' : 'promo_price_cad';
  const priceRows = valid.map((r) => ({ promotion_id: promo.id, sku: r.sku, [col]: r.price }));
  for (let i = 0; i < priceRows.length; i += 200) {
    const { error: insErr } = await supabase.from('promotion_prices').insert(priceRows.slice(i, i + 200));
    if (insErr) throw insErr;
  }

  logActivity({
    action: 'create',
    entityType: 'promotion',
    entityId: String(promo.id),
    summary: `Created promotion "${name}" (${valid.length} SKUs)`,
    metadata: { period, currency, skus: valid.length, not_in_pim: notInPim.length },
  });
  return { promotion: promo, added: valid.length, notInPim };
}

/**
 * Create a promotion from full row objects (the file-import path):
 *   [{ sku, promo_price_cad, promo_price_usd, promo_costs }]
 */
export async function createPromotionFromFile({ name, period, rows, kind = 'monthly', starts_on = null, ends_on = null }) {
  assertKindDates(kind, starts_on, ends_on);
  const { data: prods, error: prodErr } = await supabase.from('products').select('sku');
  if (prodErr) throw prodErr;
  const pimSkus = new Set((prods ?? []).map((p) => p.sku));

  const valid = rows.filter((r) => pimSkus.has(r.sku));
  const notInPim = rows.filter((r) => !pimSkus.has(r.sku)).map((r) => r.sku);
  if (!valid.length) throw new Error('None of the SKUs in the file exist in the PIM.');

  const { data: promo, error } = await supabase
    .from('promotions')
    .insert({ name, period, status: 'draft', kind, starts_on, ends_on, created_by: getActivityActor()?.id ?? null })
    .select()
    .single();
  if (error) throw error;

  const priceRows = valid.map((r) => ({
    promotion_id: promo.id,
    sku: r.sku,
    promo_price_cad: r.promo_price_cad ?? null,
    promo_price_usd: r.promo_price_usd ?? null,
    promo_costs: r.promo_costs ?? {},
  }));
  for (let i = 0; i < priceRows.length; i += 200) {
    const { error: insErr } = await supabase.from('promotion_prices').insert(priceRows.slice(i, i + 200));
    if (insErr) throw insErr;
  }

  logActivity({
    action: 'create',
    entityType: 'promotion',
    entityId: String(promo.id),
    summary: `Created promotion "${name}" from file (${valid.length} SKUs)`,
    metadata: { period, skus: valid.length, not_in_pim: notInPim.length },
  });
  return { promotion: promo, added: valid.length, notInPim };
}

/**
 * Merge full row objects (a market file) into an existing promotion. Values
 * present in the file win; everything else on the row is preserved — so the
 * Canada file and the USA file can arrive at different times.
 */
export async function addFileToPromotion(promotion, rows) {
  const { data: prods, error: prodErr } = await supabase.from('products').select('sku');
  if (prodErr) throw prodErr;
  const pimSkus = new Set((prods ?? []).map((p) => p.sku));
  const valid = rows.filter((r) => pimSkus.has(r.sku));
  const notInPim = rows.filter((r) => !pimSkus.has(r.sku)).map((r) => r.sku);

  const existing = await getPromotionPrices(promotion.id);
  const bySku = new Map(existing.map((r) => [r.sku, r]));

  const upserts = valid.map((r) => {
    const prev = bySku.get(r.sku);
    return {
      promotion_id: promotion.id,
      sku: r.sku,
      promo_price_cad: r.promo_price_cad ?? prev?.promo_price_cad ?? null,
      promo_price_usd: r.promo_price_usd ?? prev?.promo_price_usd ?? null,
      promo_costs: { ...(prev?.promo_costs ?? {}), ...(r.promo_costs ?? {}) },
    };
  });
  for (let i = 0; i < upserts.length; i += 200) {
    const { error } = await supabase
      .from('promotion_prices')
      .upsert(upserts.slice(i, i + 200), { onConflict: 'promotion_id,sku' });
    if (error) throw error;
  }

  logActivity({
    action: 'update',
    entityType: 'promotion',
    entityId: String(promotion.id),
    summary: `Imported file into promotion "${promotion.name}" (${valid.length} SKUs)`,
    metadata: { skus: valid.length, not_in_pim: notInPim.length },
  });
  return { added: valid.length, notInPim };
}

/**
 * Mark a draft promotion as active WITHOUT touching store pricing — for
 * promotions that were already uploaded to the marketplaces outside the PIM.
 */
/**
 * Custom dates for a promotion (both or none). They replace the market
 * calendar on every channel: files, Wix pricing, Best Buy, Walmart and the
 * activation cron. Pass nulls to go back to the calendar.
 */
export async function updatePromotionDates(promotion, { starts_on, ends_on }) {
  const both = Boolean(starts_on) && Boolean(ends_on);
  if ((starts_on || ends_on) && !both) throw new Error('Set both dates, or clear both to use the market calendar.');
  if (both && ends_on < starts_on) throw new Error('The end date is before the start date.');
  const { error } = await supabase
    .from('promotions')
    .update({ starts_on: both ? starts_on : null, ends_on: both ? ends_on : null })
    .eq('id', promotion.id);
  if (error) throw error;
  logActivity({
    action: 'update',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: 'pim',
    summary: both ? `"${promotion.name}" runs on custom dates ${starts_on} to ${ends_on}` : `"${promotion.name}" back on the market calendar`,
    metadata: { starts_on: both ? starts_on : null, ends_on: both ? ends_on : null },
  });
}

/**
 * Which of `skus` are already in a MONTHLY promotion whose window overlaps
 * [startsOn, endsOn] on either market. Used to warn before creating a flash
 * deal or special event (rule 2026-09-22).
 */
export async function monthlyOverlap(startsOn, endsOn, skus) {
  const { data, error } = await supabase
    .from('promotions')
    .select('id, name, period, starts_on, ends_on, promotion_prices(sku)')
    .eq('kind', 'monthly')
    .in('status', ['draft', 'active']);
  if (error) throw error;
  const wanted = new Set(skus);
  for (const p of data ?? []) {
    const windows = [promoWindow(p, 'us'), promoWindow(p, 'ca')];
    if (!windows.some((w) => w.start <= endsOn && w.end >= startsOn)) continue;
    const hit = (p.promotion_prices ?? []).map((r) => r.sku).filter((s) => wanted.has(s)).sort();
    if (hit.length) return { promotion: p.name, skus: hit };
  }
  return { promotion: null, skus: [] };
}

export async function markPromotionActive(promotion) {
  const { error } = await supabase
    .from('promotions')
    .update({ status: 'active', activated_at: new Date().toISOString() })
    .eq('id', promotion.id);
  if (error) throw error;
  logActivity({
    action: 'update',
    entityType: 'promotion',
    entityId: String(promotion.id),
    summary: `Marked promotion "${promotion.name}" as active (already live on marketplaces)`,
  });
}

/**
 * Merge more pasted rows into an existing promotion (upsert by SKU).
 */
export async function addPricesToPromotion(promotionId, { currency, rows }) {
  const { data: prods, error: prodErr } = await supabase.from('products').select('sku');
  if (prodErr) throw prodErr;
  const pimSkus = new Set((prods ?? []).map((p) => p.sku));
  const valid = rows.filter((r) => pimSkus.has(r.sku));
  const notInPim = rows.filter((r) => !pimSkus.has(r.sku)).map((r) => r.sku);

  const col = currency === 'usd' ? 'promo_price_usd' : 'promo_price_cad';
  const priceRows = valid.map((r) => ({ promotion_id: promotionId, sku: r.sku, [col]: r.price }));
  for (let i = 0; i < priceRows.length; i += 200) {
    const { error } = await supabase
      .from('promotion_prices')
      .upsert(priceRows.slice(i, i + 200), { onConflict: 'promotion_id,sku' });
    if (error) throw error;
  }
  return { added: valid.length, notInPim };
}

export async function removePromotionPrice(rowId) {
  const { error } = await supabase.from('promotion_prices').delete().eq('id', rowId);
  if (error) throw error;
}

export async function deletePromotion(promotionId) {
  const { error } = await supabase.from('promotions').delete().eq('id', promotionId);
  if (error) throw error;
  logActivity({
    action: 'delete',
    entityType: 'promotion',
    entityId: String(promotionId),
    summary: `Deleted promotion #${promotionId}`,
  });
}

/**
 * Apply the promotion to the store pricing: for every member SKU with a CAD
 * promo price, set on_sale + sale_price_cad in the PIM. Does NOT push —
 * pushes are always a separate, manual step.
 */
export async function applyPromotion(promotion) {
  const prices = await getPromotionPrices(promotion.id);
  const withCad = prices.filter((r) => r.promo_price_cad != null);
  for (const row of withCad) {
    const { error } = await supabase
      .from('products')
      .update({ on_sale: true, sale_price_cad: row.promo_price_cad })
      .eq('sku', row.sku);
    if (error) throw error;
  }
  const { error } = await supabase
    .from('promotions')
    .update({ status: 'active', activated_at: new Date().toISOString() })
    .eq('id', promotion.id);
  if (error) throw error;

  logActivity({
    action: 'update',
    entityType: 'promotion',
    entityId: String(promotion.id),
    summary: `Applied promotion "${promotion.name}" to PIM pricing (${withCad.length} SKUs on sale)`,
    metadata: { skus: withCad.length },
  });
  return { applied: withCad.length };
}

/**
 * End the promotion: clear on_sale/sale_price_cad on every member SKU.
 * Does NOT push — same manual rule.
 */
export async function endPromotion(promotion) {
  const prices = await getPromotionPrices(promotion.id);
  for (const row of prices) {
    const { error } = await supabase
      .from('products')
      .update({ on_sale: false, sale_price_cad: null })
      .eq('sku', row.sku);
    if (error) throw error;
  }
  const { error } = await supabase
    .from('promotions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', promotion.id);
  if (error) throw error;

  logActivity({
    action: 'update',
    entityType: 'promotion',
    entityId: String(promotion.id),
    summary: `Ended promotion "${promotion.name}" (${prices.length} SKUs back to regular price)`,
    metadata: { skus: prices.length },
  });
  return { cleared: prices.length };
}

/**
 * Schedule the promotion's CAD prices on Best Buy as Mirakl SCHEDULED
 * discounts for exactly the promo month — Mirakl turns them on at 00:00 of
 * the start date and off after the end date on its own, so nothing needs to
 * run at midnight. Called automatically after a promo list is loaded or
 * updated (honors the 'promo_automation' switches; re-running overwrites the
 * previous schedule, so updates are safe). Only SKUs with a live Best Buy
 * offer in the latest snapshot are sent; the regular price rides along as the
 * PIM MAP so stale MAPs get corrected in the same import.
 */
export async function autoScheduleBestBuyPromo(promotion) {
  const settings = await getAppSetting('promo_automation', {});
  if (settings.enabled === false || settings.bestbuy === false) return { skipped: 'automation off' };

  const window = promoWindow(promotion, 'ca');
  if (window.end < etToday()) return { skipped: 'past promotion' };

  const { rows: prices, excluded } = await promotionMembersFor(promotion, 'bestbuy');
  const members = prices.filter((r) => r.promo_price_cad != null);
  if (!members.length) return { skipped: excluded.length ? 'every member is excluded from Best Buy' : 'no CAD prices yet' };

  const { data: snap, error: snapErr } = await supabase
    .from('channel_health')
    .select('results')
    .eq('channel', 'bestbuy')
    .order('run_at', { ascending: false })
    .limit(1);
  if (snapErr) throw snapErr;
  const listed = new Set((snap?.[0]?.results ?? []).map((o) => o.sku));

  const mapBySku = new Map();
  const skus = members.map((r) => r.sku);
  for (let i = 0; i < skus.length; i += 100) {
    const { data, error } = await supabase
      .from('products')
      .select('sku, map_cad')
      .in('sku', skus.slice(i, i + 100));
    if (error) throw error;
    for (const p of data ?? []) mapBySku.set(p.sku, p.map_cad);
  }

  // Canada window (first Thursday → day before the next first Thursday). A
  // window that already began is scheduled from tomorrow — Mirakl drops a
  // discount whose start date is not strictly in the future.
  const start = window.start > etToday() ? window.start : etToday(1);
  const end = window.end;
  const updates = [];
  const skippedAtOrAboveMap = [];
  for (const m of members) {
    if (!listed.has(m.sku)) continue;
    const map = mapBySku.get(m.sku);
    if (map != null && m.promo_price_cad >= map) { skippedAtOrAboveMap.push(m.sku); continue; }
    updates.push({
      sku: m.sku,
      ...(map != null ? { price: map } : {}),
      discount_price: m.promo_price_cad,
      discount_start_date: start,
      discount_end_date: end,
    });
  }
  const notListed = members.length - updates.length - skippedAtOrAboveMap.length;

  let res = null;
  if (updates.length) res = await pushBestBuyPrices(updates);

  const report = {
    at: new Date().toISOString(),
    period: promotion.period,
    start,
    end,
    scheduled: Math.max(0, updates.length - (res?.lines_in_error ?? 0)),
    attempted: updates.length,
    not_listed: notListed,
    skipped_at_or_above_map: skippedAtOrAboveMap,
    import_id: res?.import_id ?? null,
    lines_in_error: res?.lines_in_error ?? 0,
  };
  const { error: upErr } = await supabase
    .from('promotions')
    .update({ bb_scheduled_at: report.at, bb_schedule: report })
    .eq('id', promotion.id);
  if (upErr) throw upErr;

  logActivity({
    action: 'push',
    entityType: 'promotion',
    entityId: String(promotion.id),
    target: 'bestbuy',
    summary: `Scheduled "${promotion.name}" on Best Buy — ${report.scheduled} discounts for ${start} → ${end}` +
      (notListed ? ` · ${notListed} not listed there` : ''),
    metadata: report,
  });
  return report;
}

/**
 * Schedule the promotion on Walmart Canada as promotional prices (feed
 * PRICE_AND_PROMOTION): regular price = the PIM MAP CAD, promo price = the
 * promo MAP CAD, window = Canada's (first Thursday to the day before the
 * next one). Walmart turns it on and off by itself. `skus` restricts the
 * push (controlled tests); `dryRun` returns the payload and sends nothing.
 */
export async function scheduleWalmartCaPromo(promotion, { skus = null, dryRun = false } = {}) {
  const { data, error } = await supabase.functions.invoke('walmart-push-promo', {
    body: { mode: 'push', promotionId: promotion.id, dryRun, ...(skus ? { skus } : {}) },
  });
  if (error) throw new Error(error.message ?? 'walmart-push-promo failed');
  if (data?.error) throw new Error(data.error);
  if (!dryRun) {
    logActivity({
      action: 'push',
      entityType: 'promotion',
      entityId: String(promotion.id),
      target: 'walmart_ca',
      summary: `Scheduled "${promotion.name}" on Walmart Canada — ${data.attempted} promo prices (feed ${data.feedId ?? '?'})` +
        (data.itemsFailed ? ` · ${data.itemsFailed} rejected` : '') + (data.not_listed ? ` · ${data.not_listed} not listed there` : ''),
      metadata: { feed_id: data.feedId, attempted: data.attempted, failed: data.itemsFailed ?? 0, not_listed: data.not_listed, skus: skus ?? null },
    });
  }
  return data;
}

/**
 * Push the promotion's member products to Wix (only those linked), one by
 * one with progress. Used after apply AND after end — it just syncs the
 * products' current pricing state to the store.
 */
export async function pushPromotionToWix(promotion, onProgress) {
  const prices = await getPromotionPrices(promotion.id);
  const skus = prices.map((r) => r.sku);
  const { data: prods, error } = await supabase
    .from('products')
    .select('sku, wix_product_id')
    .in('sku', skus);
  if (error) throw error;
  const linked = (prods ?? []).filter((p) => p.wix_product_id).map((p) => p.sku);

  let done = 0;
  const failures = [];
  for (const sku of linked) {
    try {
      await pushProductToWix(sku);
    } catch (err) {
      failures.push(`${sku}: ${err.message}`);
    }
    done += 1;
    onProgress?.({ done, total: linked.length });
  }
  return { pushed: done - failures.length, total: linked.length, notLinked: skus.length - linked.length, failures };
}
