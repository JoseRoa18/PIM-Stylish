-- One PIM product can carry SEVERAL Amazon seller SKUs on one marketplace
-- (FBA/FBM offers, legacy codes), so the key is the seller SKU, not the
-- product.
alter table public.amazon_links drop constraint if exists amazon_links_pkey;
drop index if exists public.amazon_links_marketplace_seller_sku_uq;
alter table public.amazon_links add primary key (marketplace, seller_sku);
create index if not exists amazon_links_marketplace_sku_idx on public.amazon_links (marketplace, sku);
