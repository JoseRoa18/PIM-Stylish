-- EOS ScoreCard: what the PIM fills is locked for everyone (user, 2026-11-23:
-- "veo que hay cosas que llena PIM, entonces eso no puede ser editable por
-- NADIE, si PIM lo llena debe quedar bloqueado"). Two things were still open:
--   1. A number the PIM wrote on a measurable that people type today (the 48
--      rows that left ShipStation on 2026-11-17 keep the PIM's W44–W46) could
--      be replaced or cleared by an admin or by its owner.
--   2. An admin could edit a PIM measurable with the pencil: rename it, remove
--      it, or turn "Filled by the PIM" off and then type it by hand.
-- Now a value with origin 'auto' is replaced or removed only by the PIM, and a
-- measurable with an auto_key is changed by no person — but for its Target
-- (goal, goal_op) and its place in the list (position), which are people's.
-- The service role and the database's own jobs carry no user: scorecard-fill
-- and maintenance go on as before.

-- May the caller replace or remove this value of the measurable? `p_origin` is
-- the origin of the value as it is stored.
create or replace function public.scorecard_can_replace(p_metric uuid, p_origin text)
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
            -- a typed measurable: never a number the PIM wrote
            else coalesce(p_origin, '') <> 'auto' and (public.app_is_admin() or m.owner_id = auth.uid())
          end
  );
$$;

drop policy if exists scorecard_values_update on public.scorecard_values;
drop policy if exists scorecard_values_delete on public.scorecard_values;
create policy scorecard_values_update on public.scorecard_values
  for update to authenticated
  using (public.scorecard_can_replace(metric_id, origin))
  with check (public.scorecard_can_write(metric_id, origin));
-- A PIM row's values are never cleared by hand, nor is a PIM-written value of a typed row.
create policy scorecard_values_delete on public.scorecard_values
  for delete to authenticated
  using (public.scorecard_can_replace(metric_id, origin) and exists (
    select 1 from public.scorecard_metrics m where m.id = metric_id and m.auto_key is null));
drop function if exists public.scorecard_can_replace(uuid);

-- A measurable the PIM fills is edited by no person: not renamed, not removed,
-- not handed back to typing. Its Target and its position stay people's.
create or replace function public.scorecard_metrics_pim_locked()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then -- the service role, a cron, a migration: not a person
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.auto_key is not null then
      raise exception 'This measurable is filled by the PIM: it cannot be removed.' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.auto_key is not null
     and (to_jsonb(new) - array['goal', 'goal_op', 'position', 'updated_at'])
         is distinct from (to_jsonb(old) - array['goal', 'goal_op', 'position', 'updated_at']) then
    raise exception 'This measurable is filled by the PIM: only its target can be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists scorecard_metrics_pim_locked on public.scorecard_metrics;
create trigger scorecard_metrics_pim_locked
  before update or delete on public.scorecard_metrics
  for each row execute function public.scorecard_metrics_pim_locked();
