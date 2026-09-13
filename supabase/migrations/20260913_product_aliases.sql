-- How a product is identified elsewhere: the marketplace's own item number,
-- seller SKU, ASIN, listing id… One alias belongs to one product per
-- marketplace; a product can carry several aliases on the same marketplace.
create table if not exists public.product_aliases (
  id uuid primary key default gen_random_uuid(),
  sku text not null references public.products(sku) on delete cascade on update cascade,
  marketplace text not null,
  alias text not null,
  kind text not null default 'sku',
  note text,
  created_at timestamptz not null default now(),
  unique (marketplace, alias)
);
create index if not exists product_aliases_sku_idx on public.product_aliases (sku);
alter table public.product_aliases enable row level security;
drop policy if exists product_aliases_select on public.product_aliases;
create policy product_aliases_select on public.product_aliases for select to authenticated using (true);
drop policy if exists product_aliases_insert on public.product_aliases;
create policy product_aliases_insert on public.product_aliases for insert to authenticated with check (public.app_can_edit());
drop policy if exists product_aliases_update on public.product_aliases;
create policy product_aliases_update on public.product_aliases for update to authenticated using (public.app_can_edit()) with check (public.app_can_edit());
drop policy if exists product_aliases_delete on public.product_aliases;
create policy product_aliases_delete on public.product_aliases for delete to authenticated using (public.app_can_edit());
