-- Where to Buy audit through web unlockers (user decision, 2026-10-19).
-- The retailers that block the server's own probe (Wayfair, Home Depot,
-- Best Buy, Lowe's, Rona, Menards, BB&B, Overstock…) are now opened through
-- Bright Data's Web Unlocker (primary) and ScraperAPI (backup), so every link
-- ends as OK or Broken. Faucetline and the Loblaw sites defeat both and are
-- marked 'manual' (checked by hand). 'missing' rows stay, but the panel shows
-- them as a KPI of links to add, apart from the OK / Broken list.
--
-- Schedule (user): an OK link is re-checked every 2 days, a broken one daily,
-- a link without an answer every few hours. `next_check_at` carries that.
--
-- Two-strike rule for soft evidence: a link is marked Broken at once on a
-- 404 / 410 or a "not found" page, but when the only evidence is weaker
-- (Menards' unlocker gives up — Menards sends a dead product to its error
-- page, which the unlocker takes for a block — or the page opens without the
-- product) it needs two such answers on different days (`signal_count`).
--
-- verdict now: ok | broken | missing | pending | manual.

alter table public.where_to_buy_links
  add column if not exists next_check_at timestamptz,
  add column if not exists checked_via text,        -- direct | brightdata | scraperapi | price2spy
  add column if not exists fail_count int not null default 0,    -- checks in a row with no answer
  add column if not exists signal_count int not null default 0,  -- soft "broken" answers in a row
  add column if not exists job_id text,             -- Bright Data async job in flight (Menards)
  add column if not exists job_at timestamptz;

-- Backfill: HTTP verdicts keep their rhythm, pending links are due now,
-- scan-time verdicts (invalid address, cut Wayfair link) are never probed.
update public.where_to_buy_links set next_check_at = case
    when url is null then null
    when verdict = 'ok' then coalesce(checked_at, now()) + interval '2 days'
    when verdict = 'broken' and (http_status is not null or checked_at is not null) then coalesce(checked_at, now()) + interval '20 hours'
    when verdict = 'broken' then '2999-01-01'::timestamptz
    else null
  end,
  checked_via = case when verdict in ('ok', 'broken') and checked_at is not null
    then case when note like 'Price2Spy%' then 'price2spy' else 'direct' end end;

create index if not exists where_to_buy_links_due_idx on public.where_to_buy_links (next_check_at nulls first) where url is not null;
