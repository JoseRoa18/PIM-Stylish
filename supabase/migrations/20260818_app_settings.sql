-- App-wide settings, one row per key (jsonb value). First consumer:
-- 'promo_automation' — whether the monthly promotion is applied automatically
-- on the 1st at 00:00 America/Caracas (see 20260818_promo_apply_cron.sql and
-- the promo-apply edge function), and to which channels.
--
-- Reads: any authenticated user (the app needs the flags everywhere).
-- Writes: admins only — these switches change what runs unattended.

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Admin-only check, same shape as app_can_edit() (20260614_rls_lockdown.sql).
create or replace function public.app_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.app_role() = 'admin';
$$;

alter table public.app_settings enable row level security;

drop policy if exists app_settings_select on public.app_settings;
drop policy if exists app_settings_insert on public.app_settings;
drop policy if exists app_settings_update on public.app_settings;
drop policy if exists app_settings_delete on public.app_settings;

create policy app_settings_select on public.app_settings
  for select to authenticated using (true);
create policy app_settings_insert on public.app_settings
  for insert to authenticated with check (public.app_is_admin());
create policy app_settings_update on public.app_settings
  for update to authenticated using (public.app_is_admin()) with check (public.app_is_admin());
create policy app_settings_delete on public.app_settings
  for delete to authenticated using (public.app_is_admin());

insert into public.app_settings (key, value)
values ('promo_automation', '{"enabled": true, "wix": true, "bestbuy": true}'::jsonb)
on conflict (key) do nothing;

-- Best Buy promo scheduling state: when a promo's scheduled discounts were
-- pushed to Mirakl and the resulting report (counts, import id, skips).
alter table public.promotions
  add column if not exists bb_scheduled_at timestamptz,
  add column if not exists bb_schedule jsonb;
