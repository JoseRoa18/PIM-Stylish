-- A flash deal or special event is made for the marketplaces picked when it
-- is created (rule of the user 2026-09-23: one or several portals, never
-- "all"). The promotion carries their channel keys (PROMO_CHANNELS.key,
-- e.g. 'rona', 'walmart_ca'). Monthly promotions keep null = every one.
alter table public.promotions drop column if exists marketplace;
alter table public.promotions add column if not exists marketplaces text[];
create index if not exists promotions_marketplaces_idx on public.promotions using gin (marketplaces);
