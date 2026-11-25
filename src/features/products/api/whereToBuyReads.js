// "Read again" on one link of the product's Where to Buy tab (user,
// 2026-11-25: "un botón para volver a leer el link … y que diga un estimado de
// cuánto falta"). The store's page is opened NOW by the Where to Buy check
// (where-to-buy-audit, mode "reread": admins and editors — each page is a paid
// request, so only what a person asks for goes through here) and the link
// keeps what the page shows: its status, price, stock and reviews. A link that
// stops opening the product leaves the Stylish pages, and one that opens it
// again comes back, by the check's own rules.
//
// A read is not tied to the screen that asked for it: it goes on, with its
// progress card, while the person looks at another tab of the product, and the
// tab shows it as reading when they come back.

import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';
import { startTask } from '@/lib/taskProgress';
import { readingCounts } from '@/features/pricing/lib/pageStores';
import { loadProductWhereToBuy } from './whereToBuy';
import { LINK_STATUS, linkStatusKey, priceText } from '../lib/linkStatus';
import { estimateMs, leftText, readShare } from '../lib/readEstimate';

const READ_TIMES_KEY = 'where_to_buy_read_times';

/**
 * How long a read of each store has taken lately — { [retailer]: { ms, n } },
 * kept by the audit after every read asked from this tab. Empty when it
 * cannot be read: the estimates then start from their usual times.
 */
export async function loadReadTimes() {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', READ_TIMES_KEY).maybeSingle();
  return error ? {} : data?.value ?? {};
}

// Menards answers through a job: the page is asked for, and its
// answer is read a little later — the same call, repeated, reads it.
const POLL_MS = 20_000;
const WAIT_MAX_MS = 6 * 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What one call found, from the best answer among the product's links to the
// store (its two pages carry the same address).
const STATE = { ok: 'read', broken: 'read', soft: 'sign', submitted: 'waiting', waiting: 'waiting', later: 'later', none: 'unanswered' };
const RANK = { read: 5, sign: 4, waiting: 3, later: 2, unanswered: 1 };

async function ask(sku, retailer, since) {
  const { data, error } = await supabase.functions.invoke('where-to-buy-audit', { body: { mode: 'reread', retailer, skus: [sku], since } });
  if (error) {
    // The function's own words (a role that may not ask, a store it does not read).
    const said = await error.context?.json?.().catch(() => null);
    throw new Error(said?.error ?? error.message ?? 'The page could not be read');
  }
  if (data?.error) throw new Error(data.error);
  const states = (data?.links ?? []).filter((l) => l.sku === sku).map((l) => STATE[l.kind] ?? 'unanswered');
  if (!states.length) return 'nothing';
  return states.sort((a, b) => RANK[b] - RANK[a])[0];
}

// What to tell the person: `ok` = the page was read (the card ends), else the
// read did not get its answer (the card stays until closed). A read that
// finds the page as it was says "still" — the row does not change, and the
// person must see that it was read all the same (user, 2026-11-25, about a
// link that stayed Out of stock: "pasaron 30 segundos pero no hizo nada").
function outcome(state, store, check, before) {
  if (state === 'read') {
    const key = linkStatusKey(check);
    // The price the page showed, when the product can be bought there (a sold-out page's price sells nothing).
    const price = key !== 'broken' && key !== 'outOfStock' && readingCounts(check) ? priceText(check) : '';
    const why = key === 'broken' && check?.note ? ` — ${check.note}`
      : key === 'wrong' && check?.page_model ? ` (the page shows ${check.page_model})`
        : '';
    const same = before === key;
    const was = before && !same && LINK_STATUS[before] ? ` — it was ${LINK_STATUS[before].label}` : '';
    return { ok: true, text: `${store.label}: ${same ? 'still ' : ''}${LINK_STATUS[key].label}${why}${price ? ` · ${price}` : ''}${was}` };
  }
  if (state === 'sign') return { ok: false, text: `The ${store.label} page opened without the product. The link keeps its status: the PIM looks at it again before calling it broken.` };
  if (state === 'waiting') return { ok: false, text: `${store.label} is taking longer than usual. Its answer is read by itself within the half hour.` };
  if (state === 'nothing') return { ok: false, text: `The PIM has no check for the ${store.label} link yet. Press Publish again, then read it.` };
  return { ok: false, text: `${store.label} gave no answer this time. The link keeps its status and is tried again by itself.` };
}

// Reads in flight, by product and store.
const inFlight = new Map();
const listeners = new Set();
let version = 0;
const idOf = (sku, retailer) => `${sku}|${retailer}`;
function changed() {
  version += 1;
  for (const l of listeners) l();
}
export function subscribeLinkReads(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const linkReadsVersion = () => version;
/** The read in flight of this link — { startedAt, estimate, done } — or null. */
export const linkReadOf = (sku, retailer) => inFlight.get(idOf(sku, retailer)) ?? null;
/** The reads in flight of this product's links. */
export const linkReadsOf = (sku) => [...inFlight.entries()].filter(([id]) => id.startsWith(`${sku}|`)).map(([, read]) => read);

/**
 * Read `store`'s page of the product now. One read per link at a time: asked
 * again while it runs, it answers with the read in flight. `before` = the
 * status the link shows now (a key of LINK_STATUS), for what the read says.
 * → a promise of { ok, state, text, data? } — `data` = the product's links
 *   and checks read after it (loadProductWhereToBuy), when the read ended.
 *   It never rejects: a failure is { ok: false, state: 'failed', text }.
 */
export function startLinkRead(product, store, learned = null, before = null) {
  const id = idOf(product.sku, store.key);
  const running = inFlight.get(id);
  if (running) return running.done;
  const startedAt = Date.now();
  const estimate = estimateMs(store.key, learned);
  const since = new Date(startedAt).toISOString();
  const doing = () => `Reading the ${store.label} page — ${leftText(estimate, Date.now() - startedAt)}`;
  const task = startTask(`Where to Buy · ${product.sku}`, { detail: doing() });
  task.progress(0, doing());
  const clock = setInterval(() => task.progress(readShare(estimate, Date.now() - startedAt), doing()), 1000);
  const done = (async () => {
    try {
      let state = await ask(product.sku, store.key, since);
      while (state === 'waiting' && Date.now() - startedAt < WAIT_MAX_MS) {
        await sleep(POLL_MS);
        state = await ask(product.sku, store.key, since);
      }
      const data = await loadProductWhereToBuy(product);
      const said = outcome(state, store, data.checks[store.key], before);
      logActivity({
        action: 'sync',
        entityType: 'product',
        entityId: product.sku,
        target: 'pim',
        summary: `Where to Buy: the ${store.label} link of ${product.sku} read again — ${said.ok ? said.text.replace(`${store.label}: `, '') : 'no answer'}`,
        metadata: { retailer: store.key, state, seconds: Math.round((Date.now() - startedAt) / 1000) },
      });
      clearInterval(clock);
      if (said.ok) task.finish(said.text); else task.fail(said.text);
      return { ...said, state, data };
    } catch (err) {
      clearInterval(clock);
      const text = `${store.label} was not read: ${err.message}`;
      task.fail(text);
      return { ok: false, state: 'failed', text };
    } finally {
      inFlight.delete(id);
      changed();
    }
  })();
  inFlight.set(id, { retailer: store.key, startedAt, estimate, done });
  changed();
  return done;
}
