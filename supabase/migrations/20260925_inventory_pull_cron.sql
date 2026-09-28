-- Hourly stock pull: pg_cron calls the `inventory-pull` edge function — USA
-- from ShipStation every run; Canada only when the PIM can reach the
-- "Stylish Inventory" workbook by itself (CA_INVENTORY_XLSX_URL), otherwise
-- the rows loaded from the daily email / the Settings upload stay as they
-- are (see 20260925_product_inventory.sql). Body {} = both markets.
--
-- A few ShipStation requests per run (warehouses + 250-row inventory
-- pages), far below the API's rate limit; :20 keeps clear of the other
-- jobs. The pull takes a few seconds, hence the 30 s timeout.
--
-- <CRON_SECRET> is the function secret of the same name (write-only; set via
-- `supabase secrets set CRON_SECRET=... --project-ref vcmizxflfjcpxeccezlc`).
-- APPLIED live 2026-09-25 without the secret ever leaving Postgres: first as
-- 'shipstation-inventory-hourly' by copying the health-refresh job's command
-- with the URL and timeout swapped, then re-created under this name when the
-- function became `inventory-pull`. This file documents it.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'inventory-pull-hourly',
  '20 * * * *',
  $$select net.http_post(
    url := 'https://vcmizxflfjcpxeccezlc.supabase.co/functions/v1/inventory-pull',
    headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )$$
);
