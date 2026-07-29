-- Designer role: media-only editing
-- ----------------------------------------------------------------------------
-- Adds a fourth role `designer` that can manage product media (images, videos,
-- documents in product_media + the two storage buckets) but nothing else —
-- products, templates and every other table stay read-only for them.
--
--   admin    -> manages users + full access
--   editor   -> full product access, cannot manage users
--   designer -> media only (product_media + storage buckets)
--   viewer   -> read-only
--
-- Depends on public.app_role() from 20260614_rls_lockdown.sql.
-- ----------------------------------------------------------------------------

-- Allow the new value in profiles.role.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin', 'editor', 'viewer', 'designer'));

-- Helper: who may write media rows/files. Superset of app_can_edit().
create or replace function public.app_can_edit_media()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.app_role() in ('admin', 'editor', 'designer');
$$;

-- === drop legacy permissive policies ========================================
-- These predate the 20260614 lockdown and grant writes to ANY authenticated
-- user. Policies are OR'd, so leaving them would bypass every role check the
-- moment RLS is actually enforced (anon-key swap).
drop policy if exists "Authenticated users can insert media" on public.product_media;
drop policy if exists "Authenticated users can update media" on public.product_media;
drop policy if exists "Authenticated users can delete media" on public.product_media;
drop policy if exists "products_modify_authenticated" on public.products;
drop policy if exists "Authenticated users can manage templates" on public.marketplace_templates;

-- === product_media: widen writes to designers ===============================
drop policy if exists product_media_insert on public.product_media;
drop policy if exists product_media_update on public.product_media;
drop policy if exists product_media_delete on public.product_media;
create policy product_media_insert on public.product_media for insert to authenticated with check (public.app_can_edit_media());
create policy product_media_update on public.product_media for update to authenticated using (public.app_can_edit_media()) with check (public.app_can_edit_media());
create policy product_media_delete on public.product_media for delete to authenticated using (public.app_can_edit_media());

-- === storage: product-images bucket =========================================
drop policy if exists product_images_insert on storage.objects;
create policy product_images_insert
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'product-images' and public.app_can_edit_media());

drop policy if exists product_images_update on storage.objects;
create policy product_images_update
  on storage.objects for update
  to authenticated
  using (bucket_id = 'product-images' and public.app_can_edit_media())
  with check (bucket_id = 'product-images' and public.app_can_edit_media());

drop policy if exists product_images_delete on storage.objects;
create policy product_images_delete
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'product-images' and public.app_can_edit_media());

-- === storage: product-documents bucket ======================================
drop policy if exists product_documents_insert on storage.objects;
create policy product_documents_insert
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'product-documents' and public.app_can_edit_media());

drop policy if exists product_documents_update on storage.objects;
create policy product_documents_update
  on storage.objects for update
  to authenticated
  using (bucket_id = 'product-documents' and public.app_can_edit_media())
  with check (bucket_id = 'product-documents' and public.app_can_edit_media());

drop policy if exists product_documents_delete on storage.objects;
create policy product_documents_delete
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'product-documents' and public.app_can_edit_media());
