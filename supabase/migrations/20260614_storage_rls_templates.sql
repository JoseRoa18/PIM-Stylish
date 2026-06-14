-- Storage RLS for the `templates` bucket
-- ----------------------------------------------------------------------------
-- The app uses the private `templates` Storage bucket to upload, download and
-- delete marketplace template spreadsheets (see features/templates/api and
-- syndication/exports/bbbExport — the BB&B export downloads the template).
--
-- While the browser used the service_role key these worked with no policies
-- (service_role bypasses RLS). Once the frontend switches to the real anon key
-- (Phase 2), Storage needs explicit policies or uploads/downloads/exports break.
--
--   read (download)        -> any authenticated user (viewers can run exports)
--   write (upload/del/upd)  -> editor/admin only
--
-- NOTE: if your SQL role can't create policies on storage.objects, create the
-- equivalent rules from the dashboard: Storage → templates → Policies.
-- Depends on public.app_can_edit() from 20260614_rls_lockdown.sql.
-- ----------------------------------------------------------------------------

drop policy if exists templates_read on storage.objects;
create policy templates_read
  on storage.objects for select
  to authenticated
  using (bucket_id = 'templates');

drop policy if exists templates_insert on storage.objects;
create policy templates_insert
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'templates' and public.app_can_edit());

drop policy if exists templates_update on storage.objects;
create policy templates_update
  on storage.objects for update
  to authenticated
  using (bucket_id = 'templates' and public.app_can_edit())
  with check (bucket_id = 'templates' and public.app_can_edit());

drop policy if exists templates_delete on storage.objects;
create policy templates_delete
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'templates' and public.app_can_edit());
