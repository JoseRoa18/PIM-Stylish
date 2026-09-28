-- Walmart USA promotions scheduled through the API (feed `promo`, the
-- PromotionalPriceFeed): when, and the per-feed report — the USA twin of
-- 20260913_walmart_ca_promo.sql. Both markets are now scheduled by the
-- promo-apply cron the day before their window opens (Settings switches
-- walmart_ca / walmart_us in promo_automation).
--
-- APPLIED live 2026-09-28 via the management API; this file documents it.
alter table public.promotions add column if not exists wm_us_scheduled_at timestamptz;
alter table public.promotions add column if not exists wm_us_schedule jsonb;
