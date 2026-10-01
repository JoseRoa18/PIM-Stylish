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
 * `sellerSku: 'pim'` means the marketplace uses the PIM SKU as is (Amazon
 * USA); otherwise the seller SKU comes from amazon_links.
 * 'mirakl' fills a Mirakl offers-import file (Home Depot USA): price =
 * `priceField`, msrp = `msrpField`, promo = discount-price + dates; the
 * SKU is the product's alias on `aliasMarketplace` when it has one.
 * `levelByKind` pins a promotion kind to a price level for that channel
 * (the usual levels are KIND_LEVEL in api/promotions: monthly and flash at
 * Orange, special at Purple): its file is generated from the products'
 * level columns instead of the promotion's rows (see channelLevelFor and
 * promotionLevel).
 */
const BEYOND_LEVELS = { flash: 'purple' };

/** The price level a channel pins this promotion's kind to, or null (the kind's usual level, see KIND_LEVEL in api/promotions). */
export function channelLevelFor(channel, promotion) {
  return channel?.levelByKind?.[promotion?.kind ?? 'monthly'] ?? null;
}

export const PROMO_CHANNELS = [
  { key: 'wix_sinksdirect_ca', label: 'Sinks Direct Canada', monogram: 'SD', market: 'ca', kind: 'api', stamp: 'ca_applied_at',
    how: 'Automatic. Promo MAP CAD goes live on the first Thursday.' },
  { key: 'wix_sinksdirect_us', label: 'Sinks Direct USA', monogram: 'SD', market: 'us', kind: 'api', stamp: 'us_applied_at',
    how: 'Automatic. Promo MAP USD goes live on the 1st.' },
  { key: 'bestbuy', label: 'Best Buy Canada', monogram: 'BB', market: 'ca', kind: 'api', stamp: 'bb_scheduled_at',
    how: 'Scheduled discounts sent when the list loads. Check the portal: API discounts have not shown up so far.' },
  { key: 'wayfair_ca', label: 'Wayfair Canada', monogram: 'WF', market: 'ca', kind: 'portal_file', filler: 'wayfair', priceStart: 'wayfair_price_start', priceChange: 'wayfair_price_change', savedStart: 'price_start', auditTarget: 'wayfair',
    how: "Upload the promotions file downloaded from Partner Home. The PIM fills the base cost, keeps only the promotion's rows and adds missing members. Promo MAP lowers the MAP the day it starts, Back to Blue returns it the day it ends." },
  // Wayfair (both markets) always works from the file downloaded from Partner
  // Home right before it is used (user decision 2026-09-28): its "Current"
  // columns are Wayfair's own snapshot and it carries the tracking processId,
  // so a copy kept in Templates goes stale. USA: discount 0, cost after
  // discount = WC Wayfair of the level, B2B 0, rows outside the promotion removed.
  { key: 'wayfair_us', label: 'Wayfair USA', monogram: 'WF', market: 'us', kind: 'portal_file', filler: 'wayfair_us', priceStart: 'wayfair_us_price_start', priceChange: 'wayfair_us_price_change', savedStart: 'price_start', auditTarget: 'wayfair_usa',
    how: "Download the promotions file from Partner Home and upload it here. The PIM fills discount 0, the WC Wayfair of the level and B2B 0, and keeps only the promotion's rows. Promo MAP lowers the MAP the day it starts, Back to Blue returns MAP and cost the day it ends." },
  // Bed Bath & Beyond and Overstock (Beyond Inc.): same prices, aliases and
  // exclusion switch ('bbb'), same file layout, but each portal has its own
  // catalog file uploaded in Templates ("BB&B / Overstock US" is Bed Bath &
  // Beyond's, "Overstock US" is Overstock's). Generate keeps the promo's
  // rows only and fills PROMO_MAP / PROMO_COST.
  // Beyond rule (2026-09-28): a FLASH DEAL goes out at the PURPLE level here
  // (every other channel runs flash deals at Orange) — MAP Purple USD and WC
  // Purple of the Lowe's / SOD / BB&B group, read from the products when the
  // file is generated, whatever the promotion's rows carry. Special events
  // are Purple everywhere, so they need no pin.
  { key: 'bbb', label: 'Bed Bath & Beyond', monogram: 'BB', market: 'us', kind: 'template', auditTarget: 'bbb', marketplace: /b(ed)?\s*b(ath)?\s*(&|and)?\s*b/i, fill: 'bbb', portal: 'bbb', costSlug: 'lowes_sod_bbb_usd', levelByKind: BEYOND_LEVELS },
  { key: 'overstock', label: 'Overstock', monogram: 'OS', market: 'us', kind: 'template', auditTarget: 'overstock', marketplace: /^overstock/i, fill: 'bbb', portal: 'overstock', exclusionKey: 'bbb', costSlug: 'lowes_sod_bbb_usd', levelByKind: BEYOND_LEVELS },
  // Home Depot Canada's NLP workbook (one template per category, Kitchen
  // Sinks first): Article # = its "SKU Assigned by Merchant" (Aliases, loaded
  // 2026-09-28), WAS/NLP price = MAP Blue / promo MAP, Old/New cost = WC
  // Blue / WC promo, forecast = Canada stock. See homeDepotCaPromoFill.
  { key: 'homedepot_ca', label: 'Home Depot Canada', monogram: 'HD', market: 'ca', kind: 'template', marketplace: /home ?depot.*(\bca\b|canada)/i, costSlug: 'rona_hd_cad', fill: 'homedepot_ca', aliasMarketplace: 'Home Depot CA' },
  // Rona's own file: Rona id + name from Aliases, WC Blue as regular cost,
  // WC Orange (monthly) / Purple (flash, event) as promo cost, MAP Blue kept.
  { key: 'rona', label: 'Rona', monogram: 'RO', market: 'ca', kind: 'template', marketplace: /rona/i, costSlug: 'rona_hd_cad', fill: 'rona', aliasMarketplace: 'Rona' },
  { key: 'amazon_ca', label: 'Amazon Canada', monogram: 'AM', market: 'ca', kind: 'template', marketplace: /amazon.*(\bca\b|canada)/i, costSlug: null, fill: 'amazon' },
  // Walmart Canada goes by API, and can also produce the Seller Center
  // price & promotion file when a promotions template is uploaded.
  { key: 'walmart_ca', label: 'Walmart Canada', monogram: 'WM', market: 'ca', kind: 'api', stamp: 'wm_ca_scheduled_at', schedule: 'walmart_ca', marketplace: /walmart.*(\bca\b|canada)/i, fill: 'walmart_ca',
    how: 'Automatic: promotional prices sent through the Walmart API the day before the Canada window opens (Settings). Walmart turns them on and off by itself. Schedule sends by hand; Generate fills the Seller Center price & promotion file instead.' },
  // Home Depot USA runs on Mirakl: its promotions file is the offers import
  // (sku, price, msrp, discount-price + dates). Regular = MAP USD.
  // dateStamps: the time + offset of every date column, as in the filled
  // example of the new template the user gave on 2026-10-01 (used when the
  // uploaded template carries no example rows of its own).
  { key: 'homedepot_us', label: 'Home Depot USA', monogram: 'HD', market: 'us', kind: 'template', marketplace: /home ?depot.*\bus(a)?\b/i, costSlug: null, fill: 'mirakl', priceField: 'map_usd', costField: 'cost_usd_lowes_sod_bbb', promoCostSlug: 'lowes_sod_bbb_usd', aliasMarketplace: 'Home Depot US',
    dateStamps: { start: 'T00:00:00.000+02:00', end: 'T23:59:00.000+02:00' } }, // HD USA: base cost and promo cost = the Lowe's / SOD / BB&B group
  // Lowe's Vendor Offer workbook: one file per sub-division (kitchen sinks,
  // faucets, bath sinks, drains), item number + name from Aliases.
  { key: 'lowes_us', label: "Lowe's USA", monogram: 'LO', market: 'us', kind: 'template', marketplace: /lowe.*\bus(a)?\b/i, costSlug: 'lowes_sod_bbb_usd', fill: 'lowes', aliasMarketplace: "Lowe's US" },
  // Menards sends its own file: the PIM fills columns F, G, H (MAP and WC
  // Menards of the promo level) on the rows carrying our SKUs and hands it back.
  // Back to Blue the day the promotion ends (user rule 2026-09-29, monthly
  // promotions and flash deals): the same file with every row at Blue.
  { key: 'menards', label: 'Menards', monogram: 'ME', market: 'us', kind: 'portal_file', filler: 'menards', priceChange: 'menards_price_change', savedStart: 'promo_file', costSlug: 'menards_usd',
    taskHow: {
      promo_file: "Upload the promotion file Menards sent — the PIM fills F, G and H with the level's prices.",
      price_change: 'Upload the Menards file — the PIM puts F, G and H back at Blue.',
    },
    how: "Upload the file Menards sent. The PIM fills F, G and H with the level's MAP and WC Menards and asks about products without a level price. Back to Blue returns them the day the promotion ends." },
  { key: 'amazon_us', label: 'Amazon USA', monogram: 'AM', market: 'us', kind: 'template', marketplace: /amazon.*\bus(a)?\b/i, costSlug: null, fill: 'amazon', sellerSku: 'pim' }, // Amazon.com lists our products under the PIM SKU itself
  // Walmart USA goes by API too (feed `promo`, since 2026-09-28), and can
  // still produce the Seller Center file when a promotions template is uploaded.
  { key: 'walmart_us', label: 'Walmart USA', monogram: 'WM', market: 'us', kind: 'api', stamp: 'wm_us_scheduled_at', schedule: 'walmart_us', marketplace: /walmart.*\bus(a)?\b/i, costSlug: null,
    how: 'Automatic: promotional prices sent through the Walmart API the day before the 1st (Settings). Walmart turns them on and off by itself. Schedule sends by hand; Generate fills the promotions file instead.' },
];

