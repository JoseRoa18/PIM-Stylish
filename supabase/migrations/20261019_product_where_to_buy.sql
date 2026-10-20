-- The PIM owns the WHERE TO BUY links of the Stylish product pages (user,
-- 2026-10-19: "que PIM sea dueño, de esa forma podemos automatizar").
-- ONE list per product — one address per retailer — and the WHERE TO BUY
-- section of BOTH Stylish sites (Canada, USA) is built from it
-- (supabase/functions/_shared/whereToBuy.js) and pushed to Wix on save.
-- Before this, each page's section was edited by hand in Wix and the two
-- pages never agreed. Loaded first from the live pages
-- (scripts/import-where-to-buy-from-wix.mjs). The Listing Health audit
-- (where_to_buy_links) checks these links; `retailer` uses its keys.

create table if not exists public.product_where_to_buy (
  sku text not null references public.products(sku) on delete cascade on update cascade,
  retailer text not null,                       -- wayfair_ca, amazon_us… (WTB_RETAILERS)
  url text not null,
  source text not null default 'manual',        -- wix_import | manual | auto
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (sku, retailer)
);

alter table public.product_where_to_buy enable row level security;
drop policy if exists product_where_to_buy_select on public.product_where_to_buy;
create policy product_where_to_buy_select on public.product_where_to_buy for select to authenticated using (true);
drop policy if exists product_where_to_buy_insert on public.product_where_to_buy;
create policy product_where_to_buy_insert on public.product_where_to_buy for insert to authenticated with check (public.app_can_edit());
drop policy if exists product_where_to_buy_update on public.product_where_to_buy;
create policy product_where_to_buy_update on public.product_where_to_buy for update to authenticated using (public.app_can_edit()) with check (public.app_can_edit());
drop policy if exists product_where_to_buy_delete on public.product_where_to_buy;
create policy product_where_to_buy_delete on public.product_where_to_buy for delete to authenticated using (public.app_can_edit());
