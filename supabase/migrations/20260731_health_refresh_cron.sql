-- Scheduled channel + listing-health refresh (APPLIED 2026-07-31 via the
-- management API with the real secret; this file documents the setup).
--
-- Twice a day (11:00 & 18:00 UTC = 7 am & 2 pm America/Caracas) pg_cron calls
-- the `health-refresh` edge function, which pulls the read-only channel
-- states (Best Buy offers, Walmart US items, Walmart CA feed) and re-scores
-- the catalog, persisting channel_health snapshots + listing_health
-- summaries for the Dashboard.
--
-- <CRON_SECRET> is the function secret of the same name (write-only; set via
-- `supabase secrets set CRON_SECRET=... --project-ref vcmizxflfjcpxeccezlc`).
-- The live value is recoverable from `select command from cron.job;`.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'health-refresh-7am-vet',
  '0 11 * * *',
  $$select net.http_post(
    url := 'https://vcmizxflfjcpxeccezlc.supabase.co/functions/v1/health-refresh',
    headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  )$$
);

select cron.schedule(
  'health-refresh-2pm-vet',
  '0 18 * * *',
  $$select net.http_post(
    url := 'https://vcmizxflfjcpxeccezlc.supabase.co/functions/v1/health-refresh',
    headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  )$$
);
