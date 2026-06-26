-- Storage RLS for the `product-images` bucket
-- ----------------------------------------------------------------------------
-- The app uploads product photos straight to this public Storage bucket (see
-- features/media/api/media.js → uploadMediaFiles), and deletes the underlying
-- file when a Supabase-hosted media row is removed (orphan cleanup). Dropbox
-- stays fully supported in parallel; this only governs files we host ourselves.
--
-- The bucket is PUBLIC, so reads are served over the public URL with no policy.
-- Writes go through the browser's anon key + the signed-in user's JWT, so they
-- need explicit policies or the upload/delete 403s.
--
--   read  -> any authenticated user (public URL already covers anonymous reads)
--   write -> editor/admin only  (upload / update / delete)
--
-- Mirrors 20260614_storage_rls_templates.sql. Depends on public.app_can_edit()
-- from 20260614_rls_lockdown.sql.
--
-- NOTE: if your SQL role can't create policies on storage.objects, create the
-- equivalent rules from the dashboard: Storage → product-images → Policies.
-- ----------------------------------------------------------------------------

drop policy if exists product_images_read on storage.objects;
create policy product_images_read
  on storage.objects for select
  to authenticated
  using (bucket_id = 'product-images');

drop policy if exists product_images_insert on storage.objects;
create policy product_images_insert
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'product-images' and public.app_can_edit());

drop policy if exists product_images_update on storage.objects;
create policy product_images_update
  on storage.objects for update
  to authenticated
  using (bucket_id = 'product-images' and public.app_can_edit())
  with check (bucket_id = 'product-images' and public.app_can_edit());

drop policy if exists product_images_delete on storage.objects;
create policy product_images_delete
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'product-images' and public.app_can_edit());
