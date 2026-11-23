-- EOS ScoreCard: a measurable can repeat another tab's (user, 2026-11-23, about
-- the Operations tab's Amazon FBA inventory rows: "se debe traer ya del tab de
-- Amazon de cada país y colocarle el mismo nombre de la tab de Amazon"). The
-- number is typed once, on its marketplace's tab; the row that repeats it
-- names its source in `copy_of` and carries auto_key 'copy', so it is a PIM
-- row like any other: nobody types it, and it has no pencil.
--
-- The database copies each number the moment it is saved on the source row —
-- typed, changed or cleared — whoever saves it, also a person who cannot see
-- the tab the copy is on (the function runs as its owner).

alter table public.scorecard_metrics
  add column if not exists copy_of uuid references public.scorecard_metrics(id) on delete set null;
create index if not exists scorecard_metrics_copy_of on public.scorecard_metrics (copy_of) where copy_of is not null;

create or replace function public.scorecard_values_copy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.scorecard_values v
     using public.scorecard_metrics c
     where c.copy_of = old.metric_id and v.metric_id = c.id and v.week_start = old.week_start;
    return old;
  end if;
  insert into public.scorecard_values (metric_id, week_start, value, note, origin)
  select c.id, new.week_start, new.value, new.note, 'auto'
    from public.scorecard_metrics c
   where c.copy_of = new.metric_id and not c.archived
  on conflict (metric_id, week_start)
  do update set value = excluded.value, note = excluded.note, origin = 'auto';
  return new;
end;
$$;

drop trigger if exists scorecard_values_copy on public.scorecard_values;
create trigger scorecard_values_copy
  after insert or update or delete on public.scorecard_values
  for each row execute function public.scorecard_values_copy();
