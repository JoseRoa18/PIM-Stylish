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
  // BB&B / Overstock: either the portal's promo file is uploaded (Fill file)
  // or, when the full-catalog file lives in Templates, Generate fills the
  // promo rows and takes every other product out.
  { key: 'bbb', label: 'BB&B / Overstock', monogram: 'BO', market: 'us', kind: 'portal_file', filler: 'bbb', auditTarget: 'bbb', marketplace: /b(ed)?\s*b(ath)?\s*(&|and)?\s*b|overstock/i, fill: 'bbb',
    how: 'Generate builds the file from the catalog template in Templates (promo rows only). Or upload the portal promo CSV and only its rows are filled.' },
  { key: 'homedepot_ca', label: 'Home Depot Canada', monogram: 'HD', market: 'ca', kind: 'template', marketplace: /home ?depot.*(\bca\b|canada)/i, costSlug: 'rona_hd_cad' },
  // Rona's own file: Rona id + name from Aliases, WC Blue as regular cost,
  // WC Orange (monthly) / Purple (flash, event) as promo cost, MAP Blue kept.
  { key: 'rona', label: 'Rona', monogram: 'RO', market: 'ca', kind: 'template', marketplace: /rona/i, costSlug: 'rona_hd_cad', fill: 'rona', aliasMarketplace: 'Rona' },
  { key: 'amazon_ca', label: 'Amazon Canada', monogram: 'AM', market: 'ca', kind: 'template', marketplace: /amazon.*(\bca\b|canada)/i, costSlug: null, fill: 'amazon' },
  // Walmart Canada goes by API, and can also produce the Seller Center
  // price & promotion file when a promotions template is uploaded.
  { key: 'walmart_ca', label: 'Walmart Canada', monogram: 'WM', market: 'ca', kind: 'api', stamp: 'wm_ca_scheduled_at', schedule: 'walmart_ca', marketplace: /walmart.*(\bca\b|canada)/i, fill: 'walmart_ca',
    how: 'Promotional prices sent through the Walmart API for the Canada window. Walmart turns them on and off by itself. Generate fills the Seller Center price & promotion file instead.' },
  // Home Depot USA runs on Mirakl: its promotions file is the offers import
  // (sku, price, msrp, discount-price + dates). Regular = MAP USD.
  { key: 'homedepot_us', label: 'Home Depot USA', monogram: 'HD', market: 'us', kind: 'template', marketplace: /home ?depot.*\bus(a)?\b/i, costSlug: null, fill: 'mirakl', priceField: 'map_usd', costField: 'cost_usd_lowes_sod_bbb', promoCostSlug: 'lowes_sod_bbb_usd', aliasMarketplace: 'Home Depot US' }, // HD USA: base cost and promo cost = the Lowe's / SOD / BB&B group
  // Lowe's Vendor Offer workbook: one file per sub-division (kitchen sinks,
  // faucets, bath sinks, drains), item number + name from Aliases.
  { key: 'lowes_us', label: "Lowe's USA", monogram: 'LO', market: 'us', kind: 'template', marketplace: /lowe.*\bus(a)?\b/i, costSlug: 'lowes_sod_bbb_usd', fill: 'lowes', aliasMarketplace: "Lowe's US" },
  // Menards sends its own file: the PIM fills columns F, G, H (MAP and WC
  // Menards of the promo level) on the rows carrying our SKUs and hands it back.
  { key: 'menards', label: 'Menards', monogram: 'ME', market: 'us', kind: 'portal_file', filler: 'menards', costSlug: 'menards_usd',
    how: "Upload the file Menards sent. The PIM fills F, G and H with the level's MAP and WC Menards and asks about products without a level price." },
  { key: 'amazon_us', label: 'Amazon USA', monogram: 'AM', market: 'us', kind: 'template', marketplace: /amazon.*\bus(a)?\b/i, costSlug: null, fill: 'amazon', sellerSku: 'pim' }, // Amazon.com lists our products under the PIM SKU itself
  { key: 'walmart_us', label: 'Walmart USA', monogram: 'WM', market: 'us', kind: 'template', marketplace: /walmart.*\bus(a)?\b/i, costSlug: null },
];

/**
 * The promotions template uploaded for a template-kind channel, if any.
 * Flash deals and special events take the marketplace's "Flash deals & events"
 * file when one is uploaded (Rona and Walmart Canada use a different layout);
 * otherwise the monthly promotions file serves every kind.
 */
export function promoTemplateFor(channel, templates, kind = 'monthly') {
  if (!channel.marketplace) return null;
  const mine = (templates ?? []).filter((t) => channel.marketplace.test(t.marketplace ?? ''));
  if (kind !== 'monthly') {
    const flash = mine.find((t) => templatePurpose(t) === 'flash_deals');
    if (flash) return flash;
  }
  return mine.find((t) => templatePurpose(t) === 'promotions') ?? null;
}
