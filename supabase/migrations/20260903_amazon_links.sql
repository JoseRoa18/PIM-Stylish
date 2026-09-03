-- Amazon (Selling Partner API) links: one PIM product can be listed on several
-- Amazon marketplaces (us = Amazon.com, ca = Amazon.ca). Each row maps a SKU to
-- that marketplace's seller SKU + ASIN and caches what the API last reported
-- (status, price, quantity, listing issues) so Marketplace Health and the price
-- alignment can read Amazon without calling the API on every render.
--
-- The PIM stays the source of truth: these columns are a CACHE of Amazon's
-- side, never an input to a push.

create table if not exists public.amazon_links (
  marketplace text not null,
  sku text not null references public.products(sku) on delete cascade on update cascade,
  seller_sku text not null,
  asin text,
  status text,
  fulfillment text,
  price numeric,
  currency text,
  quantity integer,
  issues jsonb,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (marketplace, sku)
);

-- One Amazon seller SKU backs only one PIM SKU per marketplace.
create unique index if not exists amazon_links_marketplace_seller_sku_uq
  on public.amazon_links (marketplace, seller_sku);
create index if not exists amazon_links_asin_idx on public.amazon_links (asin);

alter table public.amazon_links enable row level security;

create policy amazon_links_select on public.amazon_links
  for select to authenticated using (true);
create policy amazon_links_insert on public.amazon_links
  for insert to authenticated with check (public.app_can_edit());
create policy amazon_links_update on public.amazon_links
  for update to authenticated using (public.app_can_edit()) with check (public.app_can_edit());
create policy amazon_links_delete on public.amazon_links
  for delete to authenticated using (public.app_can_edit());
