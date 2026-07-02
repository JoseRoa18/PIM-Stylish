import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

/**
 * Infer media type from filename extension.
 */
function inferMediaType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(ext)) return 'video';
  return 'document';
}

function inferMimeType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    pdf: 'application/pdf',
    dxf: 'application/dxf',
    dwg: 'application/dwg',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Convert a Dropbox URL to a direct-embed URL (full resolution).
 */
export function getMediaUrl(storagePath) {
  if (!storagePath) return null;
  return storagePath
    .replace('?dl=0', '?raw=1')
    .replace('&dl=0', '&raw=1');
}

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i;

/**
 * Build a lightweight thumbnail URL for an image so grid tiles don't each pull
 * the full-resolution photo. A 400px webp thumbnail is ~8 KB.
 *
 * Resizes via the free weserv.nl image proxy for BOTH Dropbox and Supabase URLs.
 * We deliberately do NOT use Supabase's native transform: it's a metered Pro
 * feature (only 100 origin images/month included) and this catalog has ~3,300
 * images, so browsing blew past the quota (797/100). weserv is free/unlimited.
 * `fit=cover` + w=h gives a square, undistorted thumbnail matching the grid.
 *
 * Non-image / non-http paths (videos, etc.) are returned as-is.
 */
export function getThumbnailUrl(storagePath, width = 400) {
  const embed = getMediaUrl(storagePath);
  if (!embed) return null;
  if (!/^https?:\/\//i.test(embed) || !IMAGE_EXT_RE.test(embed)) return embed;
  const encoded = encodeURIComponent(embed);
  return `https://images.weserv.nl/?url=${encoded}&w=${width}&h=${width}&fit=cover&output=webp&q=80`;
}

// Public buckets for files uploaded straight to Supabase. Dropbox stays fully
// supported in parallel — a row's storage_path is just a URL either way.
export const MEDIA_BUCKET = 'product-images';
export const DOCS_BUCKET = 'product-documents';
const PUBLIC_MARKER = '/storage/v1/object/public/';

/**
 * True when a storage_path points at a file we host in Supabase Storage (vs a
 * Dropbox shared link). Used to decide whether deleting a row should also
 * delete the underlying file — we NEVER delete from Dropbox.
 */
export function isSupabaseStored(storagePath) {
  return typeof storagePath === 'string' && storagePath.includes(PUBLIC_MARKER);
}

/** Parse a Supabase public URL into { bucket, path }, or null if not one. */
function parseStorageObject(url) {
  if (!isSupabaseStored(url)) return null;
  const rest = url.slice(url.indexOf(PUBLIC_MARKER) + PUBLIC_MARKER.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  return {
    bucket: rest.slice(0, slash),
    path: rest.slice(slash + 1).split('/').map(decodeURIComponent).join('/'),
  };
}

/**
 * Return a poster thumbnail for a video URL when we can derive one (YouTube),
 * else null so the card falls back to an icon. Vimeo needs an API call, skipped.
 */
export function getVideoThumbnail(url) {
  if (!url) return null;
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return `https://img.youtube.com/vi/${yt[1]}/hqdefault.jpg`;
  return null;
}

export async function listMedia(sku) {
  const { data, error } = await supabase
    .from('product_media')
    .select('*')
    .eq('sku', sku)
    .order('display_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Add Dropbox files as visual media (images, videos).
 * `language` tags the batch ('en' | 'en_fr' | 'en_es' | null=Universal) so
 * language-specific imagery (infographics, callouts) can be distinguished
 * from language-neutral product photos. Used by MediaSection.
 */
export async function addDropboxMedia(sku, dropboxFiles, language = null) {
  if (!dropboxFiles || dropboxFiles.length === 0) return [];

  const { data: existingPrimary } = await supabase
    .from('product_media')
    .select('id')
    .eq('sku', sku)
    .eq('is_primary', true)
    .maybeSingle();

  const { data: maxOrderRow } = await supabase
    .from('product_media')
    .select('display_order')
    .eq('sku', sku)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  let nextOrder = (maxOrderRow?.display_order ?? -1) + 1;
  let primaryAssigned = !!existingPrimary;

  const rows = dropboxFiles.map((file) => {
    const mediaType = inferMediaType(file.name);
    const shouldBePrimary = mediaType === 'image' && !primaryAssigned;
    if (shouldBePrimary) primaryAssigned = true;

    return {
      sku,
      media_type: mediaType,
      language,
      storage_path: file.link,
      file_name: file.name,
      file_size_bytes: file.bytes ?? null,
      mime_type: inferMimeType(file.name),
      is_primary: shouldBePrimary,
      display_order: nextOrder++,
    };
  });

  const { data, error } = await supabase
    .from('product_media')
    .insert(rows)
    .select();

  if (error) throw error;

  logActivity({
    action: 'media',
    entityType: 'media',
    entityId: sku,
    summary: `Added ${rows.length} media file(s) to ${sku}`,
    metadata: { count: rows.length, language },
  });
  return data;
}

// Build a collision-safe object path: `<sku>/<base>-<rand>.<ext>`. Keeps the
// original name for display while guaranteeing two different files never clobber.
function buildObjectPath(sku, fileName) {
  const dot = fileName.lastIndexOf('.');
  const ext = dot > -1 ? fileName.slice(dot + 1).toLowerCase() : 'bin';
  const base = (dot > -1 ? fileName.slice(0, dot) : fileName)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'file';
  const rand = Math.random().toString(36).slice(2, 8);
  return `${sku}/${base}-${rand}.${ext}`;
}

/**
 * Upload image files straight from the user's computer to Supabase Storage and
 * register them as product media. Runs ALONGSIDE the Dropbox flow — this just
 * hosts the bytes in Supabase instead of linking a Dropbox file.
 *
 * @param {string}   sku
 * @param {File[]}   files     browser File objects (images)
 * @param {string?}  language  'en' | 'en_fr' | 'en_es' | null=Universal
 * @param {function} onProgress optional (doneCount, total) callback
 */
export async function uploadMediaFiles(sku, files, language = null, onProgress) {
  const list = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));
  if (list.length === 0) return [];

  const { data: existingPrimary } = await supabase
    .from('product_media')
    .select('id')
    .eq('sku', sku)
    .eq('is_primary', true)
    .maybeSingle();

  const { data: maxOrderRow } = await supabase
    .from('product_media')
    .select('display_order')
    .eq('sku', sku)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  let nextOrder = (maxOrderRow?.display_order ?? -1) + 1;
  let primaryAssigned = !!existingPrimary;

  const rows = [];
  let done = 0;
  for (const file of list) {
    const path = buildObjectPath(sku, file.name);
    const { error: upErr } = await supabase.storage.from(MEDIA_BUCKET).upload(path, file, {
      cacheControl: '2592000',
      upsert: true,
      contentType: file.type || inferMimeType(file.name),
    });
    if (upErr) throw new Error(`Upload failed for ${file.name}: ${upErr.message}`);

    const { data: pub } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path);
    const shouldBePrimary = !primaryAssigned;
    if (shouldBePrimary) primaryAssigned = true;

    rows.push({
      sku,
      media_type: 'image',
      language,
      storage_path: pub.publicUrl,
      file_name: file.name,
      file_size_bytes: file.size ?? null,
      mime_type: file.type || inferMimeType(file.name),
      is_primary: shouldBePrimary,
      display_order: nextOrder++,
    });
    done += 1;
    onProgress?.(done, list.length);
  }

  const { data, error } = await supabase.from('product_media').insert(rows).select();
  if (error) throw error;

  logActivity({
    action: 'media',
    entityType: 'media',
    entityId: sku,
    target: 'supabase',
    summary: `Uploaded ${rows.length} image(s) to ${sku} (Supabase)`,
    metadata: { count: rows.length, language },
  });
  return data;
}

/**
 * Register a video by URL (YouTube, Vimeo, or any direct link). Stores the URL
 * as the storage_path with media_type='video' — no bytes are hosted, matching
 * the "videos by link" strategy.
 */
export async function addVideoByUrl(sku, url, language = null) {
  const trimmed = (url ?? '').trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Please paste a valid URL (must start with http:// or https://).');
  }

  const { data: maxOrderRow } = await supabase
    .from('product_media')
    .select('display_order')
    .eq('sku', sku)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  const yt = getVideoThumbnail(trimmed);
  const fileName = yt
    ? 'YouTube video'
    : /vimeo\.com/i.test(trimmed)
      ? 'Vimeo video'
      : decodeURIComponent(trimmed.split('/').pop()?.split('?')[0] ?? '') || 'Video';

  const { data, error } = await supabase
    .from('product_media')
    .insert({
      sku,
      media_type: 'video',
      language,
      storage_path: trimmed,
      file_name: fileName,
      mime_type: 'text/uri-list',
      is_primary: false,
      display_order: (maxOrderRow?.display_order ?? -1) + 1,
    })
    .select()
    .single();

  if (error) throw error;

  logActivity({
    action: 'media',
    entityType: 'media',
    entityId: sku,
    summary: `Added a video link to ${sku}`,
    metadata: { url: trimmed },
  });
  return data;
}

/** Update the alt text (accessibility / SEO / syndication) of one media item. */
export async function setMediaAltText(mediaId, altText) {
  const value = (altText ?? '').trim() || null;
  const { error } = await supabase
    .from('product_media')
    .update({ alt_text: value })
    .eq('id', mediaId);
  if (error) throw error;
}

/** Apply one language tag to many media rows at once. */
export async function bulkSetMediaLanguage(ids, language) {
  if (!ids?.length) return;
  const { error } = await supabase
    .from('product_media')
    .update({ language })
    .in('id', ids);
  if (error) throw error;
}

/**
 * Add a single document from Dropbox, categorized by document_type.
 * `language` ('en' | 'en_fr' | 'en_es' | null) distinguishes language
 * variants of the same type (e.g. spec sheets). Used by DocumentsSection.
 */
export async function addDropboxDocument(sku, documentType, dropboxFile, language = null) {
  const { data: maxOrderRow } = await supabase
    .from('product_media')
    .select('display_order')
    .eq('sku', sku)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextOrder = (maxOrderRow?.display_order ?? -1) + 1;

  const { data, error } = await supabase
    .from('product_media')
    .insert({
      sku,
      media_type: 'document',
      document_type: documentType,
      language,
      storage_path: dropboxFile.link,
      file_name: dropboxFile.name,
      file_size_bytes: dropboxFile.bytes ?? null,
      mime_type: inferMimeType(dropboxFile.name),
      is_primary: false,
      display_order: nextOrder,
    })
    .select()
    .single();

  if (error) throw error;

  logActivity({
    action: 'media',
    entityType: 'media',
    entityId: sku,
    summary: `Added ${documentType} document to ${sku}`,
    metadata: { documentType, language },
  });
  return data;
}

/**
 * Upload a document file (PDF, DXF, …) straight from the user's computer to
 * Supabase Storage and register it. Runs alongside the Dropbox flow.
 */
export async function uploadDocumentFile(sku, documentType, file, language = null) {
  if (!file) throw new Error('No file selected.');

  const { data: maxOrderRow } = await supabase
    .from('product_media')
    .select('display_order')
    .eq('sku', sku)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  const path = buildObjectPath(sku, file.name);
  const { error: upErr } = await supabase.storage.from(DOCS_BUCKET).upload(path, file, {
    cacheControl: '2592000',
    upsert: true,
    contentType: file.type || inferMimeType(file.name),
  });
  if (upErr) throw new Error(`Upload failed for ${file.name}: ${upErr.message}`);

  const { data: pub } = supabase.storage.from(DOCS_BUCKET).getPublicUrl(path);

  const { data, error } = await supabase
    .from('product_media')
    .insert({
      sku,
      media_type: 'document',
      document_type: documentType,
      language,
      storage_path: pub.publicUrl,
      file_name: file.name,
      file_size_bytes: file.size ?? null,
      mime_type: file.type || inferMimeType(file.name),
      is_primary: false,
      display_order: (maxOrderRow?.display_order ?? -1) + 1,
    })
    .select()
    .single();

  if (error) throw error;

  logActivity({
    action: 'media',
    entityType: 'media',
    entityId: sku,
    target: 'supabase',
    summary: `Uploaded ${documentType} document to ${sku} (Supabase)`,
    metadata: { documentType, language },
  });
  return data;
}

/**
 * Add a document by pasting a URL directly (e.g. an existing Dropbox share
 * link from the master spreadsheet). Replaces nothing — caller handles that.
 */
export async function addDocumentByUrl(sku, documentType, url, fileName = null, language = null) {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Please paste a valid URL (must start with http:// or https://).');
  }

  const { data: maxOrderRow } = await supabase
    .from('product_media')
    .select('display_order')
    .eq('sku', sku)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  const inferredName =
    fileName?.trim() ||
    decodeURIComponent(trimmed.split('/').pop()?.split('?')[0] ?? '') ||
    'document';

  const { data, error } = await supabase
    .from('product_media')
    .insert({
      sku,
      media_type: 'document',
      document_type: documentType,
      language,
      storage_path: trimmed,
      file_name: inferredName,
      mime_type: inferMimeType(inferredName),
      is_primary: false,
      display_order: (maxOrderRow?.display_order ?? -1) + 1,
    })
    .select()
    .single();

  if (error) throw error;

  logActivity({
    action: 'media',
    entityType: 'media',
    entityId: sku,
    summary: `Added ${documentType} document to ${sku} (by URL)`,
    metadata: { documentType, language },
  });
  return data;
}

/**
 * Update the language tag of a single media item
 * ('en' | 'en_fr' | 'en_es' | null=Universal).
 */
export async function setMediaLanguage(mediaId, language) {
  const { error } = await supabase
    .from('product_media')
    .update({ language })
    .eq('id', mediaId);
  if (error) throw error;
}

export async function setPrimaryMedia(sku, mediaId) {
  const { error: clearError } = await supabase
    .from('product_media')
    .update({ is_primary: false })
    .eq('sku', sku)
    .eq('is_primary', true);

  if (clearError) throw clearError;

  const { error } = await supabase
    .from('product_media')
    .update({ is_primary: true })
    .eq('id', mediaId);

  if (error) throw error;

  logActivity({
    action: 'media',
    entityType: 'media',
    entityId: sku,
    summary: `Set primary image for ${sku}`,
    metadata: { mediaId },
  });
}

/**
 * Remove a media item. If the file is hosted in Supabase Storage, the file
 * itself is deleted too so we don't pay for orphans. Files in Dropbox are NEVER
 * touched (Dropbox stays the source of truth for those).
 */
export async function removeMedia(media) {
  const { error } = await supabase
    .from('product_media')
    .delete()
    .eq('id', media.id);

  if (error) throw error;

  await deleteStorageObjects([media.storage_path]);

  logActivity({
    action: 'media',
    entityType: 'media',
    entityId: media.sku ?? null,
    summary: `Removed media${media.file_name ? ` "${media.file_name}"` : ''}${media.sku ? ` from ${media.sku}` : ''}`,
    metadata: { mediaId: media.id, deletedFile: isSupabaseStored(media.storage_path) },
  });
}

/**
 * Best-effort delete of the underlying Storage files for the given paths.
 * Skips Dropbox links. Groups by bucket. Never throws — a storage hiccup must
 * not block the row deletion the user already confirmed.
 */
async function deleteStorageObjects(storagePaths) {
  const byBucket = new Map();
  for (const p of storagePaths ?? []) {
    const obj = parseStorageObject(p);
    if (!obj) continue;
    if (!byBucket.has(obj.bucket)) byBucket.set(obj.bucket, []);
    byBucket.get(obj.bucket).push(obj.path);
  }
  for (const [bucket, paths] of byBucket) {
    try {
      await supabase.storage.from(bucket).remove(paths);
    } catch (err) {
      console.warn(`Storage cleanup failed for ${bucket}:`, err?.message ?? err);
    }
  }
}

/**
 * Delete many media rows at once. Supabase-hosted files are deleted from
 * Storage too; Dropbox files are NOT touched. `items` is an array of media
 * objects (need at least { id, storage_path }).
 */
export async function removeMediaBatch(items) {
  if (!items || items.length === 0) return;
  const ids = items.map((m) => m.id);
  const { error } = await supabase
    .from('product_media')
    .delete()
    .in('id', ids);
  if (error) throw error;

  await deleteStorageObjects(items.map((m) => m.storage_path));

  const deletedFiles = items.filter((m) => isSupabaseStored(m.storage_path)).length;
  logActivity({
    action: 'media',
    entityType: 'media',
    summary: `Removed ${ids.length} media file(s)`,
    metadata: { count: ids.length, deletedFiles },
  });
}

/**
 * Persist a new ordering. `orderedIds` is the desired sequence; row N gets
 * display_order = N. Runs updates in parallel — fine for <100 rows.
 */
export async function reorderMedia(orderedIds) {
  if (!orderedIds || orderedIds.length === 0) return;
  const results = await Promise.all(
    orderedIds.map((id, index) =>
      supabase
        .from('product_media')
        .update({ display_order: index })
        .eq('id', id),
    ),
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) throw failed.error;
}