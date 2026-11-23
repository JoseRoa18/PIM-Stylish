-- Odoo, more often (user, 2026-11-22, asked whether everything could run
-- "prácticamente cada segundo": "Hazlo sí" to the schedules below, and "lo de
-- PIM a Odoo debería ser cada hora también, los productos que estén conectados
-- deben activar el botón de Managed by PIM y llenar los campos").
-- APPLIED live that day through the Management API; this file documents it.
--
-- 1. What the PIM READS from Odoo is read more often. Only the schedules
--    change: the jobs keep their names — other jobs and the products trigger
--    copy the stock pull's command by its name, 'inventory-pull-hourly' — and
--    their commands.
--      inventory-pull-hourly              20 * * * *              → */5 * * * *   stock and arrivals, every 5 minutes
--      odoo-sales-pull                    25 */3 * * *            → 25 * * * *    units sold, every hour
--      scorecard-fill-running             15 1,13,16,19,22 * * *  → 15 * * * *    the ScoreCard's week in progress, every hour
--      scorecard-fill-operations-running  23 1,13,16,19,22 * * *  → 23 * * * *    the same for the Operations tab
--    (The hours the ScoreCard's running job kept away from were for the
--    shipping labels, which no row reads since 2026-11-17.)
select cron.alter_job(j.jobid, schedule := s.schedule)
from cron.job j
join (values
  ('inventory-pull-hourly',             '*/5 * * * *'),
  ('odoo-sales-pull',                   '25 * * * *'),
  ('scorecard-fill-running',            '15 * * * *'),
  ('scorecard-fill-operations-running', '23 * * * *')
) as s(jobname, schedule) on s.jobname = j.jobname;

-- 2. PIM → Odoo every hour, on top of the saves: the odoo-push function's
--    `sync` mode compares every product of the PIM with Odoo — everything the
--    PIM sends but the picture — writes what differs and ticks "Managed by PIM"
--    on every product the PIM is connected to. A page is 100 products by SKU:
--    the job runs once a minute from :05 to :14 and asks for the page of its
--    minute (:05 → the first 100, :06 → the next…), so up to 1,000 products are
--    covered, one page at a time (two pages at once could add the same word to
--    one of Odoo's lists). A page past the last product answers at once.
--    More than 1,000 products: widen the minutes.
--    The same call as the stock pull's job (the cron secret never leaves the
--    database). The hourly retry of what waits for Odoo (odoo-push-retry-hourly,
--    :55) stays as it is.
select cron.unschedule('odoo-push-sync-hourly') where exists (select 1 from cron.job where jobname = 'odoo-push-sync-hourly');
select cron.schedule(
  'odoo-push-sync-hourly', '5-14 * * * *',
  replace(replace(replace(command,
    'functions/v1/inventory-pull', 'functions/v1/odoo-push'),
    $$body := '{}'::jsonb$$, $$body := jsonb_build_object('sync', true, 'offset', (extract(minute from now())::int - 5) * 100)$$),
    'timeout_milliseconds := 30000', 'timeout_milliseconds := 150000'))
from cron.job where jobname = 'inventory-pull-hourly';
