-- A flash deal or special event is made for ONE marketplace (rule of the
-- user 2026-09-23): the promotion carries the channel key it was created
-- for (PROMO_CHANNELS.key, e.g. 'rona', 'walmart_ca'). Monthly promotions
-- keep null = every marketplace.
alter table public.promotions add column if not exists marketplace text;
create index if not exists promotions_marketplace_idx on public.promotions (marketplace);
