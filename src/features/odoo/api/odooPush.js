import { supabase } from '@/lib/supabase';
import { getAppSetting, saveAppSetting } from '@/features/settings/api/appSettings';
import { logActivity } from '@/features/activity/api/activityLog';
import { startTask } from '@/lib/taskProgress';

// PIM → Odoo, one way only (user, 2026-11-11: "apenas alguien le dé SAVE en
// PIM la información viaje a Odoo"; "el flujo es solo PIM to Odoo, nunca Odoo
// to PIM"). A save that changes one of the fields below — on the product
// page or through a spreadsheet import — sends it to Odoo through the
// `odoo-push` edge function, which reads the values from the database itself
// and holds back what must not go (no product in Odoo, an archived one, a UPC
// another Odoo product has, half a box…). A new product can be created in
// Odoo with it (`create`). What waits for Odoo's side (the product is not
// there yet, an HS code its list lacks…) is tried again every hour by the
// function's own cron. The switch is app_settings 'odoo_push'
// (Settings → Odoo); the function checks it too.

const SETTING = 'odoo_push';
const PER_CALL = 100; // the function's limit
// "Nothing to send" for a field (the PIM has no value: no_upc, no_box…):
// said, not a failure — the function's own rule.
const isSoft = (reason) => String(reason ?? '').startsWith('no_') && reason !== 'no_category';

// The switch, remembered for a minute so a save does not wait on it twice.
let known = null; // { at, enabled }

export async function isOdooPushOn() {
  if (known && Date.now() - known.at < 60_000) return known.enabled;
  const value = await getAppSetting(SETTING, { enabled: false });
  known = { at: Date.now(), enabled: value?.enabled === true };
  return known.enabled;
}

/** Turn the sending on or off (admins only — app_settings' own rule). */
export async function setOdooPush(enabled) {
  await saveAppSetting(SETTING, { enabled: Boolean(enabled) });
  known = { at: Date.now(), enabled: Boolean(enabled) };
  logActivity({
    action: 'update',
    entityType: 'setting',
    entityId: SETTING,
    target: 'odoo',
    summary: `Sending product data to Odoo turned ${enabled ? 'on' : 'off'}`,
    metadata: { enabled: Boolean(enabled) },
  });
}

// Why a send waits, in the words Settings shows.
const WAITING = {
  not_in_odoo: 'not in Odoo yet',
  archived: 'archived in Odoo',
  several: 'twice in Odoo',
  taken: 'their UPC is on another Odoo product',
  hs_not_listed: 'their HS code is not on Odoo’s list',
  country_unknown: 'their country is not in Odoo',
  refused: 'Odoo gave an error',
};

/**
 * What could not go to Odoo yet and is tried again every hour (table
 * odoo_pending, written by the edge function): [{ reason, label, skus }],
 * the biggest group first.
 */
export async function listOdooPending() {
  const { data, error } = await supabase.from('odoo_pending').select('sku, reason').order('sku').range(0, 999);
  if (error) throw error;
  const groups = new Map();
  for (const row of data ?? []) {
    const reason = row.reason ?? 'refused';
    if (!groups.has(reason)) groups.set(reason, { reason, label: WAITING[reason] ?? reason, skus: [] });
    groups.get(reason).skus.push(row.sku);
  }
  return [...groups.values()].sort((a, b) => b.skus.length - a.skus.length);
}

const text = (value) => String(value ?? '').trim();
const measure = (value) => {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : null;
};
const boxOf = (product) => {
  const box = product?.attributes?.shipping_dimensions_in ?? {};
  return [measure(box.length), measure(box.width), measure(box.height)].join('|');
};

/**
 * Which of the fields that travel to Odoo a save changed — the product as it
 * was, the product as it is now ({ attributes, shipping_weight_lb, model_name }):
 *   upc             the UPC → Odoo's Barcode
 *   box             Shipping Dimensions → Shipping Length / Width / Height
 *   weight          Shipping Weight → Shipping Weight (Lbs)
 *   product_weight  Product Weight → Overall Product Weight
 *   model           Model Name → Model Name
 *   hs              HS Code → HS Code (Odoo's own list)
 *   country         Country of Origin → Country of Origin
 *   title           General Title → the Name, on products the PIM created in Odoo
 * (The main image, `image`, is sent by the media module when it changes, and
 * the marketplace ids, `ids`, by the Aliases tab when one is added.)
 */
