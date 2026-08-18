-- Scheduled monthly promotion apply (APPLIED 2026-08-18 via the management
-- API with the real secret; this file documents the setup).
--
-- On the 1st of every month at 04:00 UTC (= 00:00 America/Caracas, no DST)
-- pg_cron calls the `promo-apply` edge function, which — when the
-- 'promo_automation' app_setting is enabled — ends the previous month's
-- promotion, applies the new month's one to the store pricing, and pushes
-- the resulting prices to the promo-aware Wix sites. Best Buy needs nothing
-- at midnight: its discounts are scheduled in Mirakl ahead of time (when the
-- promo is loaded) and Mirakl flips them at the start date on its own; the
-- function only re-submits them as a safety net.
--
-- <CRON_SECRET> is the same function secret used by health-refresh
-- (recoverable from `select command from cron.job;`). <ANON_KEY> is the
-- public anon key: promo-apply is deployed WITH JWT verification (unlike
-- health-refresh's --no-verify-jwt), so the request carries the anon key to
-- pass the gateway — authorization itself still comes from x-cron-secret.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'promo-apply-month-start',
  '0 4 1 * *',
  $$select net.http_post(
    url := 'https://vcmizxflfjcpxeccezlc.supabase.co/functions/v1/promo-apply',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <ANON_KEY>","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  )$$
);
