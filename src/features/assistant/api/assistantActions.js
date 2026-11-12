import { getProduct, setProductsObsolete, updateProduct } from '@/features/products/api/products';
import { priceProblems } from '@/features/products/lib/priceRules';
import { logActivity } from '@/features/activity/api/activityLog';
import { claimAction, decideAction } from './assistant';

// A change the assistant PREPARED and the person confirmed. It is made here,
// in the browser, through the app's own saves — the same checks, the same
// Activity Log entries and the same permissions as doing it by hand on the
// product page or the catalog. The assistant itself never writes.
//
//   set_obsolete  payload { obsolete, items: [{ sku, model }] }
//   set_prices    payload { items: [{ sku, model, field, label, from, to }] }
//
// Before anything is changed (user, 2026-11-12: validations on the assistant):
//   1. the card is CLAIMED in the database (assistant_claim_action,
//      20261112_assistant_guardrails.sql): it must be this person's, still
//      open, not older than a day, its kind not turned off — and it answers
//      once, so a card can never run twice. What is applied is the change the
//      database kept, not this page's copy of it;
//   2. that change is checked again here: only these two kinds, only a
//      product's obsolete mark or its eight price fields, plain numbers;
//   3. a price that moved since the card was made is not overwritten, and the
//      PIM's price rules are run on the product as it would be.
// The database's own triggers have the last word, as for any save.

const PRICE_FIELDS = new Set(['map_cad', 'map_usd', 'map_orange_cad', 'map_orange_usd', 'map_purple_cad', 'map_purple_usd', 'msrp_cad', 'msrp_usd']);
const MAX_ITEMS = 50;

const same = (a, b) => (a == null ? null : Number(a)) === (b == null ? null : Number(b));
const isSku = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= 60;
const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** The change as the database kept it, reduced to what may be applied. Throws when it is anything else. */
function applicable(kind, payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length || items.length > MAX_ITEMS) throw new Error('This change has nothing to apply, or more than a card may hold.');
  if (kind === 'set_obsolete') {
    if (typeof payload.obsolete !== 'boolean' || !items.every((i) => isSku(i?.sku))) throw new Error('This change is not one the chat can make.');
    return { obsolete: payload.obsolete, items: items.map((i) => ({ sku: i.sku })) };
  }
  if (kind === 'set_prices') {
    const fine = items.every((i) => isSku(i?.sku) && PRICE_FIELDS.has(i.field) && isPrice(i.to) && (i.from == null || typeof i.from === 'number'));
    if (!fine) throw new Error('This change is not one the chat can make.');
    return { items: items.map((i) => ({ sku: i.sku, field: i.field, label: String(i.label ?? i.field), from: i.from ?? null, to: i.to })) };
  }
  throw new Error('This kind of change cannot be made from the chat.');
}

async function setObsolete(payload) {
  const skus = payload.items.map((i) => i.sku);
  const changed = await setProductsObsolete(skus, payload.obsolete);
  if (!changed.length) return { ok: false, text: 'Nothing changed: the products were already that way.' };
  return { ok: true, skus: changed.map((p) => p.sku), text: `${changed.length} of ${skus.length} ${skus.length === 1 ? 'product' : 'products'} ${payload.obsolete ? 'marked obsolete' : 'no longer marked obsolete'}.` };
}

async function setPrices(payload) {
  const bySku = new Map();
  for (const item of payload.items) bySku.set(item.sku, [...(bySku.get(item.sku) ?? []), item]);
  const made = [];
  const refused = [];
  const skus = [];
  for (const [sku, items] of bySku) {
    try {
      const product = await getProduct(sku);
      if (!product) throw new Error('it is no longer in the PIM');
      // A price that changed since the card was made is not overwritten.
      const moved = items.find((i) => !same(product[i.field], i.from));
      if (moved) throw new Error(`${moved.label} is now ${product[moved.field] ?? 'empty'}, not ${moved.from ?? 'empty'}`);
      const patch = Object.fromEntries(items.map((i) => [i.field, i.to]));
      const problems = priceProblems({ ...product, ...patch }, Object.keys(patch));
      if (problems.length) throw new Error(problems.join(' '));
      await updateProduct(sku, patch);
      skus.push(sku);
      made.push(...items.map((i) => `${sku} ${i.label} ${i.from ?? 'empty'} → ${i.to}`));
    } catch (err) {
      refused.push(`${sku}: ${err.message}`);
    }
  }
  if (!made.length) return { ok: false, text: `Nothing changed. ${refused.join(' · ')}` };
  return { ok: true, skus, text: `Changed: ${made.join('; ')}.${refused.length ? ` Not changed — ${refused.join(' · ')}` : ''}` };
}

/**
 * Makes a confirmed change and records how it ended.
 * Returns { status: 'done' | 'failed', result }. Throws — with nothing
 * changed — when the database does not let this card run (not this person's,
 * already decided or started, older than a day, its kind turned off).
 */
export async function runAssistantAction(action) {
  const kept = await claimAction(action.id);
  let outcome;
  try {
    const payload = applicable(kept.kind, kept.payload);
    outcome = kept.kind === 'set_obsolete' ? await setObsolete(payload) : await setPrices(payload);
  } catch (err) {
    outcome = { ok: false, text: err.message || 'The change failed.' };
  }
  const status = outcome.ok ? 'done' : 'failed';
  // Each save wrote its own Activity Log entry; this one says they came from a card of the assistant.
  if (outcome.ok) {
    logActivity({
      action: 'update',
      entityType: 'product',
      entityId: outcome.skus.length === 1 ? outcome.skus[0] : `${outcome.skus.length} products`,
      summary: `Confirmed a change the assistant prepared: ${kept.summary}`,
      metadata: { source: 'assistant', action_id: kept.id, kind: kept.kind, skus: outcome.skus, result: outcome.text },
    });
  }
  // The change is what matters; if only the note fails, the card still shows what happened.
  await decideAction(action.id, status, outcome.text).catch(() => {});
  return { status, result: outcome.text };
}

/** The person said no: nothing changes. */
export async function cancelAssistantAction(action) {
  await decideAction(action.id, 'cancelled');
  return { status: 'cancelled', result: null };
}
