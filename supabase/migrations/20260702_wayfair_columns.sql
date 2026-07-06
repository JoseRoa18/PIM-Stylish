-- Wayfair syndication columns on products
-- ----------------------------------------------------------------------------
-- wayfair_item_group_id : the Wayfair internal item-GROUP id (SKU-level) that a
--   product maps to. Marketing copy + feature bullets are updated at the group
--   level on Wayfair, so we need this to push content. Images push by
--   supplierPartNumber directly, so they don't need it.
-- wayfair_synced_at     : last time we pushed this product to Wayfair (live, not
--   validate-only).
-- ----------------------------------------------------------------------------

alter table public.products
  add column if not exists wayfair_item_group_id text,
  add column if not exists wayfair_synced_at timestamptz;

comment on column public.products.wayfair_item_group_id is
  'Wayfair item-group id (SKU level) this product maps to; needed to push marketing copy + bullets.';
