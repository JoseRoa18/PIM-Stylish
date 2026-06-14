-- RLS lockdown + role enforcement
-- ----------------------------------------------------------------------------
-- CONTEXT: until now the browser app used the SERVICE_ROLE key (mislabeled as
-- the anon key), which bypasses RLS entirely — so no table needed policies.
-- That key is extractable from the public deployment, i.e. the whole DB was
-- world-writable. This migration enables RLS and role-aware policies so that,
-- once the frontend switches to the real anon key, access is actually enforced:
--
--   viewer        -> read-only
--   editor/admin  -> read + write
--
-- Applying this while the app still uses service_role is SAFE: service_role
-- bypasses RLS, so nothing breaks until the anon-key swap (Phase 2).
-- ----------------------------------------------------------------------------

-- Role helpers (SECURITY DEFINER so they can read profiles without tripping
-- the caller's own RLS — avoids recursion and works under the anon role).
create or replace function public.app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'viewer');
$$;

create or replace function public.app_can_edit()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.app_role() in ('admin', 'editor');
$$;

-- Helper: standard read-all + editor-write policy set for a content table.
-- (Written inline per table below for clarity / explicit auditing.)

-- === products ===============================================================
alter table public.products enable row level security;
drop policy if exists products_select on public.products;
drop policy if exists products_insert on public.products;
drop policy if exists products_update on public.products;
drop policy if exists products_delete on public.products;
create policy products_select on public.products for select to authenticated using (true);
create policy products_insert on public.products for insert to authenticated with check (public.app_can_edit());
create policy products_update on public.products for update to authenticated using (public.app_can_edit()) with check (public.app_can_edit());
create policy products_delete on public.products for delete to authenticated using (public.app_can_edit());

-- === product_media ==========================================================
alter table public.product_media enable row level security;
drop policy if exists product_media_select on public.product_media;
drop policy if exists product_media_insert on public.product_media;
drop policy if exists product_media_update on public.product_media;
drop policy if exists product_media_delete on public.product_media;
create policy product_media_select on public.product_media for select to authenticated using (true);
create policy product_media_insert on public.product_media for insert to authenticated with check (public.app_can_edit());
create policy product_media_update on public.product_media for update to authenticated using (public.app_can_edit()) with check (public.app_can_edit());
create policy product_media_delete on public.product_media for delete to authenticated using (public.app_can_edit());

-- === marketplace_templates ==================================================
alter table public.marketplace_templates enable row level security;
drop policy if exists marketplace_templates_select on public.marketplace_templates;
drop policy if exists marketplace_templates_insert on public.marketplace_templates;
drop policy if exists marketplace_templates_update on public.marketplace_templates;
drop policy if exists marketplace_templates_delete on public.marketplace_templates;
create policy marketplace_templates_select on public.marketplace_templates for select to authenticated using (true);
create policy marketplace_templates_insert on public.marketplace_templates for insert to authenticated with check (public.app_can_edit());
create policy marketplace_templates_update on public.marketplace_templates for update to authenticated using (public.app_can_edit()) with check (public.app_can_edit());
create policy marketplace_templates_delete on public.marketplace_templates for delete to authenticated using (public.app_can_edit());

-- === activity_log ===========================================================
-- Everyone authenticated can read the feed and append their own activity.
-- No updates/deletes from the client (audit trail stays immutable).
alter table public.activity_log enable row level security;
drop policy if exists activity_log_select on public.activity_log;
drop policy if exists activity_log_insert on public.activity_log;
create policy activity_log_select on public.activity_log for select to authenticated using (true);
create policy activity_log_insert on public.activity_log for insert to authenticated with check (true);

-- === users (legacy mock data) ===============================================
-- This table holds orphan seed rows (pedro/sofia/james/anita) NOT linked to
-- auth and NOT used by the app — the real profile/role source is public.profiles.
-- Enable RLS with no client policies so it stops leaking once the anon-key swap
-- happens. Consider dropping it later: drop table public.users;
alter table public.users enable row level security;
