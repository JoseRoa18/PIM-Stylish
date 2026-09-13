import { templatePurpose } from '@/features/templates/api/templates';

/**
 * Every place a monthly promotion has to reach, and how it gets there.
 *
 *   api          the PIM writes the prices itself (Wix SinksDirect sites on
 *                the market's start day, Best Buy as scheduled discounts)
 *   portal_file  the person downloads the marketplace's own file from its
 *                portal, the PIM fills the promo columns (Wayfair, BB&B)
 *   template     the marketplace's promotions template lives in /templates
 *                (purpose "Promotions") and the PIM generates the filled file
 *
 * `costSlug` names the promo cost group (promotion_prices.promo_costs) the
 * channel's cost column takes; null = the channel gets prices only.
 * `fill` picks a marketplace-specific filler instead of the generic one
 * ('amazon': Seller Central flat file keyed by seller SKU).
 */
export const PROMO_CHANNELS = [
  { key: 'wix_sinksdirect_ca', label: 'Sinks Direct Canada', monogram: 'SD', market: 'ca', kind: 'api', stamp: 'ca_applied_at',
    how: 'Automatic. Promo MAP CAD goes live on the first Thursday.' },
  { key: 'wix_sinksdirect_us', label: 'Sinks Direct USA', monogram: 'SD', market: 'us', kind: 'api', stamp: 'us_applied_at',
    how: 'Automatic. Promo MAP USD goes live on the 1st.' },
  { key: 'bestbuy', label: 'Best Buy Canada', monogram: 'BB', market: 'ca', kind: 'api', stamp: 'bb_scheduled_at',
    how: 'Scheduled discounts sent when the list loads. Check the portal: API discounts have not shown up so far.' },
  { key: 'wayfair_ca', label: 'Wayfair Canada', monogram: 'WF', market: 'ca', kind: 'portal_file', filler: 'wayfair', auditTarget: 'wayfair',
    how: 'Upload the Partner Home promotions file. The PIM fills the base cost per row and adds missing members.' },
  { key: 'wayfair_us', label: 'Wayfair USA', monogram: 'WF', market: 'us', kind: 'portal_file', filler: 'wayfair_us', auditTarget: 'wayfair_usa',
    how: 'Same Partner Home file, USA supplier. The PIM fills base cost and promotional MAP USD.' },
  { key: 'bbb', label: 'BB&B / Overstock', monogram: 'BO', market: 'us', kind: 'portal_file', filler: 'bbb', auditTarget: 'bbb',
    how: 'Upload the portal promo CSV. PROMO_MAP and PROMO_COST are filled on matching part numbers.' },
  { key: 'homedepot_ca', label: 'Home Depot Canada', monogram: 'HD', market: 'ca', kind: 'template', marketplace: /home ?depot.*(\bca\b|canada)/i, costSlug: 'rona_hd_cad' },
  { key: 'rona', label: 'Rona', monogram: 'RO', market: 'ca', kind: 'template', marketplace: /rona/i, costSlug: 'rona_hd_cad' },
  { key: 'amazon_ca', label: 'Amazon Canada', monogram: 'AM', market: 'ca', kind: 'template', marketplace: /amazon.*(\bca\b|canada)/i, costSlug: null, fill: 'amazon' },
  { key: 'walmart_ca', label: 'Walmart Canada', monogram: 'WM', market: 'ca', kind: 'template', marketplace: /walmart.*(\bca\b|canada)/i, costSlug: null },
  { key: 'homedepot_us', label: 'Home Depot USA', monogram: 'HD', market: 'us', kind: 'template', marketplace: /home ?depot.*\bus(a)?\b/i, costSlug: null },
  { key: 'lowes_us', label: "Lowe's USA", monogram: 'LO', market: 'us', kind: 'template', marketplace: /lowe.*\bus(a)?\b/i, costSlug: 'lowes_sod_bbb_usd' },
  { key: 'menards', label: 'Menards', monogram: 'ME', market: 'us', kind: 'template', marketplace: /menards/i, costSlug: 'menards_usd' },
  { key: 'amazon_us', label: 'Amazon USA', monogram: 'AM', market: 'us', kind: 'template', marketplace: /amazon.*\bus(a)?\b/i, costSlug: null, fill: 'amazon' },
  { key: 'walmart_us', label: 'Walmart USA', monogram: 'WM', market: 'us', kind: 'template', marketplace: /walmart.*\bus(a)?\b/i, costSlug: null },
];

/** The promotions template uploaded for a template-kind channel, if any. */
export function promoTemplateFor(channel, templates) {
  if (channel.kind !== 'template') return null;
  return (templates ?? []).find((t) => templatePurpose(t) === 'promotions' && channel.marketplace.test(t.marketplace ?? '')) ?? null;
}
