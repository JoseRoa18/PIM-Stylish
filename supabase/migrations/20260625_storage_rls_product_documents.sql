-- Storage RLS for the `product-documents` bucket
-- ----------------------------------------------------------------------------
-- The app uploads product documents (spec sheets, installation manuals,
-- warranty, DXF, cut-out templates) straight to this public Storage bucket
-- (see features/media/api/media.js → uploadDocumentFile), and deletes the
-- underlying file when a Supabase-hosted document row is removed. Dropbox stays
-- fully supported in parallel; this only governs files we host ourselves.
--
-- Public bucket, so reads are served over the public URL (and PDF previews load
-- directly — Supabase sends Access-Control-Allow-Origin: *, no pdf-proxy hop).
--
--   read  -> any authenticated user (public URL already covers anonymous reads)
--   write -> editor/admin only  (upload / update / delete)
--
-- Mirrors 20260625_storage_rls_product_images.sql. Depends on
-- public.app_can_edit() from 20260614_rls_lockdown.sql.
--
-- NOTE: if your SQL role can't create policies on storage.objects, create the
-- equivalent rules from the dashboard: Storage → product-documents → Policies.
-- ----------------------------------------------------------------------------

drop policy if exists product_documents_read on storage.objects;
create policy product_documents_read
  on storage.objects for select
  to authenticated
  using (bucket_id = 'product-documents');

drop policy if exists product_documents_insert on storage.objects;
create policy product_documents_insert
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'product-documents' and public.app_can_edit());

drop policy if exists product_documents_update on storage.objects;
create policy product_documents_update
  on storage.objects for update
  to authenticated
  using (bucket_id = 'product-documents' and public.app_can_edit())
  with check (bucket_id = 'product-documents' and public.app_can_edit());

drop policy if exists product_documents_delete on storage.objects;
create policy product_documents_delete
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'product-documents' and public.app_can_edit());
