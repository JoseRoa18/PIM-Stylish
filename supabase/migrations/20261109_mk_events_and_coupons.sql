-- MK Events (user, 2026-11-09): a copy of the flash deals, Orange level, with
-- Bed Bath & Beyond and Overstock at Purple. promotion_level_of() already reads
-- every kind but 'special' as Orange.
alter table public.promotions drop constraint if exists promotions_kind_check;
alter table public.promotions add constraint promotions_kind_check
  check (kind in ('monthly', 'flash', 'mk_event', 'special'));
comment on column public.promotions.kind is 'monthly (calendar, automated) | flash (Flash Deals) | mk_event (MK Events) | special (Peak Season Events) — all but monthly need starts_on/ends_on';

-- Coupons (user, 2026-11-09): only Amazon and Wayfair, by percentage or by
-- money, several running at once, each with its products. A record kept in the
-- PIM: nothing here reaches a marketplace or changes an expected price.
create table if not exists public.coupons (
  id bigint generated always as identity primary key,
  name text not null,
  marketplace text not null check (marketplace in ('amazon_ca', 'amazon_us', 'wayfair_ca', 'wayfair_us')),
  discount_type text not null check (discount_type in ('percent', 'amount')),
  discount_value numeric not null check (discount_value > 0),
  starts_on date not null,
  ends_on date not null,
  ended_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint coupons_dates_check check (ends_on >= starts_on),
  constraint coupons_percent_check check (discount_type <> 'percent' or discount_value < 100)
);

create table if not exists public.coupon_products (
  coupon_id bigint not null references public.coupons(id) on delete cascade,
  sku text not null references public.products(sku) on delete cascade,
  primary key (coupon_id, sku)
);
create index if not exists coupon_products_sku on public.coupon_products (sku);

alter table public.coupons enable row level security;
alter table public.coupon_products enable row level security;

drop policy if exists coupons_select on public.coupons;
drop policy if exists coupons_insert on public.coupons;
drop policy if exists coupons_update on public.coupons;
drop policy if exists coupons_delete on public.coupons;
create policy coupons_select on public.coupons for select to authenticated using (true);
create policy coupons_insert on public.coupons for insert to authenticated with check (public.app_can_edit());
create policy coupons_update on public.coupons for update to authenticated using (public.app_can_edit()) with check (public.app_can_edit());
create policy coupons_delete on public.coupons for delete to authenticated using (public.app_can_edit());

drop policy if exists coupon_products_select on public.coupon_products;
drop policy if exists coupon_products_insert on public.coupon_products;
drop policy if exists coupon_products_delete on public.coupon_products;
create policy coupon_products_select on public.coupon_products for select to authenticated using (true);
create policy coupon_products_insert on public.coupon_products for insert to authenticated with check (public.app_can_edit());
create policy coupon_products_delete on public.coupon_products for delete to authenticated using (public.app_can_edit());
