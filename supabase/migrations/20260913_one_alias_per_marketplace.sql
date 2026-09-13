-- One alias per product per marketplace (rule 2026-09-13).
create unique index if not exists product_aliases_marketplace_sku_uq on public.product_aliases (marketplace, sku);
-- amazon_links gets the same rule once the 16 products with several
-- Amazon Canada seller SKUs are reviewed (see memory product-aliases).
