-- channel_health performance (performance pass 2026-09-29).
--
-- Every reader takes the LATEST snapshot of a channel ("where channel = …
-- order by run_at desc limit 1") — or the latest listing-health summary per
-- marketplace — but the table had no index for it and was never pruned
-- (1,827 rows, 29 MB, each `results` 60–220 kB).

-- 1. The index every "latest snapshot" query needs.
create index if not exists channel_health_channel_run_at_idx
  on public.channel_health (channel, run_at desc);

-- 2. One SKU's item from a channel's latest snapshot, so a product page no
--    longer downloads the whole per-SKU list to find itself. Runs with the
--    caller's rights (channel_health is readable by any signed-in user).
create or replace function public.channel_health_item(p_channel text, p_sku text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select e
  from (
    select results from channel_health
    where channel = p_channel
    order by run_at desc
    limit 1
  ) s,
  jsonb_array_elements(case when jsonb_typeof(s.results) = 'array' then s.results else '[]'::jsonb end) e
  where e ->> 'sku' = p_sku
  limit 1;
$$;

grant execute on function public.channel_health_item(text, text) to authenticated;

-- 3. Retention: nothing reads history (trends live in kpi_snapshots), so
--    snapshots older than 30 days go — except the latest one per channel and
--    target, which always stays. Runs daily from pg_cron.
create or replace function public.channel_health_prune()
returns integer
language sql
security definer
set search_path = public
as $$
  with keep as (
    select distinct on (channel, coalesce(target, '')) id
    from channel_health
    order by channel, coalesce(target, ''), run_at desc
  ), gone as (
    delete from channel_health
    where run_at < now() - interval '30 days'
      and id not in (select id from keep)
    returning 1
  )
  select count(*)::int from gone;
$$;

revoke all on function public.channel_health_prune() from public;

select cron.unschedule('channel-health-prune-daily')
where exists (select 1 from cron.job where jobname = 'channel-health-prune-daily');
select cron.schedule('channel-health-prune-daily', '35 9 * * *', 'select public.channel_health_prune()');
