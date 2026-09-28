-- File tasks of a promotion on the marketplaces that work from a file
-- downloaded from their portal (Wayfair Canada / USA since 2026-09-28): the
-- promotions file when the promotion starts and the price change file (prices
-- back to Blue) when a flash deal or special event ends. One entry per
-- "<channel>:<task>" — { at, by, name, manual, rows } — written when the PIM
-- fills the file, or by hand ("already done"). The owner's reminder
-- (PromoTaskNudge) and the promotion card read it; owners per channel live in
-- app_settings.promo_channel_owners.

alter table public.promotions
  add column if not exists file_tasks jsonb not null default '{}'::jsonb;

comment on column public.promotions.file_tasks is
  'Done file tasks per "<channel>:<task>" (promo_file, price_change): { at, by, name, manual, rows }. See PromoTaskNudge.';

-- Merge one task in without clobbering the others (two people finishing two
-- tasks at once). Runs as the caller: promotions RLS (app_can_edit) applies.
create or replace function public.promotion_mark_task(pid bigint, task text, info jsonb)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  update public.promotions
     set file_tasks = coalesce(file_tasks, '{}'::jsonb) || jsonb_build_object(task, info)
   where id = pid
  returning file_tasks;
$$;

grant execute on function public.promotion_mark_task(bigint, text, jsonb) to authenticated;
