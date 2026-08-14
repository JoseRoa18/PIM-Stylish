-- Multi-site Wix links: one PIM product can be listed on several Wix sites
-- (SinksDirect CA/USA, Stylish CA/USA). Each link row maps a SKU to that
-- site's Wix product id. The legacy products.wix_product_id column remains
-- the SinksDirect Canada link (kept in sync by the edge functions) so the
-- existing health/dashboard readers keep working.

create table if not exists public.wix_links (
  site text not null,
  sku text not null references public.products(sku) on delete cascade on update cascade,
  wix_product_id text not null,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (site, sku)
);

-- One Wix product can back only one SKU per site.
create unique index if not exists wix_links_site_product_uq
  on public.wix_links (site, wix_product_id);

alter table public.wix_links enable row level security;

create policy wix_links_select on public.wix_links
  for select to authenticated using (true);
create policy wix_links_insert on public.wix_links
  for insert to authenticated with check (public.app_can_edit());
create policy wix_links_update on public.wix_links
  for update to authenticated using (public.app_can_edit()) with check (public.app_can_edit());
create policy wix_links_delete on public.wix_links
  for delete to authenticated using (public.app_can_edit());

-- Backfill: the existing per-product link IS the SinksDirect Canada link.
insert into public.wix_links (site, sku, wix_product_id, synced_at)
select 'sinksdirect_ca', sku, wix_product_id, wix_synced_at
from public.products
where wix_product_id is not null
on conflict do nothing;
