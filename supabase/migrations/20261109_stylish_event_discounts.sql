-- Special events on the Stylish stores (user, 2026-11-09). An event that lists
-- wix_stylish_ca / wix_stylish_us carries how its discount is defined:
--   { "mode": "percent", "percent": 10 }
--   { "mode": "price", "prices": { "ca": { "S-611W": 386.91 }, "us": { ... } } }
-- `prices` are what the customer pays; the store price is that amount / 0.3
-- (the website gives the customer 70% off; 27 / 0.3 = 90), see
-- _shared/stylishDiscount.js.
alter table public.promotions add column if not exists stylish_discount jsonb;

-- An event for the Stylish stores goes only to them (the two can go together).
alter table public.promotions drop constraint if exists promotions_stylish_alone;
alter table public.promotions add constraint promotions_stylish_alone check (
  marketplaces is null
  or not (marketplaces && array['wix_stylish_ca', 'wix_stylish_us']::text[])
  or marketplaces <@ array['wix_stylish_ca', 'wix_stylish_us']::text[]
);

-- What the PIM has put on each store, one row per store and product, written
-- only by the edge function stylish-event-discounts. The row is written BEFORE
-- the change goes to Wix (confirmed = false), so a run cut short can never
-- leave a discount on a store with nothing here to take it off.
create table if not exists public.stylish_event_discounts (
  site text not null,
  sku text not null,
  promotion_id bigint,
  discount_type text not null,
  discount_value numeric not null,
  store_price numeric,
  live_price numeric,
  confirmed boolean not null default false,
  applied_at timestamptz not null default now(),
  primary key (site, sku)
);
create index if not exists stylish_event_discounts_promotion on public.stylish_event_discounts (promotion_id);

alter table public.stylish_event_discounts enable row level security;
drop policy if exists stylish_event_discounts_select on public.stylish_event_discounts;
create policy stylish_event_discounts_select on public.stylish_event_discounts
  for select to authenticated using (true);
