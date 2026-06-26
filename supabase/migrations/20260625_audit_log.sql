-- Audit log (real activity trail)
-- ----------------------------------------------------------------------------
-- Records WHO did WHAT, WHEN and WHERE across the PIM: product create/edit,
-- media changes, and pushes/exports to external sites (Wix, BB&B).
--
-- NOTE on the name: a pre-existing `public.activity_log` table already exists,
-- but it is demo scaffolding for the Dashboard "Recent Activity" widget — its
-- `actor_id` is a foreign key to a separate `public.users` seed table (Pedro
-- Perez, Sofia Castro, …), which does NOT contain the real team's auth ids.
-- Logging real actions there would be rejected by that FK and its NOT NULL
-- `verb` enum. So this audit trail lives in its own table, `audit_log`, keyed
-- to `auth.users` and decoupled from that demo data.
--
-- Capture is application-level (from the `api/` modules) rather than via DB
-- triggers, because the browser client authenticates with the service_role
-- key, so `auth.uid()` is not reliable inside triggers. The actor is resolved
-- from the signed-in session and written explicitly, with the email/name
-- denormalized so the history survives a user deletion (and needs no join).
-- ----------------------------------------------------------------------------

create table if not exists public.audit_log (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),
  actor_id     uuid references auth.users(id) on delete set null,
  actor_email  text,                       -- snapshot, survives user deletion
  actor_name   text,                       -- snapshot
  action       text not null,              -- create | update | delete | push | export | import | media
  entity_type  text not null,              -- product | media | user | template
  entity_id    text,                       -- SKU, media id, user id, ...
  target       text not null default 'pim',-- pim | wix | bbb (the "where")
  summary      text,                       -- human-readable one-liner
  metadata     jsonb not null default '{}' -- changed keys, counts, dryRun, ...
);

comment on table public.audit_log is
  'Audit trail: who did what, when and where (product/media edits and site pushes). Keyed to auth.users; separate from the demo public.activity_log.';

-- Hot paths for the Activity page: newest-first, plus per-actor / per-entity /
-- per-site filtering.
create index if not exists audit_log_occurred_at_idx on public.audit_log (occurred_at desc);
create index if not exists audit_log_actor_idx       on public.audit_log (actor_id);
create index if not exists audit_log_entity_idx      on public.audit_log (entity_type, entity_id);
create index if not exists audit_log_target_idx      on public.audit_log (target);

-- ---------------------------------------------------------------------------
-- Row Level Security
--   read   -> admins only (an audit trail of the team is sensitive)
--   insert -> any authenticated user, but only as themselves (or unattributed)
-- Note: today the browser uses the service_role key, which bypasses RLS; these
-- policies become the real guard once the anon/service split is fixed
-- (RLS remediation Phases 2-3).
-- ---------------------------------------------------------------------------
alter table public.audit_log enable row level security;

drop policy if exists audit_log_select_admin on public.audit_log;
create policy audit_log_select_admin
  on public.audit_log
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

drop policy if exists audit_log_insert_self on public.audit_log;
create policy audit_log_insert_self
  on public.audit_log
  for insert
  to authenticated
  with check (actor_id is null or actor_id = auth.uid());
