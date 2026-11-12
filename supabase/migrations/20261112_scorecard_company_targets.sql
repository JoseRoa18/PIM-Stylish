-- EOS ScoreCard · the Company tab's own targets (user, 2026-11-12: "necesito
-- también que permita hacer cambios para los goal").
--
-- A row of the Company tab that IS a marketplace tab's row (each marketplace's
-- weekly sales) carries that row's own target, scorecard_metrics.goal /
-- goal_op — one target per number, changed on either tab. The rows the tab
-- works out itself (the MAP and on-time averages, total vs target, the
-- inventory) have no row to keep one in: theirs live here, keyed by the
-- row's id on the tab ('map:all', 'on_time:ca', 'sales_vs_target:ca',
-- 'inv_units:ca' …). A country's total sales keep none: its target is its
-- marketplaces' targets added up.
--
-- Read and written ONLY by the tab's viewers, like scorecard_company_values.
-- The columns keep the names scorecard_metrics uses (the page says "Target").

create table if not exists public.scorecard_company_targets (
  key         text primary key,
  goal        numeric not null,
  goal_op     text not null check (goal_op in ('>=', '>', '<=', '<')),
  updated_at  timestamptz not null default now()
);

comment on table public.scorecard_company_targets is
  'EOS ScoreCard Company tab: the targets of the rows the tab works out itself. Only its viewers read or write it.';

alter table public.scorecard_company_targets enable row level security;

drop policy if exists scorecard_company_targets_select on public.scorecard_company_targets;
drop policy if exists scorecard_company_targets_insert on public.scorecard_company_targets;
drop policy if exists scorecard_company_targets_update on public.scorecard_company_targets;
drop policy if exists scorecard_company_targets_delete on public.scorecard_company_targets;
create policy scorecard_company_targets_select on public.scorecard_company_targets
  for select to authenticated using (public.scorecard_company_viewer());
create policy scorecard_company_targets_insert on public.scorecard_company_targets
  for insert to authenticated with check (public.scorecard_company_viewer());
create policy scorecard_company_targets_update on public.scorecard_company_targets
  for update to authenticated
  using (public.scorecard_company_viewer())
  with check (public.scorecard_company_viewer());
create policy scorecard_company_targets_delete on public.scorecard_company_targets
  for delete to authenticated using (public.scorecard_company_viewer());
