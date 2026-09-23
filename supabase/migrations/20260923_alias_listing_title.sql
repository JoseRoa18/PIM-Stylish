-- The name a marketplace lists the product under (Rona's "Product
-- Description", for instance). It travels with the alias: one per product
-- per marketplace, used by that marketplace's files next to the alias.
alter table public.product_aliases add column if not exists listing_title text;
