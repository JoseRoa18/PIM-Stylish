import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

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
 * Media URLs are stored ready-to-embed (Supabase Storage public URLs, or
 * external video links added by URL).
 */
export function getMediaUrl(storagePath) {
  return storagePath || null;
}

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i;

/**
 * Build a lightweight thumbnail URL for an image so grid tiles don't each pull
 * the full-resolution photo. A 400px webp thumbnail is ~8 KB.
 *
 * Resizes via the free weserv.nl image proxy.
 * We deliberately do NOT use Supabase's native transform: it's a metered Pro
 * feature (only 100 origin images/month included) and this catalog has ~3,300
 * images, so browsing blew past the quota (797/100). weserv is free/unlimited.
 * `fit=cover` + w=h gives a square, undistorted thumbnail matching the grid.
 *
 * Non-image / non-http paths (videos, etc.) are returned as-is.
 */
// Warm the browser cache for an image URL without rendering anything. Used
// by the hover/background prefetch — a repeat call for the same URL is free.
const warmedImages = new Set();
export function preloadImage(url) {
  if (!url || warmedImages.has(url)) return;
  warmedImages.add(url);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
}

export function getThumbnailUrl(storagePath, width = 400) {
  const embed = getMediaUrl(storagePath);
  if (!embed) return null;
  if (!/^https?:\/\//i.test(embed) || !IMAGE_EXT_RE.test(embed)) return embed;
  const encoded = encodeURIComponent(embed);
  return `https://images.weserv.nl/?url=${encoded}&w=${width}&h=${width}&fit=cover&output=webp&q=80`;
}

// Public buckets for files uploaded to Supabase Storage.
export const MEDIA_BUCKET = 'product-images';
export const DOCS_BUCKET = 'product-documents';
const PUBLIC_MARKER = '/storage/v1/object/public/';

/**
 * True when a storage_path points at a file we host in Supabase Storage (vs an
 * external URL, e.g. a video added by link). Used to decide whether deleting a
 * row should also delete the underlying file — external files are never touched.
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

/**
 * How to play a video URL inside the app:
 *   { kind: 'youtube' | 'vimeo', src } → embed iframe
 *   { kind: 'file', src }              → native <video> (uploaded/direct files)
 */
export function getVideoEmbed(url) {
  if (!url) return null;
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1` };
  const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeo) return { kind: 'vimeo', src: `https://player.vimeo.com/video/${vimeo[1]}?autoplay=1` };
  return { kind: 'file', src: url };
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

// Storage rejects oversized uploads anyway (project + bucket limits are set
// to 400 MB), but failing early gives a clear message instead of a generic
// 413 after minutes of uploading.
const MAX_VIDEO_BYTES = 400 * 1024 * 1024;

/**
 * Videos and documents are FAMILY-SHARED: adding one to any variant registers
 * it on every product of the same variant family (one file in Storage, one
 * product_media row per SKU, all pointing at the same URL). Images stay
 * per-variant. These helpers resolve the family and keep row bookkeeping.
 *
 * EXCEPTION — sink categories are never family-shared: sink families group
 * different constructions (S-300XG is 16G undermount, S-300TG is 18G dual
 * mount…), so their spec sheets, installation docs and videos genuinely
 * differ per variant.
 */
function isFamilyShared(mediaType) {
  return mediaType === 'video' || mediaType === 'document';
}

/** Sink categories keep docs/videos per-product (see note above). */
const familySharableCategory = (category) => !/sink/.test(category ?? '');

/**
 * All SKUs the media should land on: the product's variant family — or just
 * the product itself when it's a sink (per-variant documents/videos).
 */
async function getFamilySkus(sku) {
  const { data: prod } = await supabase
    .from('products')
    .select('family_number, category')
    .eq('sku', sku)
    .maybeSingle();
  if (prod?.family_number == null || !familySharableCategory(prod?.category)) return [sku];
  const { data: fam } = await supabase
    .from('products')
    .select('sku')
    .eq('family_number', prod.family_number);
  const skus = (fam ?? []).map((p) => p.sku);
  return skus.includes(sku) ? skus : [sku, ...skus];
}

/** Next free display_order for each SKU, resolved in a single query. */
async function nextDisplayOrders(skus) {
  const next = new Map(skus.map((s) => [s, 0]));
  const { data } = await supabase
    .from('product_media')
    .select('sku, display_order')
    .in('sku', skus);
  for (const r of data ?? []) {
    if (r.display_order != null && r.display_order + 1 > next.get(r.sku)) {
      next.set(r.sku, r.display_order + 1);
    }
  }
  return next;
}

/**
 * Delete Storage files ONLY when no product_media row references them anymore.
 * Family-shared files are referenced by several rows pointing at the same URL —
 * deleting the file while a sibling still links it would break that sibling.
 */
export async function deleteStorageObjectsIfUnreferenced(storagePaths) {
  const stored = [...new Set((storagePaths ?? []).filter(isSupabaseStored))];
  if (stored.length === 0) return;
  const stillReferenced = new Set();
  for (let i = 0; i < stored.length; i += 20) {
    const { data } = await supabase
      .from('product_media')
      .select('storage_path')
      .in('storage_path', stored.slice(i, i + 20));
    for (const r of data ?? []) stillReferenced.add(r.storage_path);
  }
  await deleteStorageObjects(stored.filter((p) => !stillReferenced.has(p)));
}

/**
 * Upload image AND video files straight from the user's computer to Supabase
 * Storage and register them as product media. Videos are never primary.
 *
 * @param {string}   sku
 * @param {File[]}   files     browser File objects (images / videos)
 * @param {string?}  language  'en' | 'en_fr' | 'en_es' | null=Universal
 * @param {function} onProgress optional (doneCount, total) callback
 */
export async function uploadMediaFiles(sku, files, language = null, onProgress) {
  const list = Array.from(files ?? []).filter(
    (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
  );
  if (list.length === 0) return [];
  const oversized = list.find((f) => f.type.startsWith('video/') && f.size > MAX_VIDEO_BYTES);
  if (oversized) {
    throw new Error(
      `"${oversized.name}" is ${Math.round(oversized.size / 1024 / 1024)} MB — videos over 400 MB should be hosted externally (add them with "Video URL").`,
    );
  }

  // Videos are family-shared: the file uploads once, but every variant of the
  // family gets its own product_media row pointing at the same URL.
  const hasVideos = list.some((f) => f.type.startsWith('video/'));
  const famSkus = hasVideos ? await getFamilySkus(sku) : [sku];
  const siblings = famSkus.filter((s) => s !== sku);

  const { data: existingPrimary } = await supabase
    .from('product_media')
    .select('id')
    .eq('sku', sku)
    .eq('is_primary', true)
    .maybeSingle();

  const orders = await nextDisplayOrders(famSkus);
  const takeOrder = (s) => {
    const n = orders.get(s) ?? 0;
    orders.set(s, n + 1);
    return n;
  };
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
    const isVideo = file.type.startsWith('video/');
    const shouldBePrimary = !isVideo && !primaryAssigned;
    if (shouldBePrimary) primaryAssigned = true;

    const baseRow = {
      media_type: isVideo ? 'video' : 'image',
      language,
      storage_path: pub.publicUrl,
      file_name: file.name,
      file_size_bytes: file.size ?? null,
      mime_type: file.type || inferMimeType(file.name),
      is_primary: false,
    };
    rows.push({ ...baseRow, sku, is_primary: shouldBePrimary, display_order: takeOrder(sku) });
    if (isVideo) {
      for (const sib of siblings) {
        rows.push({ ...baseRow, sku: sib, display_order: takeOrder(sib) });
      }
    }
    done += 1;
    onProgress?.(done, list.length);
  }

  const { data, error } = await supabase.from('product_media').insert(rows).select();
  if (error) throw error;

  const uploaded = rows.filter((r) => r.sku === sku);
  const videoCount = uploaded.filter((r) => r.media_type === 'video').length;
  logActivity({
    action: 'media',
    entityType: 'media',
    entityId: sku,
    target: 'pim',
    summary: `Uploaded ${uploaded.length} media file(s) to ${sku}${videoCount ? ` — ${videoCount} video(s)` : ''}${videoCount && siblings.length ? `, shared with ${siblings.length} family variant(s)` : ''}`,
    metadata: { count: uploaded.length, videos: videoCount, language, sharedWith: videoCount ? siblings : [] },
  });
  return data.filter((r) => r.sku === sku);
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

  // Family-shared: the link is registered on every variant of the family.
  const famSkus = await getFamilySkus(sku);
  const orders = await nextDisplayOrders(famSkus);

  const yt = getVideoThumbnail(trimmed);
  const fileName = yt
    ? 'YouTube video'
    : /vimeo\.com/i.test(trimmed)
      ? 'Vimeo video'
      : decodeURIComponent(trimmed.split('/').pop()?.split('?')[0] ?? '') || 'Video';

  const { data, error } = await supabase
    .from('product_media')
    .insert(
      famSkus.map((s) => ({
        sku: s,
        media_type: 'video',
        language,
        storage_path: trimmed,
        file_name: fileName,
        mime_type: 'text/uri-list',
        is_primary: false,
        display_order: orders.get(s) ?? 0,
      })),
    )
    .select();

  if (error) throw error;

  logActivity({
    action: 'media',
    entityType: 'media',
    entityId: sku,
    summary: `Added a video link to ${sku}${famSkus.length > 1 ? ` (shared with ${famSkus.length - 1} family variant(s))` : ''}`,
    metadata: { url: trimmed, sharedWith: famSkus.filter((s) => s !== sku) },
  });
  return data.find((r) => r.sku === sku) ?? data[0];
}

/**
 * Set (or clear with null) the custom thumbnail of a video. NULL falls back
 * to the default: the product's second image, else the video's own frame.
 */
export async function setVideoPoster(mediaId, thumbnailPath) {
  const { error } = await supabase
    .from('product_media')
    .update({ thumbnail_path: thumbnailPath || null })
    .eq('id', mediaId);
  if (error) throw error;
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
 * Remove every document of the family occupying the given (type, language)
 * slot — the unique index on (sku, document_type, language) requires the slot
 * to be free before the replacement rows insert. Files are deleted only when
 * nothing references them anymore. `language === 'en'` also clears legacy
 * rows with no language (they render in the English slot).
 */
async function clearDocumentSlot(famSkus, documentType, language) {
  let q = supabase
    .from('product_media')
    .select('id, storage_path')
    .in('sku', famSkus)
    .eq('document_type', documentType);
  if (language === 'en') q = q.or('language.eq.en,language.is.null');
  else if (language) q = q.eq('language', language);
  else q = q.is('language', null);

  const { data: existing, error } = await q;
  if (error) throw error;
  if (!existing?.length) return;

  const { error: delErr } = await supabase
    .from('product_media')
    .delete()
    .in('id', existing.map((e) => e.id));
  if (delErr) throw delErr;
  await deleteStorageObjectsIfUnreferenced(existing.map((e) => e.storage_path));
}

/**
 * Upload a document file (PDF, DXF, …) from the user's computer to
 * Supabase Storage and register it. Family-shared: the file uploads once and
 * every variant of the family gets a row; any document already occupying the
 * same (type, language) slot on any variant is replaced.
 */
export async function uploadDocumentFile(sku, documentType, file, language = null) {
  if (!file) throw new Error('No file selected.');

  const famSkus = await getFamilySkus(sku);
  await clearDocumentSlot(famSkus, documentType, language);

  const path = buildObjectPath(sku, file.name);
  const { error: upErr } = await supabase.storage.from(DOCS_BUCKET).upload(path, file, {
    cacheControl: '2592000',
    upsert: true,
    contentType: file.type || inferMimeType(file.name),
  });
  if (upErr) throw new Error(`Upload failed for ${file.name}: ${upErr.message}`);

  const { data: pub } = supabase.storage.from(DOCS_BUCKET).getPublicUrl(path);
  const orders = await nextDisplayOrders(famSkus);

  const { data, error } = await supabase
    .from('product_media')
    .insert(
      famSkus.map((s) => ({
        sku: s,
        media_type: 'document',
        document_type: documentType,
        language,
        storage_path: pub.publicUrl,
        file_name: file.name,
        file_size_bytes: file.size ?? null,
        mime_type: file.type || inferMimeType(file.name),
        is_primary: false,
        display_order: orders.get(s) ?? 0,
      })),
    )
    .select();

  if (error) throw error;

  logActivity({
    action: 'media',
    entityType: 'media',
    entityId: sku,
    target: 'pim',
    summary: `Uploaded ${documentType} document to ${sku}${famSkus.length > 1 ? ` (shared with ${famSkus.length - 1} family variant(s))` : ''}`,
    metadata: { documentType, language, sharedWith: famSkus.filter((s) => s !== sku) },
  });
  return data.find((r) => r.sku === sku) ?? data[0];
}

/**
 * Add a document by pasting a URL directly (any externally hosted file).
 * Family-shared like uploads: registered on every variant, replacing whatever
 * occupied the same (type, language) slot.
 */
export async function addDocumentByUrl(sku, documentType, url, fileName = null, language = null) {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Please paste a valid URL (must start with http:// or https://).');
  }

  const famSkus = await getFamilySkus(sku);
  await clearDocumentSlot(famSkus, documentType, language);
  const orders = await nextDisplayOrders(famSkus);

  const inferredName =
    fileName?.trim() ||
    decodeURIComponent(trimmed.split('/').pop()?.split('?')[0] ?? '') ||
    'document';

  const { data, error } = await supabase
    .from('product_media')
    .insert(
      famSkus.map((s) => ({
        sku: s,
        media_type: 'document',
        document_type: documentType,
        language,
        storage_path: trimmed,
        file_name: inferredName,
        mime_type: inferMimeType(inferredName),
        is_primary: false,
        display_order: orders.get(s) ?? 0,
      })),
    )
    .select();

  if (error) throw error;

  logActivity({
    action: 'media',
    entityType: 'media',
    entityId: sku,
    summary: `Added ${documentType} document to ${sku} (by URL)${famSkus.length > 1 ? ` — shared with ${famSkus.length - 1} family variant(s)` : ''}`,
    metadata: { documentType, language, sharedWith: famSkus.filter((s) => s !== sku) },
  });
  return data.find((r) => r.sku === sku) ?? data[0];
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
 * Remove a media item. Videos and documents are family-shared, so removing
 * one removes it from every variant of the family; images only from their own
 * product. The Storage file is deleted once nothing references it anymore —
 * externally hosted files (e.g. videos linked by URL) are never touched.
 */
export async function removeMedia(media) {
  let removedCount = 1;
  if (isFamilyShared(media.media_type) && media.sku && media.storage_path) {
    const famSkus = await getFamilySkus(media.sku);
    const { data: removed, error } = await supabase
      .from('product_media')
      .delete()
      .eq('storage_path', media.storage_path)
      .in('sku', famSkus)
      .select('id');
    if (error) throw error;
    removedCount = removed?.length ?? 0;
    // Safety net: if the shared match somehow missed the row itself, fall
    // back to deleting it by id so the user's action always lands.
    if (!removed?.some((r) => r.id === media.id)) {
      await supabase.from('product_media').delete().eq('id', media.id);
    }
  } else {
    const { error } = await supabase
      .from('product_media')
      .delete()
      .eq('id', media.id);
    if (error) throw error;
  }

  await deleteStorageObjectsIfUnreferenced([media.storage_path]);

  logActivity({
    action: 'media',
    entityType: 'media',
    entityId: media.sku ?? null,
    summary: `Removed media${media.file_name ? ` "${media.file_name}"` : ''}${media.sku ? ` from ${media.sku}` : ''}${removedCount > 1 ? ` and ${removedCount - 1} family variant(s)` : ''}`,
    metadata: { mediaId: media.id, removedRows: removedCount, deletedFile: isSupabaseStored(media.storage_path) },
  });
}

/**
 * Best-effort delete of the underlying Storage files for the given paths.
 * Skips external URLs. Groups by bucket. Never throws — a storage hiccup must
 * not block the row deletion the user already confirmed. Also used by product
 * deletion to clean up everything a product hosted.
 */
export async function deleteStorageObjects(storagePaths) {
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
 * Delete many media rows at once. Family-shared items (videos, documents)
 * are also removed from every variant of the family. Supabase-hosted files
 * are deleted from Storage once unreferenced; external URLs are not touched.
 * `items` need at least { id, sku, media_type, storage_path }.
 */
export async function removeMediaBatch(items) {
  if (!items || items.length === 0) return;

  const shared = items.filter((m) => isFamilyShared(m.media_type) && m.sku && m.storage_path);
  const ids = items.map((m) => m.id);
  const { error } = await supabase
    .from('product_media')
    .delete()
    .in('id', ids);
  if (error) throw error;

  if (shared.length > 0) {
    // All items come from one product page, so one family lookup covers them.
    const famSkus = await getFamilySkus(shared[0].sku);
    const { error: famErr } = await supabase
      .from('product_media')
      .delete()
      .in('storage_path', shared.map((m) => m.storage_path))
      .in('sku', famSkus);
    if (famErr) throw famErr;
  }

  await deleteStorageObjectsIfUnreferenced(items.map((m) => m.storage_path));

  const deletedFiles = items.filter((m) => isSupabaseStored(m.storage_path)).length;
  logActivity({
    action: 'media',
    entityType: 'media',
    summary: `Removed ${ids.length} media file(s)${shared.length ? ` (${shared.length} shared with the variant family)` : ''}`,
    metadata: { count: ids.length, deletedFiles, sharedRemoved: shared.length },
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