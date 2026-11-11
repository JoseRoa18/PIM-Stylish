import { supabase } from '@/lib/supabase';
import { getAppSetting, saveAppSetting } from '@/features/settings/api/appSettings';
import { logActivity } from '@/features/activity/api/activityLog';
import { startTask } from '@/lib/taskProgress';

// PIM → Odoo (user, 2026-11-11: "apenas alguien le dé SAVE en PIM la
// información viaje a Odoo … en este caso solo UPC"). A save that changes a
// product's UPC — its page or a spreadsheet import — sends it to the
// product's Barcode in Odoo through the `odoo-push` edge function, which
// reads the UPC from the database itself and holds back what must not go
// (no product in Odoo, an archived one, a UPC another Odoo product has…).
// The switch is app_settings 'odoo_push' (Settings → Odoo), off until the
// user turns it on; the function checks it too.

const SETTING = 'odoo_push';
const PER_CALL = 100; // the function's limit

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
    summary: `Sending UPC changes to Odoo turned ${enabled ? 'on' : 'off'}`,
    metadata: { enabled: Boolean(enabled) },
  });
}

const upcText = (value) => String(value ?? '').trim();
/** Did a save change the UPC? (what was stored before, what is stored now) */
export const upcChanged = (before, after) => upcText(before) !== upcText(after);

async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('odoo-push', { body });
  if (error) {
    let detail = error.message;
    try {
      if (error.context && typeof error.context.text === 'function') {
        const text = await error.context.text();
        try { detail = JSON.parse(text).error ?? text; } catch { detail = text || detail; }
      }
    } catch { /* keep error.message */ }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * The function's answer for these SKUs, 100 per call:
 * { off, results: [{ sku, state: updated | would_update | same | held, reason?, note, before?, after? }] }.
 * `dryRun` compares and writes nothing. `task` (optional) counts the SKUs done.
 */
export async function pushUpcsToOdoo(skus, { dryRun = false, task = null } = {}) {
  const list = [...new Set(skus ?? [])];
  const results = [];
  for (let i = 0; i < list.length; i += PER_CALL) {
    const out = await invoke({ skus: list.slice(i, i + PER_CALL), dryRun });
    if (out?.off) return { off: true, results: [] };
    results.push(...(out?.results ?? []));
    if (list.length > PER_CALL) task?.count(Math.min(i + PER_CALL, list.length), list.length);
  }
  return { off: false, results };
}

/**
 * After a save that changed these products' UPCs: send them to Odoo, with a
 * progress card that says what Odoo took or why it did not. Runs beside the
 * save — it never throws and never undoes it: the PIM's value is saved either
 * way. Nothing happens while the switch is off.
 */
export async function sendUpcsToOdoo(skus) {
  const list = [...new Set(skus ?? [])];
  if (!list.length) return null;
  try {
    if (!(await isOdooPushOn())) return null;
  } catch {
    return null; // the switch could not be read: the function decides
  }
  const one = list.length === 1;
  const task = startTask('Odoo · UPC', { detail: one ? `Sending the UPC of ${list[0]} to Odoo…` : `Sending ${list.length} UPCs to Odoo…` });
  try {
    const out = await pushUpcsToOdoo(list, { task });
    if (out.off) { known = null; task.cancel(); return out; }
    const updated = out.results.filter((r) => r.state === 'updated');
    const same = out.results.filter((r) => r.state === 'same');
    // A product whose UPC was emptied keeps Odoo's Barcode: said, not a failure.
    const held = out.results.filter((r) => r.state === 'held' && r.reason !== 'no_upc');
    if (one) {
      const r = out.results[0];
      if (held.length) task.fail(`${r.sku}: ${r.note}`);
      else task.finish(r ? `${r.sku}: ${r.note}` : 'Nothing to send');
    } else if (held.length) {
      const shown = held.slice(0, 3).map((r) => `${r.sku}: ${r.note}`).join(' ');
      task.fail(`${updated.length} updated in Odoo, ${held.length} not sent. ${shown}${held.length > 3 ? ' … the rest is in the Activity Log.' : ''}`);
    } else {
      task.finish(`${updated.length} updated in Odoo${same.length ? ` · ${same.length} already the same` : ''}`);
    }
    return out;
  } catch (err) {
    task.fail(`The UPC is saved in the PIM, but Odoo was not updated: ${err.message}`);
    return null;
  }
}
