import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

// Walmart US item setup (feed MP_ITEM) from PIM data — see the
// walmart-add-items edge function. Preview never sends anything; submit
// goes to Walmart's sandbox unless production is explicitly confirmed.

async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('walmart-add-items', { body });
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
 * Every field the PIM would send per SKU, the missing required ones and the
 * warnings. validate=true also checks each item against Walmart's official
 * item spec. Sends nothing either way.
 */
export function previewWalmartItems(skus, { validate = false } = {}) {
  return invoke({ mode: 'preview', skus, validate });
}

/**
 * Post the MP_ITEM feed. sandbox=true is Walmart's test environment (no real
 * catalog). Production needs sandbox=false and confirm='CREATE'.
 */
export async function submitWalmartItems(skus, { sandbox = true, confirm } = {}) {
  const data = await invoke({ mode: 'submit', skus, sandbox, confirm });
  if (!sandbox) {
    for (const sku of data.submitted ?? []) {
      logActivity({
        action: 'push', entityType: 'product', entityId: sku, target: 'walmart',
        summary: `Submitted ${sku} as a new Walmart US item`,
        metadata: { feedId: data.feedId, env: data.env },
      });
    }
  }
  return data;
}

/** A feed's per-item outcome. */
export function walmartFeedStatus(feedId, { sandbox = true } = {}) {
  return invoke({ mode: 'status', feedId, sandbox });
}
