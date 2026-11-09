// The EOS ScoreCard tabs — one per marketplace sheet of the company's
// "2026 Company ScoreCard.xlsx" (user, 2026-11-03). For each market a tab
// covers, `channels` are the promotion channel keys (promoChannels.js) whose
// promotions and deals it counts, and `align` the Price Alignment targets
// (priceAlignment.js ALIGN_TARGETS) its MAP % reads. Lowe's is the USA
// channel (its sheet said Canada, but its sales are in USD); BB&B and
// Overstock share one sheet and one exclusion switch. `serverFill` boards
// also get the server-side numbers (Odoo orders, ShipStation labels, stock,
// Activity Log) — every tab since 2026-11-05 (BOARDS in scorecard-fill says
// how to find each one's orders in Odoo).
export const BOARDS = [
  {
    key: 'amazon',
    label: 'Amazon',
    serverFill: true,
    markets: {
      ca: { channels: ['amazon_ca'], align: ['amazon_ca'] },
      us: { channels: ['amazon_us'], align: ['amazon_us'] },
    },
  },
  {
    key: 'wayfair',
    label: 'Wayfair',
    serverFill: true,
    markets: {
      ca: { channels: ['wayfair_ca'], align: ['wayfair_ca'] },
      us: { channels: ['wayfair_us'], align: ['wayfair_us'] },
    },
  },
  { key: 'homedepot_ca', label: 'Home Depot', serverFill: true, markets: { ca: { channels: ['homedepot_ca'], align: ['homedepot_ca'] } } },
  { key: 'lowes', label: "Lowe's", serverFill: true, markets: { us: { channels: ['lowes_us'], align: ['lowes_us'] } } },
  { key: 'menards', label: 'Menards', serverFill: true, markets: { us: { channels: ['menards'], align: ['menards'] } } },
  { key: 'rona', label: 'Rona', serverFill: true, markets: { ca: { channels: ['rona'], align: ['rona'] } } },
  { key: 'bbb_overstock', label: 'BB&B / Overstock', serverFill: true, markets: { us: { channels: ['bbb', 'overstock'], align: ['bbb_us', 'overstock_us'] } } },
  {
    key: 'sinksdirect',
    label: 'Sinks Direct',
    // Its orders / stock / Activity Log rows are filled by the scorecard-fill
    // edge function (BOARDS there says how to find the store in Odoo).
    serverFill: true,
    markets: {
      ca: { channels: ['wix_sinksdirect_ca'], align: ['sinksdirect_ca'] },
      us: { channels: ['wix_sinksdirect_us'], align: ['sinksdirect_us'] },
    },
  },
];

export const BOARD_BY_KEY = Object.fromEntries(BOARDS.map((b) => [b.key, b]));
export const MARKET_LABEL = { ca: 'Canada', us: 'USA' };
