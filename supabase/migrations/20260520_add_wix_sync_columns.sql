-- Wix syndication: link PIM products to Wix Stores catalog
-- and store last-sync timestamp + original Wix payload for diffing.

alter table public.products
  add column if not exists wix_product_id text,
  add column if not exists wix_synced_at  timestamptz,
  add column if not exists description    text,
  add column if not exists wix_raw        jsonb;

-- A given Wix product id can only map to one PIM row.
-- Nullable rows (PIM-only products) are allowed; the partial index excludes them.
create unique index if not exists products_wix_product_id_key
  on public.products (wix_product_id)
  where wix_product_id is not null;

-- Helpful for filtering "products synced from Wix" in the UI.
create index if not exists products_wix_synced_at_idx
  on public.products (wix_synced_at desc nulls last);
