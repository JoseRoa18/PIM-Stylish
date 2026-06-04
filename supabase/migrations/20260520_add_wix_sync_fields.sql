-- Expand the products table with the fields Wix Stores exposes that the
-- PIM can own as source of truth. Inventory and POS visibility are stored
-- here but NOT yet pushed (Wix V1 product PATCH doesn't accept them).

alter table public.products
  -- Tier 1: Pricing & basics
  add column if not exists ribbon              text,
  add column if not exists sale_price_cad      numeric(10, 2),
  add column if not exists on_sale             boolean default false,
  add column if not exists shipping_weight_lb  numeric(10, 3),
  add column if not exists pre_order           boolean default false,

  -- Tier 2: Visibility
  add column if not exists visible_online      boolean default true,
  add column if not exists visible_pos         boolean default true,

  -- Tier 3: Wix categories (stored as IDs from Wix collections)
  add column if not exists wix_collection_ids  text[] default '{}'::text[],

  -- Tier 4: Additional info sections (rich-text blocks shown on Wix product page)
  add column if not exists additional_info_sections jsonb default '[]'::jsonb;

-- Make existing rows non-null where it makes sense.
update public.products
  set visible_online = true
  where visible_online is null;

update public.products
  set visible_pos = true
  where visible_pos is null;

update public.products
  set on_sale = false
  where on_sale is null;

update public.products
  set pre_order = false
  where pre_order is null;
