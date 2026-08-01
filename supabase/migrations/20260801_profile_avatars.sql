-- Profile avatars
-- ----------------------------------------------------------------------------
-- Each user can upload their own profile photo:
--   * profiles.avatar_url stores the public URL of the current photo.
--   * A self-update policy lets a signed-in user update ONLY their own row;
--     WITH CHECK pins role to the stored value (app_role() reads the
--     pre-update row) so nobody can self-escalate through this path. All
--     other profile writes keep going through the admin-users Edge Function.
--   * Public `avatars` bucket; files live under <user_id>/... and each user
--     can write only inside their own folder. Mirrors the RLS style of
--     20260625_storage_rls_product_images.sql.
-- ----------------------------------------------------------------------------

alter table public.profiles add column if not exists avatar_url text;

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = public.app_role());

-- Bucket (id = name). Idempotent so re-runs are safe. 2 MB cap; the app
-- downscales to 256px WebP before uploading anyway.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists avatars_read on storage.objects;
create policy avatars_read
  on storage.objects for select
  to authenticated
  using (bucket_id = 'avatars');

drop policy if exists avatars_insert on storage.objects;
create policy avatars_insert
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_update on storage.objects;
create policy avatars_update
  on storage.objects for update
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
