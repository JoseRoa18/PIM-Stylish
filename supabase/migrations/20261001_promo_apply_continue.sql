-- promo-apply chains its Wix continuation runs through Postgres (pg_net).
-- Supabase refuses an edge function calling itself again within the same
-- trace ("Rate limit exceeded for trace …, Retry after 7749ms"): on the
-- Oct 1 2026 launch the chain stopped after two runs with 249 Wix changes
-- left. A request queued by pg_net starts a new trace. It carries the nightly
-- job's own headers, so the cron secret never leaves the database.

create or replace function public.promo_apply_continue(p_chain integer, p_reconcile boolean default false)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  cmd text;
  hdrs jsonb;
  rid bigint;
begin
  select command into cmd from cron.job where jobname = 'promo-apply-daily-edt';
  if cmd is null then
    raise exception 'promo-apply cron job not found';
  end if;
  hdrs := (regexp_match(cmd, 'headers\s*:=\s*''([^'']+)''::jsonb'))[1]::jsonb;
  if hdrs is null then
    raise exception 'promo-apply cron headers not found';
  end if;
  select net.http_post(
    url := 'https://vcmizxflfjcpxeccezlc.supabase.co/functions/v1/promo-apply',
    headers := hdrs,
    body := jsonb_build_object('chain', p_chain, 'reconcile', p_reconcile),
    timeout_milliseconds := 10000
  ) into rid;
  return rid;
end
$$;

revoke all on function public.promo_apply_continue(integer, boolean) from public, anon, authenticated;
grant execute on function public.promo_apply_continue(integer, boolean) to service_role;
