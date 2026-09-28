-- Stock per product and market, CACHED from the warehouse system so the
-- promotion tables (and later the marketplace files) can read it without
-- calling an API on every render.
--
-- The source is ShipStation Inventory (API v2), one account per market:
-- market 'us' is the USA account (Flowery Branch, GA — plus a small "Walmart"
-- warehouse) and market 'ca' the Canada account (only its "85 THOMPSON DR
-- CAMBRIDGE WH" warehouse is read).
--
-- The `shipstation-pull-inventory` edge function (hourly via pg_cron, after
-- every product insert, or the Refresh button) rewrites the market's rows on
-- every pull. A SKU that never had a row is "not tracked" (stock unknown,
-- NOT 0); see 20260925_product_inventory_dropped.sql for SKUs that vanish
-- from ShipStation's list. Written with the service role only; the app just
-- reads.

create table if not exists public.product_inventory (
  market text not null check (market in ('us', 'ca')),
  sku text not null references public.products(sku) on delete cascade on update cascade,
  on_hand integer not null default 0,
  available integer not null default 0,
  warehouses jsonb,                             -- { "<warehouse name>": { "on_hand": n, "available": n } }
  source text not null default 'shipstation',
  source_sku text,                              -- the SKU as the source spells it (A-921bk vs A-921BK)
  synced_at timestamptz not null default now(),
  primary key (market, sku)
);

create index if not exists product_inventory_sku_idx on public.product_inventory (sku);

alter table public.product_inventory enable row level security;

-- Everyone signed in can read stock; nobody writes through the app.
create policy product_inventory_select on public.product_inventory
  for select to authenticated using (true);
