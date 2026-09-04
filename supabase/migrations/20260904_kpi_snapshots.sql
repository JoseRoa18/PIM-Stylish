-- Weekly KPI progress needs HISTORY: the PIM completeness tab is live and
-- remembers nothing. kpi_snapshots stores one row per day per metric scope so
-- the Analytics page can compare this week with last week (and draw trends).
--
-- scope / key:
--   'pim'          / 'all'            catalog totals + missing counts per check
--   'pim_category' / <category>       the same per product category
--   'channel'      / <marketplace>    listing-health coverage per channel
-- Written by the health-refresh cron (twice a day, upsert = last one wins)
-- and by "Take snapshot" on the Analytics page. Never a source of truth:
-- everything in it can be recomputed from the PIM.

create table if not exists public.kpi_snapshots (
  snapshot_date date not null,
  scope text not null,
  key text not null,
  metrics jsonb not null default '{}'::jsonb,
  taken_at timestamptz not null default now(),
  primary key (snapshot_date, scope, key)
);
create index if not exists kpi_snapshots_scope_key_date_idx
  on public.kpi_snapshots (scope, key, snapshot_date desc);

alter table public.kpi_snapshots enable row level security;

create policy kpi_snapshots_select on public.kpi_snapshots
  for select to authenticated using (true);
create policy kpi_snapshots_insert on public.kpi_snapshots
  for insert to authenticated with check (public.app_can_edit());
create policy kpi_snapshots_update on public.kpi_snapshots
  for update to authenticated using (public.app_can_edit()) with check (public.app_can_edit());
create policy kpi_snapshots_delete on public.kpi_snapshots
  for delete to authenticated using (public.app_is_admin());