export function changedOdooFields(before, after) {
  const fields = [];
  const attr = (product, key) => text(product?.attributes?.[key]);
  if (attr(before, 'upc') !== attr(after, 'upc')) fields.push('upc');
  if (boxOf(before) !== boxOf(after)) fields.push('box');
  if (measure(before?.shipping_weight_lb) !== measure(after?.shipping_weight_lb)) fields.push('weight');
  if (measure(before?.attributes?.product_weight_lb) !== measure(after?.attributes?.product_weight_lb)) fields.push('product_weight');
  if (text(before?.model_name) !== text(after?.model_name)) fields.push('model');
  if (attr(before, 'hs_code') !== attr(after, 'hs_code')) fields.push('hs');
  if (attr(before, 'country_of_origin') !== attr(after, 'country_of_origin')) fields.push('country');
  if (attr(before, 'general_title_en') !== attr(after, 'general_title_en')) fields.push('title');
  return fields;
}

async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('odoo-push', { body });
  if (error) {
    let detail = error.message;
    try {
      if (error.context && typeof error.context.text === 'function') {
        const raw = await error.context.text();
        try { detail = JSON.parse(raw).error ?? raw; } catch { detail = raw || detail; }
      }
    } catch { /* keep error.message */ }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * The function's answer for these SKUs, 100 per call:
 * { off, results: [{ sku, state, note, changes, held }] } — state updated |
 * created | same | held (would_update / would_create on a dry run).
 * `fields`: what to send (upc, box, weight, title). `create`: make the
 * products Odoo does not have. `dryRun` compares and writes nothing.
 * `task` (optional) counts the SKUs done.
 */
export async function pushToOdoo(skus, { fields = [], create = false, dryRun = false, task = null } = {}) {
  const list = [...new Set(skus ?? [])];
  const results = [];
  for (let i = 0; i < list.length; i += PER_CALL) {
    const out = await invoke({ skus: list.slice(i, i + PER_CALL), fields, create, dryRun });
    if (out?.off) return { off: true, results: [] };
    results.push(...(out?.results ?? []));
    if (list.length > PER_CALL) task?.count(Math.min(i + PER_CALL, list.length), list.length);
  }
  return { off: false, results };
}

/**
 * After a save: send what it changed to Odoo (or create the new product
 * there), with a progress card that says what Odoo took or why it did not.
 * Runs beside the save — it never throws and never undoes it: the PIM's
 * values are saved either way. Nothing happens while the switch is off.
 */
export async function sendToOdoo(skus, { fields = [], create = false } = {}) {
  const list = [...new Set(skus ?? [])];
  if (!list.length || (!fields.length && !create)) return null;
  try {
    if (!(await isOdooPushOn())) return null;
  } catch {
    return null; // the switch could not be read: nothing is sent
  }
  const one = list.length === 1;
  const doing = create ? 'Creating' : 'Sending';
  const task = startTask('Odoo', { detail: one ? `${doing} ${list[0]} ${create ? 'in' : 'to'} Odoo…` : `${doing} ${list.length} products ${create ? 'in' : 'to'} Odoo…` });
  try {
    const out = await pushToOdoo(list, { fields, create, task });
    if (out.off) { known = null; task.cancel(); return out; }
    const failed = out.results.filter((r) => (r.held ?? []).some((h) => !isSoft(h.reason)));
    if (one) {
      const r = out.results[0];
      if (!r) task.finish('Nothing to send');
      else if (failed.length) task.fail(`${r.sku}: ${r.note}`);
      else task.finish(`${r.sku}: ${r.note}`);
      return out;
    }
    const count = (state) => out.results.filter((r) => r.state === state).length;
    const parts = [];
    if (count('created')) parts.push(`${count('created')} created in Odoo`);
    if (count('updated')) parts.push(`${count('updated')} updated in Odoo`);
    if (count('same')) parts.push(`${count('same')} already the same`);
    if (failed.length) {
      const shown = failed.slice(0, 3).map((r) => `${r.sku}: ${r.held.filter((h) => !isSoft(h.reason)).map((h) => h.note).join(' ')}`).join(' ');
      task.fail(`${[...parts, `${failed.length} with something not sent`].join(' · ')}. ${shown}${failed.length > 3 ? ' … the rest is in the Activity Log.' : ''}`);
    } else {
      task.finish(parts.join(' · ') || 'Nothing to send');
    }
    return out;
  } catch (err) {
    task.fail(`Saved in the PIM, but Odoo was not updated: ${err.message}`);
    return null;
  }
}
