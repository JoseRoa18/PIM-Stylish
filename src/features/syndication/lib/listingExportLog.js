import { logActivity } from '@/features/activity/api/activityLog';
import { templatePurposeLabel } from '@/features/templates/api/templates';
import { templateMarketplaceKey } from './marketplaces';

// A marketplace's listing file downloaded from the PIM is a listing the PIM
// sent out (user, 2026-11-16): the EOS ScoreCard's "# Listings Optimized per
// Week" counts, per marketplace, the products the PIM pushed there or whose
// listing file was downloaded that week. So every such download leaves one
// Activity Log entry with its products:
//   action 'export' · entity 'product' · target = the marketplace's key
//   (amazon_ca, homedepot_us, lowes_us…) · metadata { listing: true, purpose, skus }
// scorecard-fill reads exactly that shape. BB&B / Overstock's exporter writes
// its own entry in it (bbbExport.js), so its downloads are not noted here.

/** The purposes that are a listing going to a marketplace; a price or promotion file is Pricing's. */
export const LISTING_PURPOSES = ['new_listing', 'update'];

/**
 * Notes the download of `marketplace`'s listing file of `purpose` for `skus`
 * (the products written into it). Fire-and-forget, like every log; a file
 * that is not a listing, or a marketplace without a key, notes nothing.
 */
export function logListingExport(marketplace, purpose, skus) {
  const target = templateMarketplaceKey(marketplace);
  const list = [...new Set((skus ?? []).filter(Boolean))];
  if (!target || !list.length || !LISTING_PURPOSES.includes(purpose ?? 'new_listing')) return;
  const what = list.length === 1 ? list[0] : `${list.length} products`;
  logActivity({
    action: 'export',
    entityType: 'product',
    entityId: what,
    target,
    summary: `Downloaded the ${marketplace} ${templatePurposeLabel(purpose).toLowerCase()} file for ${what}`,
    metadata: { listing: true, marketplace, purpose: purpose ?? 'new_listing', skus: list },
  });
}
