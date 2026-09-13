-- One Amazon seller SKU per product per marketplace (rule 2026-09-13,
-- applied after the 16 manual picks).
create unique index if not exists amazon_links_marketplace_sku_uq on public.amazon_links (marketplace, sku);
