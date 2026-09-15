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
-- verdict:
--   unchecked    scanned, HTTP probe still pending
--   ok           HTTP 2xx on the page
--   broken       HTTP 404/410, or the page says "not found"
--   redirected   landed somewhere else (home page, password page, other host)
--   blocked      the retailer refuses robots (403/429/bot page) — id check only
--   unreachable  timeout / network error
--   malformed    the URL itself is invalid (spaces, no product id…)
--   id_mismatch  the id in the URL is not the PIM's id for this product
--   missing      no link although the PIM knows the product is listed there
--   no_section   the product page has no WHERE TO BUY section at all

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
-- then HTTP probes every 5 minutes — each call checks one paced batch and
-- returns at once when nothing is pending. <CRON_SECRET> = the function
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
  'where-to-buy-check-5min',
  '*/5 * * * *',
  $$select net.http_post(
    url := 'https://vcmizxflfjcpxeccezlc.supabase.co/functions/v1/where-to-buy-audit',
    headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
    body := '{"mode":"check"}'::jsonb,
    timeout_milliseconds := 10000
  )$$
);
