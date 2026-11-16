-- EOS ScoreCard · a tab that only some people see (user, 2026-11-16: "Debemos
-- crear ahora el EOS para Operations, por los momentos hazlo solo visible
-- para mí").
--
-- A department's tab keeps its measurables in the same two tables as the
-- marketplace tabs (scorecard_metrics.board = 'operations', scorecard_values).
-- Until now every signed-in person read every row of them. Now a board can be
-- restricted: app_settings 'scorecard_restricted_boards' holds, per board, the
-- emails that see it —
--     { "operations": ["jose@stylishkb.com"] }
-- A board that is not in it is open to everyone, as before; taking a board
-- out of it opens it. The app hides a restricted tab from everyone else, and
-- the policies below refuse them its rows: read, write, add or remove.

insert into public.app_settings (key, value, updated_at)
values ('scorecard_restricted_boards', '{"operations": ["jose@stylishkb.com"]}'::jsonb, now())
on conflict (key) do nothing;

-- The boards the caller may NOT see. One read of the setting per statement
-- (the policies call it as an InitPlan — the cast makes ALL take the array,
-- not the subquery's rows), then a plain comparison per row.
create or replace function public.scorecard_hidden_boards()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(e.key), '{}'::text[])
  from public.app_settings s
  cross join lateral jsonb_each(case when jsonb_typeof(s.value) = 'object' then s.value else '{}'::jsonb end) e
  where s.key = 'scorecard_restricted_boards'
    -- a list that is not a list hides the board from everyone
    and not (jsonb_typeof(e.value) = 'array' and e.value ? lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

drop policy if exists scorecard_metrics_select on public.scorecard_metrics;
drop policy if exists scorecard_metrics_insert on public.scorecard_metrics;
drop policy if exists scorecard_metrics_update on public.scorecard_metrics;
drop policy if exists scorecard_metrics_delete on public.scorecard_metrics;
create policy scorecard_metrics_select on public.scorecard_metrics
  for select to authenticated
  using (board <> all ((select public.scorecard_hidden_boards())::text[]));
create policy scorecard_metrics_insert on public.scorecard_metrics
  for insert to authenticated
  with check (public.app_is_admin() and board <> all ((select public.scorecard_hidden_boards())::text[]));
create policy scorecard_metrics_update on public.scorecard_metrics
  for update to authenticated
  using (public.app_is_admin() and board <> all ((select public.scorecard_hidden_boards())::text[]))
  with check (public.app_is_admin() and board <> all ((select public.scorecard_hidden_boards())::text[]));
create policy scorecard_metrics_delete on public.scorecard_metrics
  for delete to authenticated
  using (public.app_is_admin() and board <> all ((select public.scorecard_hidden_boards())::text[]));

-- A value is read by whoever may read its measurable (the policy above
-- applies to this look at scorecard_metrics too).
drop policy if exists scorecard_values_select on public.scorecard_values;
create policy scorecard_values_select on public.scorecard_values
  for select to authenticated
  using (exists (select 1 from public.scorecard_metrics m where m.id = scorecard_values.metric_id));

-- Writing a value: the same rules as before (20261104_scorecard_pim_rows_locked.sql),
-- and never on a board the caller does not see. These two run as their owner,
-- so they say it themselves.
create or replace function public.scorecard_can_write(p_metric uuid, p_origin text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.scorecard_metrics m
    where m.id = p_metric
      and m.board <> all (public.scorecard_hidden_boards())
      and case
            when m.auto_key is not null then p_origin = 'auto' and public.app_can_edit()
            else p_origin <> 'auto' and (public.app_is_admin() or m.owner_id = auth.uid())
          end
  );
$$;

create or replace function public.scorecard_can_replace(p_metric uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.scorecard_metrics m
    where m.id = p_metric
      and m.board <> all (public.scorecard_hidden_boards())
      and case
            when m.auto_key is not null then public.app_can_edit()
            else public.app_is_admin() or m.owner_id = auth.uid()
          end
  );
$$;
