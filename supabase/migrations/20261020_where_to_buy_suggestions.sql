-- Suggested Where to Buy links (user, 2026-10-20: "1 hazlo" — the right link
-- when a link opens another option or product; "2 hazlo" — links to add from
-- the ids the PIM already keeps). The where-to-buy-audit function (mode
-- "suggest", hourly) finds them and OPENS each one before it is shown: only a
-- page that shows the product's own SKU (or its own store id) becomes
-- "ready". Nothing changes on the websites until someone presses "Use" on the
-- product's Where to Buy tab or in Listing Health → Where to Buy.
--
-- Where a suggestion comes from (`source`):
--   other_link  another product's link at the same store opens this product's
--               page (KB Authority's links are shifted: B-108G's opens B-122G)
--   page_option the page of a link lists this product as one of its options,
--               with its own address (KB Authority / Shopify / Walmart / Best
--               Buy / Menards by model, Home Depot Canada and Amazon by item
--               id, BB&B / Overstock by sub-SKU, Wayfair by finish name)
--   store_id    an id the PIM keeps: Best Buy's product id (the offers API),
--               the "BB&B / Overstock" alias
-- `reason`: wrong_link (the link opens another option / product),
-- broken_link (it does not open), missing (no link to that store yet).

alter table public.where_to_buy_links
  -- The other options the page lists, each with its own address
  -- ([{ model, name, subSku, itemId, gtin, url }], _shared/pageProduct.js).
  add column if not exists page_options jsonb;

create table if not exists public.where_to_buy_suggestions (
  id uuid primary key default gen_random_uuid(),
  sku text not null references public.products(sku) on delete cascade on update cascade,
  retailer text not null,                 -- the audit's keys (wayfair_ca, kbauthority…)
  url text not null,
  found_url text,                         -- the address as first found (the url can move to the option's or the store's own address)
  reason text not null check (reason in ('wrong_link', 'broken_link', 'missing')),
  source text not null check (source in ('other_link', 'page_option', 'store_id')),
  detail text,                            -- how it was found, in words
  current_url text,                       -- the link it would replace (none for a link to add)
  status text not null default 'to_check' check (status in ('to_check', 'ready', 'failed', 'applied', 'dismissed')),
  status_note text,                       -- why it failed / what the opened page showed
  hops integer not null default 0,        -- a page that lists the product as an option: its option's address is tried once
  attempts integer not null default 0,    -- opens without an answer
  page_model text, price numeric(12, 2), currency text, in_stock boolean,
  checked_at timestamptz,
  next_check_at timestamptz,
  decided_at timestamptz,
  decided_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sku, retailer, url)
);

create index if not exists where_to_buy_suggestions_status_idx on public.where_to_buy_suggestions (status, next_check_at);
create index if not exists where_to_buy_suggestions_sku_idx on public.where_to_buy_suggestions (sku);

alter table public.where_to_buy_suggestions enable row level security;
drop policy if exists where_to_buy_suggestions_select on public.where_to_buy_suggestions;
create policy where_to_buy_suggestions_select on public.where_to_buy_suggestions for select to authenticated using (true);
-- "Use" and "Dismiss" are updates from the app (editors and admins); the
-- audit writes with the service role.
drop policy if exists where_to_buy_suggestions_update on public.where_to_buy_suggestions;
create policy where_to_buy_suggestions_update on public.where_to_buy_suggestions for update to authenticated using (public.app_can_edit()) with check (public.app_can_edit());

-- Every 10 minutes, 5 minutes after the check job: open the suggestions not
-- verified yet (the candidates themselves are looked for once an hour). The
-- command is the check job's own — its headers carry the cron secret — with
-- the suggest body. APPLIED 2026-10-20.
select cron.schedule(
  'where-to-buy-suggest',
  '5,15,25,35,45,55 * * * *',
  (select replace(replace(command, '{"mode":"check","chain":0}', '{"mode":"suggest"}'), 'timeout_milliseconds := 10000', 'timeout_milliseconds := 60000')
     from cron.job where jobname = 'where-to-buy-check-hourly')
);
