import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

// The edge function caps each call at 20 SKUs; larger selections are chunked
// here so the UI can hand over any selection size.
const CHUNK = 20;

async function invokeGenerate(skus, force) {
  const { data, error } = await supabase.functions.invoke('generate-keywords', {
    body: { skus, force },
  });
  if (error) {
    // The Functions client hides the response body inside error.context;
    // dig out the real message the function returned.
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
  return data.results ?? [];
}

/**
 * Generate search keywords (EN + FR) for `skus` via the generate-keywords
 * edge function (which holds the Gemini key and checks the caller's role).
 * Without `force`, products that already have keywords are skipped — so the
 * bulk action only fills gaps. Returns { generated, skipped, failed, results }.
 * `task` (optional taskProgress reporter) counts the products sent.
 */
export async function generateKeywords(skus, { force = false, onProgress, task = null } = {}) {
  const all = [];
  for (let i = 0; i < skus.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, skus.length);
    // one call writes up to 20 products and reports nothing until it answers
    task?.step(skus.length > CHUNK ? `Products ${i + 1} to ${end} of ${skus.length}…` : `Writing keywords for ${skus.length} product${skus.length === 1 ? '' : 's'}…`);
    const results = await invokeGenerate(skus.slice(i, i + CHUNK), force);
    all.push(...results);
    task?.count(end, skus.length);
    onProgress?.(end, skus.length);
  }

  const generated = all.filter((r) => r.status === 'generated');
  const failed = all.filter((r) => r.status === 'error');
  const skipped = all.filter((r) => r.status === 'skipped');

  if (generated.length === 1) {
    logActivity({
      action: 'update',
      entityType: 'product',
      entityId: generated[0].sku,
      summary: 'Generated search keywords (EN + FR)',
    });
  } else if (generated.length > 1) {
    logActivity({
      action: 'update',
      entityType: 'product',
      entityId: `${generated.length} products`,
      summary: `Generated search keywords for ${generated.length} products`,
      metadata: { skus: generated.map((r) => r.sku) },
    });
  }

  return { generated, skipped, failed, results: all };
}
