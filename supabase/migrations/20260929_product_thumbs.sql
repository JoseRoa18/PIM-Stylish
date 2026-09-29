-- Our own image thumbnails (performance pass 2026-09-29). Every product
-- image in product-images/<path> gets two square WebP copies here:
--   product-thumbs/<path>.w200.webp   (tiles, table rows, chips)
--   product-thumbs/<path>.w480.webp   (gallery cards, product header)
-- The app shows these first; when one is missing (an image uploaded by a
-- script, or before the backfill) it falls back to the weserv proxy, then
-- to the original file — so nothing ever depends on them existing.
-- Written by the app when an image is uploaded (same people who can upload
-- images) and by scripts/backfill-thumbnails.mjs; removed with the image.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-thumbs', 'product-thumbs', true, 5242880, array['image/webp'])
on conflict (id) do nothing;

drop policy if exists product_thumbs_read on storage.objects;
create policy product_thumbs_read on storage.objects
  for select to authenticated
  using (bucket_id = 'product-thumbs');

drop policy if exists product_thumbs_insert on storage.objects;
create policy product_thumbs_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-thumbs' and public.app_can_edit_media());

drop policy if exists product_thumbs_update on storage.objects;
create policy product_thumbs_update on storage.objects
  for update to authenticated
  using (bucket_id = 'product-thumbs' and public.app_can_edit_media())
  with check (bucket_id = 'product-thumbs' and public.app_can_edit_media());

drop policy if exists product_thumbs_delete on storage.objects;
create policy product_thumbs_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-thumbs' and public.app_can_edit_media());
