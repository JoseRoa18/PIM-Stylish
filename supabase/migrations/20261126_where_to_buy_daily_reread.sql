-- The Where to Buy links that need attention are read every day (user,
-- 2026-11-26: "se haría todos los días solo de aquellos que salgan Out of
-- Stock y que sí tengamos stock … y de los que salgan broken o other finish o
-- wrong link, de los OK solo se seguiría haciendo como hasta ahora" — "Hazlo").
--
-- The job asks where-to-buy-audit for its mode "daily-reread" at 05:00 and
-- 06:00 UTC every day; the function runs the call that falls at 1 AM Eastern
-- (EDT or EST) and makes those links due on the days that are not a pass day
-- of their store. The usual check batches (where-to-buy-check-hourly, every
-- 10 minutes) then open them.
--
-- The command carries the cron's secret, so it is never written out here: the
-- problems' re-read job's own command is copied with another body.
do $$
declare
  source_command text;
  next_command text;
begin
  select command into source_command from cron.job where jobname = 'where-to-buy-problem-reread';
  if source_command is null then raise exception 'the job where-to-buy-problem-reread does not exist'; end if;
  next_command := regexp_replace(source_command, $r$body\s*:=\s*'[^']*'::jsonb$r$, $b$body := '{"mode":"daily-reread"}'::jsonb$b$);
  if next_command !~ '"mode":"daily-reread"' or next_command ~ 'problem-reread' then
    raise exception 'the job''s command was not as expected: nothing created';
  end if;
  perform cron.schedule('where-to-buy-daily-reread', '0 5,6 * * *', next_command);
end $$;
