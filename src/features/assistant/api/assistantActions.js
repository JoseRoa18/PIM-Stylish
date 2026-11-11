import { getProduct, setProductsObsolete, updateProduct } from '@/features/products/api/products';
import { priceProblems } from '@/features/products/lib/priceRules';
import { decideAction } from './assistant';

// A change the assistant PREPARED and the person confirmed. It is made here,
// in the browser, through the app's own saves — the same checks, the same
// Activity Log entries and the same permissions as doing it by hand on the
// product page or the catalog. The assistant itself never writes.
//
//   set_obsolete  payload { obsolete, items: [{ sku, model }] }
//   set_prices    payload { items: [{ sku, model, field, label, from, to }] }

const same = (a, b) => (a == null ? null : Number(a)) === (b == null ? null : Number(b));

async function setObsolete(payload) {
  const skus = payload.items.map((i) => i.sku);
  const changed = await setProductsObsolete(skus, payload.obsolete);
  if (!changed.length) return { ok: false, text: 'Nothing changed: the products were already that way.' };
  return { ok: true, text: `${changed.length} of ${skus.length} ${skus.length === 1 ? 'product' : 'products'} ${payload.obsolete ? 'marked obsolete' : 'no longer marked obsolete'}.` };
}

async function setPrices(payload) {
  const bySku = new Map();
  for (const item of payload.items) bySku.set(item.sku, [...(bySku.get(item.sku) ?? []), item]);
  const made = [];
  const refused = [];
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
      made.push(...items.map((i) => `${sku} ${i.label} ${i.from ?? 'empty'} → ${i.to}`));
    } catch (err) {
      refused.push(`${sku}: ${err.message}`);
    }
  }
  if (!made.length) return { ok: false, text: `Nothing changed. ${refused.join(' · ')}` };
  return { ok: true, text: `Changed: ${made.join('; ')}.${refused.length ? ` Not changed — ${refused.join(' · ')}` : ''}` };
}

/**
 * Makes a confirmed change and records how it ended.
 * Returns { status: 'done' | 'failed', result }.
 */
export async function runAssistantAction(action) {
  let outcome;
  try {
    if (action.kind === 'set_obsolete') outcome = await setObsolete(action.payload);
    else if (action.kind === 'set_prices') outcome = await setPrices(action.payload);
    else outcome = { ok: false, text: 'This kind of change cannot be made from the chat.' };
  } catch (err) {
    outcome = { ok: false, text: err.message || 'The change failed.' };
  }
  const status = outcome.ok ? 'done' : 'failed';
  // The change is what matters; if only the note fails, the card still shows what happened.
  await decideAction(action.id, status, outcome.text).catch(() => {});
  return { status, result: outcome.text };
}

/** The person said no: nothing changes. */
export async function cancelAssistantAction(action) {
  await decideAction(action.id, 'cancelled');
  return { status: 'cancelled', result: null };
}
