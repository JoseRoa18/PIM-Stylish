// "Where to Buy" audit — reads the rows the where-to-buy-audit edge function
// keeps, and drives its scan / check modes from the UI.

import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

const PAGE = 1000;

/** All link rows of one Stylish site (paged past the 1,000-row REST cap). */
export async function loadWhereToBuy(site) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('where_to_buy_links')
      .select('id, site, sku, wix_product_id, section, market, retailer, label, url, host, retailer_id, expected_id, verdict, http_status, final_url, note, scanned_at, checked_at')
      .eq('site', site)
      .order('sku')
      .order('section')
      .order('retailer')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('where-to-buy-audit', { body });
  if (error) throw new Error(error.message ?? 'Audit call failed');
  if (data?.error) throw new Error(data.error);
  return data;
}

/** Re-read both Stylish sites' sections and rebuild the rows. */
export async function scanWhereToBuy(sites) {
  const r = await invoke({ mode: 'scan', sites });
  logActivity({
    action: 'audit',
    entityType: 'channel',
    entityId: 'where_to_buy',
    target: 'stylish',
    summary: `Where to Buy scan: ${r.sites.map((s) => `${s.label} ${s.links} links, ${s.missing} missing, ${s.malformed} malformed`).join(' · ')}`,
    metadata: r,
  });
  return r;
}

/**
 * Probe pending links in paced batches until none remain (or `maxCalls`
 * batches ran). Reports progress after every batch.
 */
export async function checkWhereToBuy({ onProgress, maxCalls = 40 } = {}) {
  let total = 0;
  for (let i = 0; i < maxCalls; i++) {
    const r = await invoke({ mode: 'check' });
    total += r.checked ?? 0;
    onProgress?.({ checked: total, batch: r });
    if (!r.morePending || (r.checked ?? 0) === 0) return { checked: total, done: true };
  }
  return { checked: total, done: false };
}

export async function whereToBuyStatus() {
  return invoke({ mode: 'status' });
}
