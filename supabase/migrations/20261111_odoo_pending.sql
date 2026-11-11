-- What the PIM could not send to Odoo yet, tried again every hour (user,
-- 2026-11-11: "Reintento cada hora de lo que quedó sin enviar, para los
-- productos que se creen en Odoo después" — "SI").
--
-- One row per SKU with the fields that wait and why: the product is not in
-- Odoo yet (or is archived there, or has two active records), another Odoo
-- product holds its UPC, its HS code is not on Odoo's list, or Odoo gave an
-- error. The odoo-push edge function writes a row when a send is held for one
-- of those reasons, tries the rows again every hour (`retry: true`, cron
-- odoo-push-retry-hourly, :55) and drops a row once its fields went. What the
-- PIM itself lacks (no UPC, half a box) never waits here: saving it sends it.
--
-- Written only by the edge function (service role); everyone signed in reads.

create table if not exists public.odoo_pending (
  sku       text primary key references public.products(sku) on update cascade on delete cascade,
  fields    text[] not null,
  reason    text,
  note      text,
  since     timestamptz not null default now(),
  tried_at  timestamptz
);

comment on table public.odoo_pending is
  'Fields the PIM could not send to Odoo yet (odoo-push), retried every hour until they go.';

alter table public.odoo_pending enable row level security;

drop policy if exists odoo_pending_select on public.odoo_pending;
create policy odoo_pending_select
  on public.odoo_pending for select
  to authenticated
  using (true);

-- The hourly retry: the same call as the stock pull's job, to odoo-push
-- (the cron secret never leaves the database).
select cron.unschedule('odoo-push-retry-hourly') where exists (select 1 from cron.job where jobname = 'odoo-push-retry-hourly');
select cron.schedule(
  'odoo-push-retry-hourly', '55 * * * *',
  replace(replace(replace(command,
    'functions/v1/inventory-pull', 'functions/v1/odoo-push'),
    $$body := '{}'::jsonb$$, $$body := '{"retry":true}'::jsonb$$),
    'timeout_milliseconds := 30000', 'timeout_milliseconds := 120000'))
from cron.job where jobname = 'inventory-pull-hourly';
