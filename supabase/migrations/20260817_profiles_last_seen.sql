-- Real "last active" tracking. Supabase's auth last_sign_in_at only updates
-- on an explicit login — sessions renew silently for weeks, so it reads as
-- stale for daily users. The app heartbeats this column instead (on load and
-- periodically while the tab is open); the Users page shows the greatest of
-- the two. Writable by each user on their own row via profiles_update_own.

alter table public.profiles
  add column if not exists last_seen_at timestamptz;
