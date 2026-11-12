-- Excel files the assistant prepares (user, 2026-11-12: "agrégale la función
-- de crear documentos en Excel … en Word no, solo en Excel").
--
-- The assistant only DESCRIBES a file: its sheets, each one a read of a table
-- (table, columns, filters, order) or a short table it typed. The description
-- is kept here and shown to the person as a card with a Download button; the
-- page reads the rows when they press it, with their own session
-- (supabase/functions/_shared/assistantExcel.js). So no file is stored, and a
-- file never holds more than its reader may see.
--
--   spec     { title, sheets: [ { name, table, select, filters, order, columns }
--                             | { name, columns, rows } ] }
--   summary  { sheets: [{ name, rows, columns, source }] } — what each sheet
--            held when the file was prepared (drawn on the card)
--
-- Only the `assistant` edge function writes it (service role). A person reads
-- their own files and nobody else's: a typed sheet can hold what only that
-- person may see, so admins do not read another person's either.

create table if not exists public.assistant_files (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.assistant_chats (id) on delete cascade,
  turn_id bigint references public.assistant_turns (id) on delete set null,
  user_id uuid not null,
  kind text not null default 'excel' check (kind in ('excel')),
  title text not null,
  spec jsonb not null,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists assistant_files_chat_idx on public.assistant_files (chat_id, created_at);

alter table public.assistant_files enable row level security;
drop policy if exists "assistant_files: own" on public.assistant_files;
create policy "assistant_files: own" on public.assistant_files
  for select to authenticated using (user_id = auth.uid());

revoke all on public.assistant_files from anon, authenticated;
grant select on public.assistant_files to authenticated;
