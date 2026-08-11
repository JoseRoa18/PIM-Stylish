-- Scheduled Wayfair spec-attributes audit (APPLIED 2026-08-11 via the
-- management API with the real secret; this file documents the setup).
--
-- Twice a day, 20 minutes BEFORE each health-refresh run (so the re-score
-- reads a fresh snapshot), pg_cron calls the `wayfair-audit` edge function.
-- The function answers 202 immediately and runs the audit as a background
-- task: Wayfair's rate limit only allows ~half the catalog per run, so runs
-- rotate (least-recently-audited SKUs first) and merge the rest forward from
-- the previous snapshot — the published snapshot is always full-catalog and
-- no SKU goes more than ~a day stale.
--
-- <CRON_SECRET> is the function secret of the same name (write-only; set via
-- `supabase secrets set CRON_SECRET=... --project-ref vcmizxflfjcpxeccezlc`).
-- The live value is recoverable from `select command from cron.job;`.

select cron.schedule(
  'wayfair-audit-640am-vet',
  '40 10 * * *',
  $$select net.http_post(
    url := 'https://vcmizxflfjcpxeccezlc.supabase.co/functions/v1/wayfair-audit',
    headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  )$$
);

select cron.schedule(
  'wayfair-audit-140pm-vet',
  '40 17 * * *',
  $$select net.http_post(
    url := 'https://vcmizxflfjcpxeccezlc.supabase.co/functions/v1/wayfair-audit',
    headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  )$$
);
