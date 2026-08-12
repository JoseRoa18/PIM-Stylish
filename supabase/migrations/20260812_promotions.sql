-- Monthly promotions. The promo prices come from the user's official lists
-- (never computed from percentages), one promotion per month, applying to
-- ALL marketplaces — per-marketplace promo templates will be generated from
-- these rows later. Applying a promotion to the Wix store copies the CAD
-- promo price into products.on_sale/sale_price_cad for its member SKUs
-- (pushes stay manual, as everywhere).

create table if not exists public.promotions (
  id           bigint generated always as identity primary key,
  name         text not null,
  period       date not null,               -- first day of the promo month
  status       text not null default 'draft', -- draft | active | ended
  created_at   timestamptz not null default now(),
  activated_at timestamptz,
  ended_at     timestamptz
);

create table if not exists public.promotion_prices (
  id              bigint generated always as identity primary key,
  promotion_id    bigint not null references public.promotions(id) on delete cascade,
  sku             text not null references public.products(sku) on delete cascade,
  promo_price_cad numeric,
  promo_price_usd numeric,
  unique (promotion_id, sku)
);

create index if not exists promotion_prices_promo_idx on public.promotion_prices (promotion_id);

alter table public.promotions enable row level security;
alter table public.promotion_prices enable row level security;

create policy promotions_select on public.promotions for select to authenticated using (true);
create policy promotions_insert on public.promotions for insert to authenticated with check (public.app_can_edit());
create policy promotions_update on public.promotions for update to authenticated using (public.app_can_edit()) with check (public.app_can_edit());
create policy promotions_delete on public.promotions for delete to authenticated using (public.app_can_edit());

create policy promotion_prices_select on public.promotion_prices for select to authenticated using (true);
create policy promotion_prices_insert on public.promotion_prices for insert to authenticated with check (public.app_can_edit());
create policy promotion_prices_update on public.promotion_prices for update to authenticated using (public.app_can_edit()) with check (public.app_can_edit());
create policy promotion_prices_delete on public.promotion_prices for delete to authenticated using (public.app_can_edit());
