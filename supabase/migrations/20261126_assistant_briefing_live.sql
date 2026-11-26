-- The Dashboard's "This week" card is kept up to date all day (user,
-- 2026-11-26: "Todo ese panel debe actualizarse al día, en vivo pues" — its
-- "Broken links" tile still showed Monday's 283 on Thursday, with 222 broken
-- that day).
--
-- The card shows app_settings 'assistant_briefing', which the `assistant`
-- function's mode "briefing" builds straight from the data (stock, sales,
-- promotions, broken Where to Buy links, what waits for Odoo — no model). Until
-- now the job `assistant-briefing` asked for it on Monday at 7 AM Eastern only
-- (`0 11,12 * * 1`, body { mode: "briefing", cron: true } — `cron` makes the
-- function skip any hour but 7 AM Eastern).
--
-- From now on: every 5 minutes, three minutes after the stock is read
-- (inventory-pull-hourly, */5), without `cron`, so every call builds it. A
-- build is a handful of small reads and one write.
--
-- The job's command carries the cron's secret, so it is never written out
-- here: the same command is kept and only its body is replaced.
do $$
declare
  job record;
  next_command text;
begin
  select jobid, command into job from cron.job where jobname = 'assistant-briefing';
  if job.jobid is null then raise exception 'the job assistant-briefing does not exist'; end if;
  next_command := regexp_replace(job.command, $r$body\s*:=\s*'[^']*'::jsonb$r$, $b$body := '{"mode":"briefing"}'::jsonb$b$);
  if next_command !~ '"mode":"briefing"' or next_command ~ '"cron"' then
    raise exception 'the job''s command was not as expected: nothing changed';
  end if;
  perform cron.alter_job(job_id := job.jobid, schedule := '3-59/5 * * * *', command := next_command);
end $$;
