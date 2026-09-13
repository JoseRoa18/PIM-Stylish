-- Walmart Canada promotions scheduled through the API (feed
-- PRICE_AND_PROMOTION): when, and the per-feed report.
alter table public.promotions add column if not exists wm_ca_scheduled_at timestamptz;
alter table public.promotions add column if not exists wm_ca_schedule jsonb;
