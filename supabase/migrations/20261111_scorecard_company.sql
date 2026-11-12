-- EOS ScoreCard · the Company tab (user, 2026-11-11: "una tab nueva que solo
-- vería Yenny, Pedro y Vladimir … un total / top view de toda la empresa").
--
-- The tab adds up what the marketplace tabs already hold (MAP %, sales,
-- on-time shipping: scorecard_values of the rows with those auto_keys), so it
-- stores almost nothing of its own. What it does store lives here, readable
-- and writable ONLY by the tab's viewers:
--   · the weekly sales target per country (typed by a viewer), and
--   · the inventory available per country, a snapshot the database takes
--     every hour into the column of the week in progress (a stock has no
--     history to read back: the weeks before this table started are empty).
--
-- Who sees the tab: app_settings 'scorecard_company_viewers' { emails: [...] }
-- (admins edit it; the app hides the tab from everyone else, and the policies
-- below refuse the rows to them). The marketplace tabs stay open to everyone.

insert into public.app_settings (key, value, updated_at)
values ('scorecard_company_viewers', '{"emails": ["jenny@stylishkb.com", "pedro@stylishkb.com", "vlad@stylishkb.com", "jose@stylishkb.com"]}'::jsonb, now())
on conflict (key) do nothing;

create or replace function public.scorecard_company_viewer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_settings s
    where s.key = 'scorecard_company_viewers'
      and (s.value -> 'emails') ? lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create table if not exists public.scorecard_company_values (
  key         text not null,              -- 'sales_target:ca', 'inv_units:us', 'inv_in_stock:ca' …
  week_start  date not null,              -- the column's Sunday, as in scorecard_values
  value       numeric,
  origin      text not null default 'manual' check (origin in ('manual', 'auto')),
  updated_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  primary key (key, week_start)
);

comment on table public.scorecard_company_values is
  'EOS ScoreCard Company tab: the numbers it keeps itself (sales targets, hourly inventory snapshot). Only its viewers read or write it.';

alter table public.scorecard_company_values enable row level security;

drop policy if exists scorecard_company_values_select on public.scorecard_company_values;
drop policy if exists scorecard_company_values_insert on public.scorecard_company_values;
drop policy if exists scorecard_company_values_update on public.scorecard_company_values;
drop policy if exists scorecard_company_values_delete on public.scorecard_company_values;
create policy scorecard_company_values_select on public.scorecard_company_values
  for select to authenticated using (public.scorecard_company_viewer());
-- A person types targets; the snapshot's rows ('auto') are the database's.
create policy scorecard_company_values_insert on public.scorecard_company_values
  for insert to authenticated with check (public.scorecard_company_viewer() and origin = 'manual');
create policy scorecard_company_values_update on public.scorecard_company_values
  for update to authenticated
  using (public.scorecard_company_viewer() and origin = 'manual')
  with check (public.scorecard_company_viewer() and origin = 'manual');
create policy scorecard_company_values_delete on public.scorecard_company_values
  for delete to authenticated using (public.scorecard_company_viewer() and origin = 'manual');

-- The inventory available per country, now, into the column of the week in
-- progress (next Sunday, Eastern time — the scorecard's own running column).
-- When the week closes the column keeps its last snapshot.
--   inv_units:<market>     units available for use (product_inventory.available)
--   inv_in_stock:<market>  share of the tracked products with stock (0–1)
create or replace function public.scorecard_company_snapshot()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'America/Toronto')::date;
  col   date := today - extract(dow from today)::int + 7;
begin
  insert into public.scorecard_company_values (key, week_start, value, origin, updated_by, updated_at)
  select s.key, col, s.value, 'auto', null, now()
  from (
    select 'inv_units:' || market as key, sum(available)::numeric as value
      from public.product_inventory group by market
    union all
    select 'inv_in_stock:' || market, (count(*) filter (where available > 0))::numeric / nullif(count(*), 0)
      from public.product_inventory group by market
  ) s
  on conflict (key, week_start) do update set value = excluded.value, origin = 'auto', updated_by = null, updated_at = now();
end $$;

select cron.unschedule('scorecard-company-snapshot') where exists (select 1 from cron.job where jobname = 'scorecard-company-snapshot');
-- :30, after the hourly stock pull (:20).
select cron.schedule('scorecard-company-snapshot', '30 * * * *', $$select public.scorecard_company_snapshot()$$);
select public.scorecard_company_snapshot();
