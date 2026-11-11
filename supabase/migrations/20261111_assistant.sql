-- The in-app assistant (user, 2026-11-11: "¿podemos conectar alguna IA que
-- entienda la app y sepa exactamente cómo funciona y pedirle cosas por chat?"
-- — "Hagamos lo del asistente").
--
-- A chat page that answers from the PIM's own documentation and reads live
-- data with the permissions of the person asking. It only reads: nothing here
-- lets it change a product, a price or a setting.
--
--   assistant_chats      one conversation of one person. `messages` is the
--                        conversation exactly as it is sent to the model, kept
--                        on the server and replayed as it is (the model's own
--                        blocks must come back unchanged).
--   assistant_turns      one row per question: who asked, what, the answer,
--                        what was looked up and what it cost.
--   assistant_knowledge  what the assistant knows about the app (written by
--                        scripts/sync-assistant-knowledge.mjs). Server only.
--
-- Only the `assistant` edge function writes these tables (service role).
-- Who may use it: app_settings 'assistant' = { enabled, emails }.

create table if not exists public.assistant_chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'New chat',
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists assistant_chats_user_idx on public.assistant_chats (user_id, updated_at desc);

create table if not exists public.assistant_turns (
  id bigint generated always as identity primary key,
  chat_id uuid not null references public.assistant_chats (id) on delete cascade,
  user_id uuid not null,
  user_email text,
  question text not null,
  answer text,
  tools jsonb not null default '[]'::jsonb,
  model text,
  stop_reason text,
  input_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(10, 5) not null default 0,
  duration_ms integer,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists assistant_turns_chat_idx on public.assistant_turns (chat_id, id);
create index if not exists assistant_turns_created_idx on public.assistant_turns (created_at desc);

create table if not exists public.assistant_knowledge (
  key text primary key,
  content text not null,
  updated_at timestamptz not null default now()
);

alter table public.assistant_chats enable row level security;
alter table public.assistant_turns enable row level security;
alter table public.assistant_knowledge enable row level security;

-- A person reads their own conversations; admins also read every question
-- and its cost (the usage log). Nobody writes from the browser, and the
-- knowledge has no policy at all: only the server reads it.
drop policy if exists "assistant_chats: own" on public.assistant_chats;
create policy "assistant_chats: own" on public.assistant_chats
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "assistant_turns: own or admin" on public.assistant_turns;
create policy "assistant_turns: own or admin" on public.assistant_turns
  for select to authenticated using (user_id = auth.uid() or public.app_is_admin());

revoke all on public.assistant_chats, public.assistant_turns, public.assistant_knowledge from anon, authenticated;
grant select on public.assistant_chats, public.assistant_turns to authenticated;

-- Who may use it. It starts with one person; more are added in this list.
insert into public.app_settings (key, value)
values ('assistant', '{"enabled": true, "emails": ["jose@stylishkb.com"]}'::jsonb)
on conflict (key) do nothing;
