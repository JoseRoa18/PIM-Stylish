-- "Where to Buy" link audit for the Stylish brand sites (Stylish Canada /
-- Stylish USA on Wix). Every product page carries a WHERE TO BUY section
-- (one link per retailer, per market) and a DOCUMENTS TO DOWNLOAD section.
-- The `where-to-buy-audit` edge function scans those sections through the
-- Wix API, cross-checks each link against the ids the PIM already knows
-- (Wayfair item group, Home Depot USA id, Amazon ASIN, SinksDirect slug,
-- Best Buy product id) and probes the URL over HTTP where the retailer
-- lets robots through. One row per link; a row with url = null is a
-- retailer the PIM knows the product is listed on but the page never links.
--
-- verdict (four values only, user rule 2026-09-15; `note` carries the reason):
--   ok       the link opens and shows the product
--   broken   there is a link but it does not work (404, not-found page, redirect
--            to login / home, cut address, or it opens another product)
--   missing  the PIM knows the product is listed there, the page has no link
--   pending  not verified yet (site blocks robots / no answer) — retried hourly

create table if not exists public.where_to_buy_links (
  id uuid primary key default gen_random_uuid(),
  site text not null,                 -- stylish_ca | stylish_us
  sku text not null,
  wix_product_id text,
  section text not null default 'where_to_buy',   -- where_to_buy | documents
  market text,                        -- ca | us | null (locator, documents)
  retailer text not null,             -- registry key (wayfair_ca, amazon_us…) or 'other'
  label text,                         -- anchor text on the page
  url text,                           -- null = missing link
  host text,
  retailer_id text,                   -- id extracted from the URL
  expected_id text,                   -- the PIM's id for this retailer
  verdict text not null default 'unchecked',
  http_status int,
  final_url text,
  note text,
  scanned_at timestamptz not null default now(),
  checked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists where_to_buy_links_site_sku_idx on public.where_to_buy_links (site, sku);
create index if not exists where_to_buy_links_verdict_idx on public.where_to_buy_links (verdict, checked_at);
create unique index if not exists where_to_buy_links_unique_idx
  on public.where_to_buy_links (site, sku, section, retailer, coalesce(url, ''));

alter table public.where_to_buy_links enable row level security;
drop policy if exists "where_to_buy_links_read" on public.where_to_buy_links;
create policy "where_to_buy_links_read" on public.where_to_buy_links
  for select to authenticated using (true);
-- Writes come only from the edge function (service role).

-- Cron: one scan a day (09:20 UTC = 5:20 am VET, before the health refresh),
-- then an HOURLY verification pass: the call probes one paced batch and
-- chains the next one itself until nothing is due (pending links are due
-- again one hour after their last try). <CRON_SECRET> = the function
-- secret of the same name.
select cron.schedule(
  'where-to-buy-scan-daily',
  '20 9 * * *',
  $$select net.http_post(
    url := 'https://vcmizxflfjcpxeccezlc.supabase.co/functions/v1/where-to-buy-audit',
    headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
    body := '{"mode":"scan"}'::jsonb,
    timeout_milliseconds := 10000
  )$$
);

select cron.schedule(
  'where-to-buy-check-hourly',
  '7 * * * *',
  $$select net.http_post(
    url := 'https://vcmizxflfjcpxeccezlc.supabase.co/functions/v1/where-to-buy-audit',
    headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
    body := '{"mode":"check","chain":0}'::jsonb,
    timeout_milliseconds := 10000
  )$$
);
