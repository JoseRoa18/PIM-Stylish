-- Price tiers (pricing strategy, 2026-09-23): Blue = the base MAP already in
-- map_cad / map_usd; Orange = the monthly-promotion MAP; Purple = the deeper
-- MAP for flash deals and special events. Same three levels will exist for
-- the channel costs (added when the cost sheets arrive).
alter table public.products
  add column if not exists map_orange_cad numeric(10,2),
  add column if not exists map_orange_usd numeric(10,2),
  add column if not exists map_purple_cad numeric(10,2),
  add column if not exists map_purple_usd numeric(10,2);
comment on column public.products.map_orange_usd is 'Orange MAP USD — monthly promotion price level (pricing strategy sheet)';
comment on column public.products.map_purple_usd is 'Purple MAP USD — flash deal / special event price level';
