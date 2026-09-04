-- Time on screen per user per day (Analytics → Team). The app pings once a
-- minute while the tab is visible AND the person interacted in the last two
-- minutes; each accepted ping adds one minute. Idle tabs add nothing.
-- Own rows only for writes; everyone signed in can read (the report shows
-- the whole team).

create table if not exists public.screen_time (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  minutes integer not null default 0,
  last_ping timestamptz,
  primary key (user_id, day)
);
create index if not exists screen_time_day_idx on public.screen_time (day desc);

alter table public.screen_time enable row level security;
create policy screen_time_select on public.screen_time
  for select to authenticated using (true);

-- One call per minute from the client; ignores pings closer than 50 s apart
-- so a double-mounted app or a reload never counts a minute twice.
create or replace function public.ping_screen_time()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'America/Toronto')::date;
  prev timestamptz;
  total integer;
begin
  if uid is null then return null; end if;
  select last_ping into prev from public.screen_time where user_id = uid and day = today;
  if prev is not null and now() - prev < interval '50 seconds' then
    select minutes into total from public.screen_time where user_id = uid and day = today;
    return total;
  end if;
  insert into public.screen_time (user_id, day, minutes, last_ping)
       values (uid, today, 1, now())
  on conflict (user_id, day) do update
       set minutes = public.screen_time.minutes + 1, last_ping = now()
  returning minutes into total;
  return total;
end;
$$;
grant execute on function public.ping_screen_time() to authenticated;
