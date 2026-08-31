-- Market-split promo calendar (rule 2026-08-28; APPLIED live the same day
-- via the management API — this file documents it).
--
--   USA    — promo flips on the 1st at 00:00 America/Toronto.
--   Canada — promo flips on the FIRST THURSDAY at 00:00 America/Toronto and
--            runs to the day before the next month's first Thursday.
--   Best Buy discounts are (re)scheduled the DAY BEFORE Canada's start.
--
-- promo-apply now runs DAILY and decides by date. Two firings cover Eastern
-- DST: 04:05 UTC = 00:05 EDT (summer) and 05:05 UTC = 00:05 EST (winter);
-- boundary passes stamp promotions.us_applied_at / ca_applied_at, so the
-- other firing of the pair is a no-op.

alter table public.promotions add column if not exists us_applied_at timestamptz;
alter table public.promotions add column if not exists ca_applied_at timestamptz;

-- Replace the old monthly job with the daily pair, reusing its command
-- (which carries the real anon key + cron secret) verbatim.
do $do$
declare
  cmd text;
begin
  select command into cmd from cron.job where jobname = 'promo-apply-month-start';
  if cmd is null then
    select command into cmd from cron.job where jobname = 'promo-apply-daily-edt';
  end if;
  if cmd is null then
    raise exception 'promo-apply cron job not found — nothing to clone';
  end if;
  perform cron.unschedule(jobid) from cron.job
    where jobname in ('promo-apply-month-start', 'promo-apply-daily-edt', 'promo-apply-daily-est');
  perform cron.schedule('promo-apply-daily-edt', '5 4 * * *', cmd);
  perform cron.schedule('promo-apply-daily-est', '5 5 * * *', cmd);
end
$do$;
