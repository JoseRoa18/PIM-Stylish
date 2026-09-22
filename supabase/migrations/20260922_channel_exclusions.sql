-- Per-product marketplace exclusions (rule 2026-09-22): a product switched
-- off for a marketplace is left out of that marketplace's promotion files
-- and API promo pushes. Keys are the promo channel keys (bestbuy, walmart_ca,
-- amazon_us, homedepot_us…).
alter table public.products
  add column if not exists channel_exclusions text[] not null default '{}';
create index if not exists products_channel_exclusions_idx on public.products using gin (channel_exclusions);
comment on column public.products.channel_exclusions is 'Promo channel keys this product is excluded from (no promo files / pushes there)';
