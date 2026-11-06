-- A product on its way onto Best Buy Canada (user, 2026-11-06: "necesitamos crear
-- productos desde 0"; "yo elijo qué oferta crear"; "¿se le puede agregar el offer de
-- una vez?"). The edge function bestbuy-new-listing writes it when a person sends the
-- product or its offer, and notes how Best Buy answered. offer_wanted: the person
-- asked for the offer with the product; it goes at the first check after approval.
create table if not exists public.bestbuy_new_listings (
  sku text primary key references public.products(sku) on delete cascade,
  upc text not null,
  category_code text,
  via text not null check (via in ('content', 'catalog')),  -- content = created through the content import; catalog = Best Buy already had the UPC
  status text not null check (status in ('in_review', 'approved', 'offer_sent', 'live', 'refused', 'failed')),
  note text,                 -- Best Buy's reason when it refused
  content_import_id text,
  offer_import_id text,
  bb_product_id text,
  requested_by uuid,
  requested_at timestamptz not null default now(),
  checked_at timestamptz,
  offer_sent_at timestamptz,
  live_at timestamptz
);
alter table public.bestbuy_new_listings add column if not exists offer_wanted boolean not null default false;

create index if not exists bestbuy_new_listings_status_idx on public.bestbuy_new_listings (status);

alter table public.bestbuy_new_listings enable row level security;

-- Everyone signed in can read how it goes; only the service role writes.
drop policy if exists bestbuy_new_listings_select on public.bestbuy_new_listings;
create policy bestbuy_new_listings_select on public.bestbuy_new_listings
  for select to authenticated using (true);
