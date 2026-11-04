-- EOS ScoreCard: the PIM's numbers can't be edited (user, 2026-11-04: "los
-- valores de PIM no pueden editarse"). A measurable with an auto_key is the
-- PIM's: its values are written only with origin 'auto' (any editor's
-- session works them out), by nobody by hand — admins included — and the PIM
-- replaces whatever this week holds. To type such a row by hand, an admin
-- first turns "Filled by the PIM" off (auto_key null); it is then an
-- ordinary row again (its owner and the admins write it).

-- May the caller store a value with this origin for the measurable?
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
      and case
            when m.auto_key is not null then p_origin = 'auto' and public.app_can_edit()
            else p_origin <> 'auto' and (public.app_is_admin() or m.owner_id = auth.uid())
          end
  );
$$;

-- May the caller replace or remove a value the measurable already has?
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
      and case
            when m.auto_key is not null then public.app_can_edit()
            else public.app_is_admin() or m.owner_id = auth.uid()
          end
  );
$$;

drop policy if exists scorecard_values_insert on public.scorecard_values;
drop policy if exists scorecard_values_update on public.scorecard_values;
drop policy if exists scorecard_values_delete on public.scorecard_values;
create policy scorecard_values_insert on public.scorecard_values
  for insert to authenticated with check (public.scorecard_can_write(metric_id, origin));
create policy scorecard_values_update on public.scorecard_values
  for update to authenticated
  using (public.scorecard_can_replace(metric_id))
  with check (public.scorecard_can_write(metric_id, origin));
-- A PIM row's values are never cleared by hand.
create policy scorecard_values_delete on public.scorecard_values
  for delete to authenticated
  using (public.scorecard_can_replace(metric_id) and exists (
    select 1 from public.scorecard_metrics m where m.id = metric_id and m.auto_key is null));
