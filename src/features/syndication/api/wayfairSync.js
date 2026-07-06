import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

/**
 * Push a product to Wayfair: marketing copy + feature bullets (content) and/or
 * product images (media). `validateOnly` (default true) validates the payload
 * against Wayfair without changing anything — safe to run against production.
 *
 * Content needs the product's Wayfair itemGroupId (stored on the product, or
 * passed here). Media pushes by SKU and needs no itemGroupId.
 *
 * @param {string} sku
 * @param {Object} [opts]
 * @param {boolean} [opts.validateOnly=true]
 * @param {boolean} [opts.pushContent=true]
 * @param {boolean} [opts.pushMedia=true]
 * @param {string}  [opts.itemGroupId]  override the stored item-group id
 */
export async function pushToWayfair(sku, opts = {}) {
  const { validateOnly = true, pushContent = true, pushMedia = true, itemGroupId } = opts;
  const { data, error } = await supabase.functions.invoke('wayfair-push-content', {
    body: { sku, validateOnly, pushContent, pushMedia, itemGroupId },
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
      summary: `Pushed ${sku} to Wayfair`,
      metadata: { content: data?.content, media: data?.media },
    });
  }
  return data;
}

/** Save the Wayfair item-group id for a product (needed to push content). */
export async function setWayfairItemGroupId(sku, itemGroupId) {
  const { error } = await supabase
    .from('products')
    .update({ wayfair_item_group_id: itemGroupId?.trim() || null })
    .eq('sku', sku);
  if (error) throw error;
}
