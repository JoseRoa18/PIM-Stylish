-- Flash deals, MK events and peak season events on the Sinks Direct stores
-- (user, 2026-11-11: "que apenas se genere el deal … se suba dependiendo de la
-- fecha; si se pone la fecha de hoy, se envía de una vez"). Until that day only
-- the monthly promotion reached those stores by itself: a deal with Sinks
-- Direct among its portals showed "Starts Nov 11" and nothing was sent.
--
-- What the PIM has put on each store for a deal, one row per store and product,
-- written only by the edge function sinksdirect-deals. The row is written
-- BEFORE the change goes to Wix (confirmed = false), so a run cut short can
-- never leave a deal price on a store with nothing here to take it back.
create table if not exists public.sinksdirect_deal_prices (
  site text not null,                    -- sinksdirect_ca | sinksdirect_us
  sku text not null,
  promotion_id bigint,                   -- the deal whose price is on the store
  price numeric not null,                -- the deal's price there
  base_price numeric,                    -- the regular price (MAP) it was set against
  live_price numeric,                    -- what Wix answered the product sells at
  confirmed boolean not null default false,
  applied_at timestamptz not null default now(),
  attempts integer not null default 0,   -- failed tries in a row (Wix refused the change)
  last_error text,
  next_try_at timestamptz,               -- a refused change waits until then
  before jsonb,                          -- Sinks Direct Canada: the PIM's sale fields before the deal
  primary key (site, sku)
);
create index if not exists sinksdirect_deal_prices_promotion on public.sinksdirect_deal_prices (promotion_id);

alter table public.sinksdirect_deal_prices enable row level security;
drop policy if exists sinksdirect_deal_prices_select on public.sinksdirect_deal_prices;
create policy sinksdirect_deal_prices_select on public.sinksdirect_deal_prices
  for select to authenticated using (true);

-- Every 5 minutes, like the Stylish events (the job is created by copying that
-- one's command, so the cron secret never leaves the database):
--   select cron.schedule('sinksdirect-deals', '1-59/5 * * * *',
--     replace(command, 'stylish-event-discounts', 'sinksdirect-deals'))
--   from cron.job where jobname = 'stylish-event-discounts';
