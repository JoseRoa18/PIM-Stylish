-- New products get their stock at once: after every INSERT statement on
-- products (Create Product, an import batch of 50, a script) pg_net calls
-- the inventory-pull function exactly as the hourly cron does. The pull
-- re-matches every source SKU against products.sku, so a SKU that was
-- already in the warehouse shows its stock seconds after the product exists
-- in the PIM (Canada only when the PIM can reach the workbook by itself).
--
-- The request IS the cron job's own command (cron.job), so the CRON_SECRET
-- never leaves the database and a secret rotation only has to touch the
-- job. Bursts (an import inserts in batches) are collapsed to at most one
-- request per minute (marker row app_settings.inventory_pull_request); the
-- hourly cron catches anything skipped. Nothing here can block the insert:
-- any failure is logged as a warning and swallowed.
--
-- APPLIED live 2026-09-25 via the management API; this file documents it.

create or replace function public.request_inventory_pull()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cmd text;
  last_request timestamptz;
begin
  select (value->>'requested_at')::timestamptz into last_request
    from public.app_settings where key = 'inventory_pull_request';
  if last_request is not null and last_request > now() - interval '1 minute' then
    return null;
  end if;

  select command into cmd from cron.job where jobname = 'inventory-pull-hourly';
  if cmd is null then
    return null;
  end if;

  insert into public.app_settings (key, value, updated_at)
    values ('inventory_pull_request', jsonb_build_object('requested_at', now(), 'reason', 'products insert'), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  execute cmd;
  return null;
exception when others then
  raise warning 'request_inventory_pull skipped: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists products_request_inventory_pull on public.products;
create trigger products_request_inventory_pull
  after insert on public.products
  for each statement
  execute function public.request_inventory_pull();
