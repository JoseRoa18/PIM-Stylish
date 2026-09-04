-- Wix Media Manager file cache: which PIM image (by public Storage URL) is
-- already uploaded to which Wix site, and under which Wix media id.
--
-- Why: Wix's "add product media by URL" silently drops imports from our
-- Storage (Cloudflare bot management on the storage host blocks Wix's
-- fetcher; observed 2026-09-04 on P-205-2: 200 OK, 0 of 10 new files ever
-- landed). The push now uploads the bytes itself and attaches by media id;
-- this table avoids re-uploading the same file on every push. `etag` is the
-- Storage ETag at upload time, so a re-uploaded PIM image (same path, new
-- bytes) is uploaded to Wix again.

create table if not exists public.wix_media_files (
  site text not null,
  storage_path text not null,
  wix_media_id text not null,
  etag text,
  size_bytes bigint,
  uploaded_at timestamptz not null default now(),
  primary key (site, storage_path)
);

alter table public.wix_media_files enable row level security;

create policy wix_media_files_select on public.wix_media_files
  for select to authenticated using (true);
create policy wix_media_files_insert on public.wix_media_files
  for insert to authenticated with check (public.app_can_edit());
create policy wix_media_files_update on public.wix_media_files
  for update to authenticated using (public.app_can_edit()) with check (public.app_can_edit());
create policy wix_media_files_delete on public.wix_media_files
  for delete to authenticated using (public.app_can_edit());
