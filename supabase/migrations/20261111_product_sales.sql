-- Units sold per product, market and marketplace, read from Odoo (user,
-- 2026-11-11: "Ventas por SKU y marketplace: unidades de 30 y 90 días en la
-- página del producto, y días de inventario … para elegir qué meter en
-- promoción" — "SI").
--
-- A CACHE written only by the odoo-sales-pull edge function (every 3 hours):
-- one row per market (ca / us = the order's company) and SKU that sold in the
-- last 90 days, with the units of the last 30 and 90 days and the same split
-- by marketplace in `channels` ({ "<marketplace>": { u30, u90 } }). Only
-- lines sold with a price count, on confirmed orders. A product that sold
-- nothing has no row. It is information about sales, like the stock — it
-- never changes a product's own data (product data goes PIM → Odoo only).

create table if not exists public.product_sales (
  market     text not null check (market in ('ca', 'us')),
  sku        text not null references public.products(sku) on update cascade on delete cascade,
  units_30   numeric not null default 0,
  units_90   numeric not null default 0,
  channels   jsonb not null default '{}'::jsonb,
  synced_at  timestamptz not null default now(),
  primary key (market, sku)
);

comment on table public.product_sales is
  'Units sold per market and SKU in the last 30 / 90 days, from Odoo (odoo-sales-pull). A cache: never edited by hand.';

alter table public.product_sales enable row level security;

drop policy if exists product_sales_select on public.product_sales;
create policy product_sales_select
  on public.product_sales for select
  to authenticated
  using (true);

-- Every 3 hours, the same call as the stock pull's job (the cron secret never
-- leaves the database).
select cron.unschedule('odoo-sales-pull') where exists (select 1 from cron.job where jobname = 'odoo-sales-pull');
select cron.schedule(
  'odoo-sales-pull', '25 */3 * * *',
  replace(replace(command,
    'functions/v1/inventory-pull', 'functions/v1/odoo-sales-pull'),
    'timeout_milliseconds := 30000', 'timeout_milliseconds := 120000'))
from cron.job where jobname = 'inventory-pull-hourly';
