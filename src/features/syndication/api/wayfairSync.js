import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

/**
 * Push a product's marketing copy + feature bullets to Wayfair.
 * `validateOnly` (default true) validates the payload against Wayfair without
 * changing anything — safe to run against production.
 *
 * @param {string} sku
 * @param {Object} opts
 * @param {string} opts.itemGroupId  Wayfair item-group id for this SKU
 * @param {boolean} [opts.validateOnly=true]
 */
export async function pushContentToWayfair(sku, { itemGroupId, validateOnly = true } = {}) {
  const { data, error } = await supabase.functions.invoke('wayfair-push-content', {
    body: { sku, itemGroupId, validateOnly },
  });

  if (error) {
    let detail = error.message;
    try {
      if (error.context && typeof error.context.text === 'function') {
        const text = await error.context.text();
        try {
          const parsed = JSON.parse(text);
          detail = parsed.error || parsed.message || text;
        } catch {
          detail = text || detail;
        }
      }
    } catch {
      // fall back to error.message
    }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);

  if (!validateOnly) {
    logActivity({
      action: 'push',
      entityType: 'product',
      entityId: sku,
      target: 'wayfair',
      summary: `Pushed ${sku} content to Wayfair`,
      metadata: { bullets: data?.pushed?.bullets },
    });
  }
  return data;
}
