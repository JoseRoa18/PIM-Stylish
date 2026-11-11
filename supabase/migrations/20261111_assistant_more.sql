-- The assistant, second round (user, 2026-11-11: "Haz todo eso!" to the list
-- of improvements): a thumb on each answer, changes it PROPOSES and the
-- person confirms, the page it was asked from, attached files, a usage panel
-- for admins, a keep-alive while it is in use and the weekly briefing.
--
-- The rule of 20261111_assistant.sql stands: the assistant itself writes
-- nothing to a product. A change it proposes is a row here; the person
-- confirms it on the page, and the page makes it through the app's own save
-- (same checks, same Activity Log), with that person's permissions.

-- ── What each question carried, and what the person thought of the answer ──
alter table public.assistant_turns
  add column if not exists rating smallint check (rating in (-1, 1)),
  add column if not exists rating_note text,
  add column if not exists page text,
  add column if not exists attachments jsonb,
  add column if not exists audience text;

-- ── Changes the assistant proposed ─────────────────────────────────────────
--   kind      set_obsolete | set_prices
--   payload   what would change, with the values before (drawn on the card)
--   status    proposed → done | cancelled | failed   (decided by the person)
--   reported  the model has been told the outcome (with the next question)
create table if not exists public.assistant_actions (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.assistant_chats (id) on delete cascade,
  turn_id bigint references public.assistant_turns (id) on delete set null,
  user_id uuid not null,
  kind text not null,
  summary text not null,
  payload jsonb not null,
  status text not null default 'proposed' check (status in ('proposed', 'done', 'cancelled', 'failed')),
  result text,
  reported boolean not null default false,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists assistant_actions_chat_idx on public.assistant_actions (chat_id, created_at);

alter table public.assistant_actions enable row level security;
drop policy if exists "assistant_actions: own or admin" on public.assistant_actions;
create policy "assistant_actions: own or admin" on public.assistant_actions
  for select to authenticated using (user_id = auth.uid() or public.app_is_admin());
revoke all on public.assistant_actions from anon, authenticated;
grant select on public.assistant_actions to authenticated;

-- The person who was asked decides, once. (The change itself is made by the
-- page before this is called with 'done'.)
create or replace function public.assistant_decide_action(p_action uuid, p_status text, p_result text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('done', 'cancelled', 'failed') then
    raise exception 'A proposed change ends as done, cancelled or failed.';
  end if;
  update assistant_actions
     set status = p_status, result = left(p_result, 2000), decided_at = now()
   where id = p_action and user_id = auth.uid() and status = 'proposed';
  if not found then
    raise exception 'That proposed change was not found, or it was already decided.';
  end if;
end $$;
revoke all on function public.assistant_decide_action(uuid, text, text) from public, anon;
grant execute on function public.assistant_decide_action(uuid, text, text) to authenticated;

-- A thumb up (1), a thumb down (-1) or none (0) on one's own answer.
create or replace function public.assistant_rate_turn(p_turn bigint, p_rating integer, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_rating not in (-1, 0, 1) then
    raise exception 'A rating is 1, -1 or 0 (none).';
  end if;
  update assistant_turns
     set rating = nullif(p_rating, 0), rating_note = case when p_rating = 0 then null else left(p_note, 1000) end
   where id = p_turn and user_id = auth.uid();
  if not found then
    raise exception 'That answer was not found.';
  end if;
end $$;
revoke all on function public.assistant_rate_turn(bigint, integer, text) from public, anon;
grant execute on function public.assistant_rate_turn(bigint, integer, text) to authenticated;

-- What the assistant was asked and what it cost (Settings → Assistant). Admins only.
create or replace function public.assistant_usage(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
  out jsonb;
begin
  if not public.app_is_admin() then
    raise exception 'Only admins see the assistant''s usage.';
  end if;
  select jsonb_build_object(
    'days', greatest(1, least(coalesce(p_days, 30), 365)),
    'last_24h_usd', (select coalesce(sum(cost_usd), 0) from assistant_turns where created_at >= now() - interval '24 hours'),
    'period_usd', (select coalesce(sum(cost_usd), 0) from assistant_turns where created_at >= since),
    'questions', (select count(*) from assistant_turns where created_at >= since),
    'thumbs_up', (select count(*) from assistant_turns where created_at >= since and rating = 1),
    'thumbs_down', (select count(*) from assistant_turns where created_at >= since and rating = -1),
    'by_person', coalesce((
      select jsonb_agg(p order by (p ->> 'usd')::numeric desc)
      from (
        select jsonb_build_object('email', user_email, 'questions', count(*), 'usd', sum(cost_usd), 'last', max(created_at)) as p
        from assistant_turns where created_at >= since group by user_email
      ) x), '[]'::jsonb),
    'by_day', coalesce((
      select jsonb_agg(d order by d ->> 'day' desc)
      from (
        select jsonb_build_object('day', (created_at at time zone 'America/Toronto')::date, 'questions', count(*), 'usd', sum(cost_usd)) as d
        from assistant_turns where created_at >= since group by (created_at at time zone 'America/Toronto')::date
      ) x), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(r order by (r ->> 'id')::bigint desc)
      from (
        select jsonb_build_object('id', id, 'at', created_at, 'email', user_email, 'question', left(question, 240),
          'usd', cost_usd, 'rating', rating, 'note', rating_note, 'error', error, 'seconds', round(duration_ms / 1000.0)) as r
        from assistant_turns order by id desc limit 30
      ) x), '[]'::jsonb),
    'knowledge', coalesce((select jsonb_object_agg(key, updated_at) from assistant_knowledge), '{}'::jsonb)
  ) into out;
  return out;
end $$;
revoke all on function public.assistant_usage(integer) from public, anon;
grant execute on function public.assistant_usage(integer) to authenticated;

-- ── Scheduled calls (the cron secret never leaves the database) ─────────────
-- assistant-warm: while someone has asked in the last hours, what the model is
--   always sent stays cached, so the next question is cheap and quick. The
--   function decides; an idle day costs nothing.
-- assistant-briefing: Monday 7 AM Eastern (11:00 and 12:00 UTC; the function
--   runs only the one that falls at 7).
select cron.unschedule('assistant-warm') where exists (select 1 from cron.job where jobname = 'assistant-warm');
select cron.schedule(
  'assistant-warm', '*/45 * * * *',
  replace(replace(replace(command,
    'functions/v1/inventory-pull', 'functions/v1/assistant'),
    $$body := '{}'::jsonb$$, $$body := '{"mode":"warm"}'::jsonb$$),
    'timeout_milliseconds := 30000', 'timeout_milliseconds := 60000'))
from cron.job where jobname = 'inventory-pull-hourly';

select cron.unschedule('assistant-briefing') where exists (select 1 from cron.job where jobname = 'assistant-briefing');
select cron.schedule(
  'assistant-briefing', '0 11,12 * * 1',
  replace(replace(replace(command,
    'functions/v1/inventory-pull', 'functions/v1/assistant'),
    $$body := '{}'::jsonb$$, $$body := '{"mode":"briefing","cron":true}'::jsonb$$),
    'timeout_milliseconds := 30000', 'timeout_milliseconds := 120000'))
from cron.job where jobname = 'inventory-pull-hourly';
