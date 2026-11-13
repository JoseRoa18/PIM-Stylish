-- Flash deals, MK events and peak season events on the marketplaces the PIM is
-- connected to: Best Buy Canada, Walmart Canada and Walmart USA (user,
-- 2026-11-13: "Haz que se haga eso con todos los que tengamos conexión" — the
-- deal's price goes on the day it starts and comes off when it ends, as on the
-- Sinks Direct stores). Until that day only the monthly promotion reached them
-- by itself; no deal had ever been sent to either through the API.
--
-- What the PIM has put on each channel for a deal, one row per channel and
-- product, written only by the edge function channel-deals. The row is written
-- BEFORE anything is sent (confirmed = false), so a run cut short never leaves
-- a deal price on a marketplace with nothing here to take it back.
create table if not exists public.channel_deal_prices (
  channel text not null check (channel in ('bestbuy', 'walmart_ca', 'walmart_us')),
  sku text not null,
  promotion_id bigint,                   -- the deal whose price is on the channel
  price numeric not null,                -- the deal's price there
  ends_on date not null,                 -- the deal's last day
  -- How the price is there:
  --   discount  Best Buy: the offer's one discount, for the deal's days
  --   created   Walmart: a promotion the PIM created for the deal's days
  --   found     Walmart: the product already sold at that price (the monthly
  --             promotion at the same price) — never taken off by the PIM
  mode text not null default 'created' check (mode in ('discount', 'created', 'found')),
  live_start timestamptz,                -- the promotion on the channel that carries the price
  live_end timestamptz,
  pending jsonb,                         -- Walmart: promotions still to create once the deleted ones are gone
  confirmed boolean not null default false,
  applied_at timestamptz not null default now(),
  checked_at timestamptz,                -- when the channel was last read for this product
  attempts integer not null default 0,   -- failed tries in a row
  last_error text,
  next_try_at timestamptz,               -- a change sent or refused waits until then
  primary key (channel, sku)
);
create index if not exists channel_deal_prices_promotion on public.channel_deal_prices (promotion_id);

alter table public.channel_deal_prices enable row level security;
drop policy if exists channel_deal_prices_select on public.channel_deal_prices;
create policy channel_deal_prices_select on public.channel_deal_prices
  for select to authenticated using (true);

-- Every 10 minutes (the job is created by copying the Sinks Direct one's
-- command, so the cron secret never leaves the database):
--   select cron.schedule('channel-deals', '3-59/10 * * * *',
--     replace(command, 'sinksdirect-deals', 'channel-deals'))
--   from cron.job where jobname = 'sinksdirect-deals';
