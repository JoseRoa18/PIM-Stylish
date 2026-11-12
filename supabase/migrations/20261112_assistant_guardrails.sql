-- Guardrails on the assistant (user, 2026-11-12: "Tenemos que agregar
-- validaciones al asistente, es peligroso que se puedan eliminar productos o
-- hacer solicitudes que puedan afectar a la veracidad de los datos o de las
-- conexiones").
--
-- The assistant itself only reads (its every request to the database goes
-- through a read-only gate, _shared/assistantTools.js). The one way a change
-- comes out of a conversation is a card the person confirms, and the page
-- then makes it through the app's own save. This migration is the database's
-- part of that confirmation: a card is CLAIMED before anything is changed.
--
--   assistant_claim_action(p_action) → { id, kind, summary, payload }
--     The page calls it when the person presses Confirm, BEFORE it changes
--     anything, and makes the change from what this returns (the payload the
--     database kept, not the page's copy). It answers once, and only when:
--       · the card is the caller's own and still open (proposed, not started);
--       · it is not older than 24 hours — what it was prepared from may no
--         longer hold (a promotion started, a price moved);
--       · the assistant is still on, the caller still on its list, and still
--         an admin or an editor;
--       · this kind of change is not turned off in Settings → Assistant
--         (app_settings 'assistant' → actions.<kind> = false).
--     Anything else raises, in words the card shows. A card claimed and never
--     decided (the page was closed mid-way) is not started again: the person
--     is told to check the product first.
--
-- assistant_decide_action() is unchanged: it records how the card ended.

alter table public.assistant_actions
  add column if not exists claimed_at timestamptz;

create or replace function public.assistant_claim_action(p_action uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.assistant_actions;
  setting jsonb;
  me text;
begin
  select * into a from assistant_actions where id = p_action and user_id = auth.uid() for update;
  if not found then
    raise exception 'That proposed change was not found.';
  end if;
  if a.status <> 'proposed' then
    raise exception 'This change was already decided.';
  end if;
  if a.claimed_at is not null then
    raise exception 'This change was already started and its outcome was not recorded. Check the product before asking for it again.';
  end if;
  if a.created_at < now() - interval '24 hours' then
    raise exception 'This card is more than a day old. Ask the assistant to prepare the change again.';
  end if;
  if not public.app_can_edit() then
    raise exception 'Your role only reads the PIM.';
  end if;

  select value into setting from app_settings where key = 'assistant';
  select lower(trim(email)) into me from profiles where id = auth.uid();
  if coalesce((setting ->> 'enabled')::boolean, false) is not true
     or me is null
     or not exists (select 1 from jsonb_array_elements_text(coalesce(setting -> 'emails', '[]'::jsonb)) e where lower(trim(e)) = me) then
    raise exception 'The assistant is not available for your account.';
  end if;
  if (setting -> 'actions' ->> a.kind) = 'false' then
    raise exception 'Changes of this kind from the chat are turned off (Settings → Assistant).';
  end if;

  update assistant_actions set claimed_at = now() where id = a.id;
  return jsonb_build_object('id', a.id, 'kind', a.kind, 'summary', a.summary, 'payload', a.payload);
end $$;
revoke all on function public.assistant_claim_action(uuid) from public, anon;
grant execute on function public.assistant_claim_action(uuid) to authenticated;

-- Settings → Assistant also shows how many changes were prepared and how they
-- ended (the usage panel; admins only, as before).
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
    'changes', (
      select jsonb_build_object(
        'prepared', count(*),
        'confirmed', count(*) filter (where status = 'done'),
        'cancelled', count(*) filter (where status = 'cancelled'),
        'failed', count(*) filter (where status = 'failed'),
        'open', count(*) filter (where status = 'proposed'))
      from assistant_actions where created_at >= since),
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
