import { supabase } from '@/lib/supabase';
import { logActivity } from '@/features/activity/api/activityLog';

const BUCKET = 'avatars';
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const TARGET_SIZE = 256;

// Storage path from the public URL we keep in profiles.avatar_url.
function pathFromUrl(url) {
  const marker = `/object/public/${BUCKET}/`;
  const i = url?.indexOf(marker) ?? -1;
  return i === -1 ? null : decodeURIComponent(url.slice(i + marker.length));
}

// Center-crop + downscale to a 256px square WebP so uploads are tiny and
// uniform regardless of what the user picks.
async function toAvatarBlob(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = TARGET_SIZE;
    canvas.height = TARGET_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, TARGET_SIZE, TARGET_SIZE);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
    if (!blob) throw new Error('Could not process the image.');
    return blob;
  } finally {
    bitmap.close();
  }
}

/**
 * Uploads a new profile photo for `userId` and points profiles.avatar_url at
 * it. The previous file (if any) is removed afterwards. Returns the new URL.
 */
export async function uploadAvatar(userId, file, previousUrl = null) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    throw new Error('Use a JPG, PNG or WebP image.');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('Image is too large — pick one under 10 MB.');
  }

  const blob = await toAvatarBlob(file);
  // Timestamped name = new URL on every change, so no stale browser caches.
  const path = `${userId}/avatar-${Date.now()}.webp`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: 'image/webp', cacheControl: '3600' });
  if (uploadError) throw uploadError;

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  const { error: profileError } = await supabase
    .from('profiles')
    .update({ avatar_url: pub.publicUrl })
    .eq('id', userId);
  if (profileError) {
    // Roll back the orphan upload; the profile still points at the old photo.
    await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
    throw profileError;
  }

  const previousPath = pathFromUrl(previousUrl);
  if (previousPath) {
    await supabase.storage.from(BUCKET).remove([previousPath]).catch(() => {});
  }

  logActivity({
    action: 'update',
    entityType: 'user',
    entityId: userId,
    summary: 'Updated their profile photo',
  });
  return pub.publicUrl;
}

/** Clears the user's profile photo and deletes the stored file. */
export async function removeAvatar(userId, currentUrl) {
  const { error } = await supabase
    .from('profiles')
    .update({ avatar_url: null })
    .eq('id', userId);
  if (error) throw error;

  const path = pathFromUrl(currentUrl);
  if (path) {
    await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
  }

  logActivity({
    action: 'update',
    entityType: 'user',
    entityId: userId,
    summary: 'Removed their profile photo',
  });
}
