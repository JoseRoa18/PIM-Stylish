-- The review count a store page shows, read with its price by the Where to Buy check (BB&B and Overstock for now).
alter table public.where_to_buy_links add column if not exists review_count integer;
