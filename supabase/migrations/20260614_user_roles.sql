-- User roles & profiles
-- ----------------------------------------------------------------------------
-- Adds a `profiles` table linked 1:1 to auth.users, holding the app role
-- (admin | editor | viewer) and display name. Team members are created from
-- the admin Users page (Edge Function `admin-users`) with a temporary password.
--
-- Role meaning:
--   admin  -> manages users + full product access
--   editor -> full product access, cannot manage users
--   viewer -> read-only
-- ----------------------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text default '',
  role        text not null default 'viewer' check (role in ('admin', 'editor', 'viewer')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is 'App-level profile and role for each auth user.';

-- Keep updated_at fresh on every change.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Auto-create a profile whenever an auth user is created. The role and name
-- are read from user_metadata (set by the admin-users Edge Function); they
-- default to 'viewer' / '' for users created by any other path.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'role', 'viewer')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: create a profile for every existing user, and bootstrap them all
-- as admin so the current team keeps full access and can manage users from
-- day one. (There is no other admin yet to grant the role.)
insert into public.profiles (id, email, role)
select id, email, 'admin'
from auth.users
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Writes happen exclusively through the admin-users Edge Function (service
-- role, which bypasses RLS), so from the browser we only ever read.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists profiles_select_authenticated on public.profiles;
create policy profiles_select_authenticated
  on public.profiles
  for select
  to authenticated
  using (true);
