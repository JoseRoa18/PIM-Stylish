-- The Stylish pages' publish queue gets its own run (where-to-buy-audit mode
-- "publish", every 5 minutes): the check calls only drain it with time left
-- over, and once they opened 20 pages at a time (2026-10-20) they had none —
-- 163 products waiting to drop their wrong-product links moved by ~5 in 20
-- minutes. Each run writes up to 10 products (both sites) and stops when Wix
-- asks to wait. The command is the check job's own — its headers carry the
-- cron secret — with the publish body. APPLIED 2026-10-20.
select cron.schedule(
  'where-to-buy-publish',
  '2-59/5 * * * *',
  (select replace(replace(command, '{"mode":"check","chain":0}', '{"mode":"publish"}'), 'timeout_milliseconds := 10000', 'timeout_milliseconds := 60000')
     from cron.job where jobname = 'where-to-buy-check-hourly')
);
