import { supabase } from '@/lib/supabase';

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
 * Build a lightweight thumbnail URL for an image, resized on the fly by the
 * weserv.nl image proxy. Dropbox shared links can't be resized themselves, so
 * without this every grid tile downloads the full-resolution photo (~1 MB).
 * A 400px webp thumbnail of the same image is ~8 KB.
 *
 * Falls back to the full embed URL for non-image paths (e.g. videos) or when
 * there's no path — so it's always safe to use as an <img src>.
 */
export function getThumbnailUrl(storagePath, width = 400) {
  const embed = getMediaUrl(storagePath);
  if (!embed) return null;
  if (!/^https?:\/\//i.test(embed) || !IMAGE_EXT_RE.test(embed)) return embed;
  const encoded = encodeURIComponent(embed);
  // we = without enlargement (never upscale a small source past its size)
  return `https://images.weserv.nl/?url=${encoded}&w=${width}&output=webp&q=80&we`;
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
  return data;
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
}

/**
 * Remove the media reference. The file in Dropbox is NOT touched.
 */
export async function removeMedia(media) {
  const { error } = await supabase
    .from('product_media')
    .delete()
    .eq('id', media.id);

  if (error) throw error;
}

/**
 * Delete many media rows in a single query. Dropbox files are NOT touched.
 */
export async function removeMediaBatch(ids) {
  if (!ids || ids.length === 0) return;
  const { error } = await supabase
    .from('product_media')
    .delete()
    .in('id', ids);
  if (error) throw error;
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