-- EOS ScoreCard (user, 2026-11-03): the weekly measurables of each
-- marketplace, as the company keeps them in "2026 Company ScoreCard.xlsx"
-- (one sheet per marketplace). One row per measurable (owner, goal, source),
-- one value per measurable and week. Weeks run Sunday to Saturday (user's
-- choice) and are stored by their Sunday.
--
-- Who writes (user, same day): every signed-in person reads; the measurable's
-- OWNER types its numbers; admins edit everything (rows, goals, any value).
-- Rows the PIM measures itself carry an auto_key; any editor's session may
-- write their value with origin 'auto', but never over a typed one.

create table if not exists public.scorecard_metrics (
  id uuid primary key default gen_random_uuid(),
  board text not null,                       -- the marketplace tab: amazon, wayfair, homedepot_ca, …
  market text check (market in ('ca', 'us')),
  name text not null,
  source text,                               -- where the number comes from (Portal, Asana, Odoo, PIM…)
  owner_id uuid references public.profiles(id) on delete set null,
  owner_name text,                           -- an owner without a PIM user
  unit text not null default 'number'
    check (unit in ('number', 'percent', 'money', 'hours', 'days', 'text')),
  goal numeric,
  goal_op text check (goal_op in ('>', '>=', '<', '<=')),
  auto_key text,                             -- filled by the PIM (see src/features/scorecard/lib/autoMetrics.js)
  position integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists scorecard_metrics_board_idx on public.scorecard_metrics (board, position);

create table if not exists public.scorecard_values (
  metric_id uuid not null references public.scorecard_metrics(id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 7), -- a Sunday
  value numeric,
  note text,                                 -- what was typed when it is not only a number
  origin text not null default 'manual' check (origin in ('manual', 'auto', 'import')),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (metric_id, week_start)
);
create index if not exists scorecard_values_week_idx on public.scorecard_values (week_start);

create or replace function public.scorecard_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if tg_table_name = 'scorecard_values' then
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  end if;
  return new;
end;
$$;

drop trigger if exists scorecard_metrics_touch on public.scorecard_metrics;
create trigger scorecard_metrics_touch before update on public.scorecard_metrics
  for each row execute function public.scorecard_touch();
drop trigger if exists scorecard_values_touch on public.scorecard_values;
create trigger scorecard_values_touch before insert or update on public.scorecard_values
  for each row execute function public.scorecard_touch();

-- May the caller write this measurable's value with this origin?
create or replace function public.scorecard_can_write(p_metric uuid, p_origin text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.app_is_admin()
      or exists (
        select 1 from public.scorecard_metrics m
        where m.id = p_metric
          and (m.owner_id = auth.uid()
               or (p_origin = 'auto' and m.auto_key is not null and public.app_can_edit()))
      );
$$;

alter table public.scorecard_metrics enable row level security;
alter table public.scorecard_values enable row level security;

drop policy if exists scorecard_metrics_select on public.scorecard_metrics;
drop policy if exists scorecard_metrics_insert on public.scorecard_metrics;
drop policy if exists scorecard_metrics_update on public.scorecard_metrics;
drop policy if exists scorecard_metrics_delete on public.scorecard_metrics;
create policy scorecard_metrics_select on public.scorecard_metrics
  for select to authenticated using (true);
create policy scorecard_metrics_insert on public.scorecard_metrics
  for insert to authenticated with check (public.app_is_admin());
create policy scorecard_metrics_update on public.scorecard_metrics
  for update to authenticated using (public.app_is_admin()) with check (public.app_is_admin());
create policy scorecard_metrics_delete on public.scorecard_metrics
  for delete to authenticated using (public.app_is_admin());

drop policy if exists scorecard_values_select on public.scorecard_values;
drop policy if exists scorecard_values_insert on public.scorecard_values;
drop policy if exists scorecard_values_update on public.scorecard_values;
drop policy if exists scorecard_values_delete on public.scorecard_values;
create policy scorecard_values_select on public.scorecard_values
  for select to authenticated using (true);
create policy scorecard_values_insert on public.scorecard_values
  for insert to authenticated with check (public.scorecard_can_write(metric_id, origin));
-- USING sees the stored row: an 'auto' writer can replace an auto value,
-- never a typed one (its stored origin is 'manual' / 'import').
create policy scorecard_values_update on public.scorecard_values
  for update to authenticated
  using (public.scorecard_can_write(metric_id, origin))
  with check (public.scorecard_can_write(metric_id, origin));
create policy scorecard_values_delete on public.scorecard_values
  for delete to authenticated using (public.scorecard_can_write(metric_id, 'manual'));
