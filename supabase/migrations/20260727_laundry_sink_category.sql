-- New product category: Laundry Sink. Applied live via the Management API on
-- 2026-07-27; kept here so fresh environments match.
ALTER TYPE product_category ADD VALUE IF NOT EXISTS 'laundry_sink';
