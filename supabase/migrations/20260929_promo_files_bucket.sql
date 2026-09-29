-- Files a promotion handed to a portal, kept so its "Back to Blue" can be
-- generated without uploading anything again (user idea 2026-09-29): the
-- Menards file filled when the promotion starts, and Wayfair's pricing file
-- of the Promo MAP day. Path: <promotion id>/<channel>/<task>-<ms>-<name>.
-- promotions.file_tasks["<channel>:<task>"] points at it ({ file, file_name,
-- skus }) together with the products that went out, so Back to Blue carries
-- exactly those. Private: admins and editors only (app_can_edit), like the
-- templates bucket.
--
-- APPLIED live 2026-09-29 via the management API; this file documents it.

insert into storage.buckets (id, name, public, file_size_limit)
values ('promo-files', 'promo-files', false, 52428800)
on conflict (id) do nothing;

drop policy if exists promo_files_read on storage.objects;
drop policy if exists promo_files_insert on storage.objects;
drop policy if exists promo_files_update on storage.objects;
drop policy if exists promo_files_delete on storage.objects;

create policy promo_files_read on storage.objects for select to authenticated
  using (bucket_id = 'promo-files' and public.app_can_edit());
create policy promo_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'promo-files' and public.app_can_edit());
create policy promo_files_update on storage.objects for update to authenticated
  using (bucket_id = 'promo-files' and public.app_can_edit())
  with check (bucket_id = 'promo-files' and public.app_can_edit());
create policy promo_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'promo-files' and public.app_can_edit());
