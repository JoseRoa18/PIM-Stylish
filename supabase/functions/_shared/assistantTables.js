// The tables the in-app assistant may READ, and what each one is. One list
// for the `assistant` edge function (its `query_table` tool refuses any other
// table) and for scripts/sync-assistant-knowledge.mjs (which writes each
// table's columns into the assistant's knowledge).
//
// Every read runs with the session of the person asking, so the database's
// own rules (RLS) still decide what comes back: a table here that the person
// may not read answers with nothing.
//
// `hide`: columns the assistant never selects — raw copies of other systems
// and bulk JSON that would flood an answer. A new table the PIM keeps goes
// here with a one-line note; then run the sync script.

export const ASSISTANT_TABLES = {
  products: {
    note: "One row per product, keyed by sku. Most fields live in the `attributes` JSON (attributes->>upc, attributes->>general_title_en, attributes->>hs_code, attributes->>country_of_origin, …); prices and costs are columns: map_cad / map_usd = MAP Blue, map_orange_* / map_purple_* the promotion levels, msrp_*, cost_*. The columns upc, hs_code, country_of_origin, manufacturer and warranty are NOT used — read them from attributes.",
    hide: ["wix_raw", "additional_info_sections"],
  },
  product_media: {
    note: "Images, videos and documents per product (media_type image / video / document; document_type; language NULL = universal; is_primary = the main image; image_role).",
  },
  product_aliases: { note: "The product's id on each marketplace (Home Depot CA, Rona, Lowe's US, BB&B / Overstock, Best Buy CA…)." },
  amazon_links: { note: "Amazon Seller SKU and ASIN per product and marketplace (ca / us)." },
  wix_links: { note: "The product's id on each Wix store (site)." },
  product_inventory: {
    note: "Stock cache from Odoo, refreshed every hour: one row per market (ca = Cambridge CBG, us = Atlanta ATL) and sku. `available` = units that can be sold; `eta` = next expected arrival of open purchase orders; warehouses JSON has on_order / expected / late. A product with NO row is 'not tracked' (not in Odoo), never 0.",
  },
  product_sales: {
    note: "Units sold cache from Odoo, refreshed every 3 hours: one row per market and sku that sold in the last 90 days (units_30, units_90, channels JSON = { marketplace: { u30, u90 } }). No row = sold nothing. For totals use the sales_overview tool.",
  },
  product_history: { note: "Field-by-field change history of products (field, old_value, new_value, actor_email, changed_at)." },
  product_where_to_buy: { note: "The PIM's own WHERE TO BUY links: one per product and retailer." },
  where_to_buy_links: {
    note: "Every link of the Stylish / Azuni pages and the dealers' price watch with its last check: verdict (ok / broken / manual / missing…), sku_check (match / listing / variant / other / unknown), price, currency, in_stock, read_at, checked_at. site = stylish_ca / stylish_us / azuni_ca / dealers.",
    hide: ["page_options"],
  },
  where_to_buy_readings: { note: "View: the newest reading per store (retailer) and product — what Price Alignment compares." },
  where_to_buy_suggestions: { note: "Suggested replacement links (status ready / applied / dismissed / failed…)." },
  promotions: {
    note: "Promotions: kind monthly / flash / mk_event / special (Peak Season); period = the month of a monthly one; marketplaces = the portals of a deal. Dates follow rules — use the promotions_overview tool to know what runs when.",
    hide: ["bb_schedule", "wm_ca_schedule", "wm_us_schedule", "file_tasks"],
  },
  promotion_prices: {
    note: "A promotion's products: in_ca / in_us = on that market's list; promo_price_cad / promo_price_usd = the promotion price (NULL when not on that market's list); promo_costs JSON.",
    hide: ["set_costs"],
  },
  coupons: { note: "Coupons recorded in the PIM (Amazon and Wayfair only; nothing is sent to the marketplace)." },
  coupon_products: { note: "A coupon's products." },
  stylish_event_discounts: { note: "Discounts the PIM has put on the Stylish Wix stores for special events." },
  scorecard_metrics: {
    note: "EOS ScoreCard rows: board (amazon, wayfair, homedepot_ca, lowes, rona, bbb_overstock, sinksdirect, menards, bestbuy, walmart), market (ca / us), name, unit (percent values are stored as fractions: 0.95 = 95%), goal, auto_key (set = filled by the PIM), archived.",
  },
  scorecard_values: { note: "ScoreCard values: metric_id, week_start (the week's SUNDAY; the column holds the numbers of the week before it), value, note." },
  audit_log: {
    note: "The Activity Log: who did what and when (occurred_at, actor_name, actor_email, action, entity_type, entity_id, target, summary; metadata JSON = the details, often the values before). Admins only.",
  },
  kpi_snapshots: { note: "Daily KPI snapshots behind Analytics (snapshot_date, scope, key, metrics JSON)." },
  channel_health: {
    note: "Listing Health snapshots per channel (channel, target, run_at, total, in_sync, with_diffs, errors). Take the latest run_at per channel.",
    hide: ["results"],
  },
  marketplace_templates: { note: "The marketplace template files kept in Templates (marketplace, purpose, categories, file_name)." },
  odoo_pending: { note: "What is waiting to be sent to Odoo and why (sku, fields, reason)." },
  odoo_created_products: { note: "Products the PIM created in Odoo." },
  bestbuy_new_listings: { note: "Products sent to Best Buy as new listings and their status." },
  profiles: { note: "The PIM's users: full_name, email, role (admin / editor / designer / viewer), last_seen_at.", hide: ["avatar_url"] },
  shipstation_labels: { note: "ShipStation shipping labels (cost, carrier, dates). Admins only." },
};

export const ASSISTANT_TABLE_NAMES = Object.keys(ASSISTANT_TABLES);
