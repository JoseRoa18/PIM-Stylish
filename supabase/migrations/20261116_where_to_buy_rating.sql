-- The average rating a store page shows for the product (out of 5), read with its
-- review count and its price by the Where to Buy check (user, 2026-11-16: "solo
-- necesito la cantidad de reviews y el rating global"). review_count (2026-11-09,
-- BB&B and Overstock) is now read on every store whose page says it: Amazon,
-- Wayfair, Home Depot, Lowe's, Rona, Best Buy, Walmart, BB&B, Overstock, Sinks
-- Direct (supabase/functions/_shared/pageReaders/reviews.js).
alter table public.where_to_buy_links add column if not exists rating numeric(3, 2);

comment on column public.where_to_buy_links.review_count is 'How many reviews (or ratings) the store page shows for the product; null = the page did not say.';
comment on column public.where_to_buy_links.rating is 'The average rating the store page shows for the product, out of 5; null with no review or when the page did not say.';