/**
 * The promotions template uploaded for a template-kind channel, if any.
 * Flash deals and special events take the marketplace's "Flash deals & events"
 * file when one is uploaded (Rona and Walmart Canada use a different layout);
 * otherwise the monthly promotions file serves every kind.
 */
export function promoTemplateFor(channel, templates, kind = 'monthly') {
  return promoTemplatesFor(channel, templates, kind)[0] ?? null;
}

/**
 * Every promotions template of a template-kind channel for the kind (a
 * marketplace can hand out one file per product family — Home Depot Canada:
 * kitchen sinks, faucets & porcelain — and Generate fills them all).
 */
export function promoTemplatesFor(channel, templates, kind = 'monthly') {
  if (!channel.marketplace) return [];
  // Newest upload first: a marketplace that sends a new layout (Home Depot
  // USA, 2026-10-01) is filled from it even while the old file is still listed.
  const mine = (templates ?? [])
    .filter((t) => channel.marketplace.test(t.marketplace ?? ''))
    .sort((a, b) => String(b.uploaded_at ?? '').localeCompare(String(a.uploaded_at ?? '')));
  if (kind !== 'monthly') {
    const flash = mine.filter((t) => templatePurpose(t) === 'flash_deals');
    if (flash.length) return flash;
  }
  return mine.filter((t) => templatePurpose(t) === 'promotions');
}
