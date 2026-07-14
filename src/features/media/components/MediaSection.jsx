import { useEffect, useRef, useState } from 'react';
import { Star, Trash2, Film, ImagePlus, ExternalLink, X, GripVertical, Link2, Copy, Check, Upload, Video, Pencil, Download, Loader2 } from 'lucide-react';
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import { attachClosestEdge, extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { useProductMedia } from '../hooks/useProductMedia';
import {
  addDropboxMedia,
  uploadMediaFiles,
  addVideoByUrl,
  setPrimaryMedia,
  setMediaLanguage,
  setMediaAltText,
  bulkSetMediaLanguage,
  removeMedia,
  removeMediaBatch,
  reorderMedia,
  getMediaUrl,
  getThumbnailUrl,
  getVideoThumbnail,
  isSupabaseStored,
} from '../api/media';
import Skeleton from '@/components/ui/Skeleton';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { useAuth } from '@/features/auth/AuthContext';
import Lightbox from 'yet-another-react-lightbox';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'yet-another-react-lightbox/styles.css';

// Language variants for imagery. `null` = Universal (language-neutral photos);
// the others tag images that carry text/infographics in a given language.
const IMAGE_LANGUAGES = [
  { id: null, label: 'Universal', short: 'ALL' },
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'en_fr', label: 'English-French', short: 'FR' },
  { id: 'en_es', label: 'English-Spanish', short: 'ES' },
];
const langMeta = (id) => IMAGE_LANGUAGES.find((l) => l.id === (id ?? null)) ?? IMAGE_LANGUAGES[0];
const bucketOf = (m) => m.language ?? 'universal';

// Move `startIndex` to sit before/after `indexOfTarget` based on the closest
// edge — the standard reorder math, inlined so we don't depend on the hitbox
// reorder util (which Vite/rolldown can't resolve as a subpath).
function reorderByEdge(list, startIndex, indexOfTarget, edge) {
  const result = [...list];
  const [moved] = result.splice(startIndex, 1);
  let insertIndex = indexOfTarget - (startIndex < indexOfTarget ? 1 : 0);
  if (edge === 'right') insertIndex += 1;
  insertIndex = Math.max(0, Math.min(insertIndex, result.length));
  result.splice(insertIndex, 0, moved);
  return result;
}

export default function MediaSection({ sku }) {
  const confirm = useConfirm();
  const { canEdit } = useAuth();
  const { images, videos, loading, error, reload, mutate } = useProductMedia(sku);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [langFilter, setLangFilter] = useState(null); // null = auto (first available bucket)
  const [addLanguage, setAddLanguage] = useState(''); // '' = Universal
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [linksModal, setLinksModal] = useState(null); // { title, items } | null
  const [uploadProgress, setUploadProgress] = useState(null); // { done, total } | null
  const [dragOver, setDragOver] = useState(false);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [altEdit, setAltEdit] = useState(null); // media item being edited | null
  const fileInputRef = useRef(null);

  // Visual media only, sorted by display_order
  const visualMedia = [...images, ...videos].sort(
    (a, b) => (a.display_order ?? 0) - (b.display_order ?? 0),
  );

  // Counts per language bucket — only buckets that actually have images become
  // filter chips. We always show ONE language at a time (no "All") so the
  // EN / EN-FR duplicates of the same shot don't appear side by side.
  const counts = { universal: 0, en: 0, en_fr: 0, en_es: 0 };
  for (const m of visualMedia) counts[bucketOf(m)] = (counts[bucketOf(m)] ?? 0) + 1;
  const presentBuckets = ['universal', 'en', 'en_fr', 'en_es'].filter((b) => counts[b] > 0);
  const activeFilter = presentBuckets.includes(langFilter) ? langFilter : (presentBuckets[0] ?? null);

  const filteredMedia = activeFilter
    ? visualMedia.filter((m) => bucketOf(m) === activeFilter)
    : visualMedia;

  // Lightbox slides — full-res images from the visible set, in display order.
  const imageSlides = filteredMedia.filter((m) => m.media_type === 'image');
  const slides = imageSlides.map((m) => ({ src: getMediaUrl(m.storage_path) }));

  const reorderEnabled = true;

  // The reorder monitor reads the latest lists via refs so it can register once
  // yet always see fresh media (full list + the currently visible filtered list).
  const mediaRef = useRef(visualMedia);
  const filteredRef = useRef(filteredMedia);
  useEffect(() => {
    mediaRef.current = visualMedia;
    filteredRef.current = filteredMedia;
  });

  const persistReorder = async (reordered) => {
    const orderById = new Map(reordered.map((m, i) => [m.id, i]));
    mutate((prev) =>
      prev.map((m) => (orderById.has(m.id) ? { ...m, display_order: orderById.get(m.id) } : m)),
    );
    setBusy(true);
    try {
      await reorderMedia(reordered.map((m) => m.id));
      reload();
    } catch (err) {
      setErrorMessage(`Reorder failed: ${err.message}`);
      reload();
    } finally {
      setBusy(false);
    }
  };

  // Global drop monitor — computes the new order from the dragged card and the
  // closest edge of the card it was dropped on.
  useEffect(() => {
    if (!reorderEnabled) return undefined;
    return monitorForElements({
      canMonitor: ({ source }) => source.data?.type === 'media-card',
      onDrop: ({ source, location }) => {
        const target = location.current.dropTargets[0];
        if (!target) return;
        // Reorder within the currently visible (filtered) set, then splice the
        // new order back into the full list so display_order stays global and
        // the other language's images keep their positions.
        const flist = filteredRef.current;
        const startIndex = flist.findIndex((m) => m.id === source.data.id);
        const indexOfTarget = flist.findIndex((m) => m.id === target.data.id);
        if (startIndex < 0 || indexOfTarget < 0) return;
        const edge = extractClosestEdge(target.data);
        const newFiltered = reorderByEdge(flist, startIndex, indexOfTarget, edge);
        if (newFiltered[startIndex]?.id === flist[startIndex]?.id) return; // no change
        const ids = new Set(newFiltered.map((m) => m.id));
        let fi = 0;
        const newFull = mediaRef.current.map((m) => (ids.has(m.id) ? newFiltered[fi++] : m));
        persistReorder(newFull);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reorderEnabled]);

  const openDropboxPicker = () => {
    if (typeof window === 'undefined' || !window.Dropbox) {
      setErrorMessage(
        'Dropbox Chooser is not loaded. Check the script tag in index.html and the VITE_DROPBOX_APP_KEY env var.',
      );
      return;
    }

    setErrorMessage(null);

    window.Dropbox.choose({
      // 'preview' returns permanent shared links that hot-link via ?raw=1.
      // 'direct' returns CDN URLs that expire after ~4 hours — do not use.
      linkType: 'preview',
      multiselect: true,
      extensions: ['images', 'video'],
      success: async (files) => {
        setBusy(true);
        try {
          await addDropboxMedia(sku, files, addLanguage || null);
          reload();
        } catch (err) {
          setErrorMessage(err.message);
          console.error('Add media error:', err);
        } finally {
          setBusy(false);
        }
      },
      cancel: () => {},
    });
  };

  // ---------------- Native Supabase upload ----------------

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    setErrorMessage(null);
    setUploadProgress({ done: 0, total: files.length });
    try {
      await uploadMediaFiles(sku, files, addLanguage || null, (done, total) =>
        setUploadProgress({ done, total }),
      );
      reload();
    } catch (err) {
      setErrorMessage(err.message);
      console.error('Upload error:', err);
    } finally {
      setUploadProgress(null);
    }
  };

  const onFileInputChange = (e) => {
    handleFiles(e.target.files);
    e.target.value = ''; // allow re-selecting the same file
  };

  // Native file drag-and-drop onto the section. We only react to OS file drags
  // (types includes 'Files'); element/card drags for reorder are left alone.
  const isFileDrag = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onSectionDragOver = (e) => {
    if (!canEdit || !isFileDrag(e)) return;
    e.preventDefault();
    if (!dragOver) setDragOver(true);
  };
  const onSectionDragLeave = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return; // still inside
    setDragOver(false);
  };
  const onSectionDrop = (e) => {
    if (!canEdit || !isFileDrag(e)) return;
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  const handleAddVideo = async (url, language) => {
    await addVideoByUrl(sku, url, language || null);
    reload();
  };

  // ---------------- Alt text + bulk language ----------------

  const handleSaveAlt = async (mediaId, altText) => {
    mutate((prev) => prev.map((m) => (m.id === mediaId ? { ...m, alt_text: altText } : m)));
    try {
      await setMediaAltText(mediaId, altText);
    } catch (err) {
      setErrorMessage(`Failed to save alt text: ${err.message}`);
      reload();
    }
  };

  const handleBulkLanguage = async (language) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    mutate((prev) => prev.map((m) => (selectedIds.has(m.id) ? { ...m, language } : m)));
    try {
      await bulkSetMediaLanguage(ids, language);
    } catch (err) {
      setErrorMessage(`Failed to set language: ${err.message}`);
      reload();
    }
  };

  const handleBulkDownload = async () => {
    const items = visualMedia.filter((m) => selectedIds.has(m.id) && m.media_type === 'image');
    if (items.length === 0) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      const failures = [];
      for (const m of items) {
        try {
          const res = await fetch(getMediaUrl(m.storage_path));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          zip.file(m.file_name, await res.blob());
        } catch {
          failures.push(m);
        }
      }
      if (failures.length) {
        zip.file(
          '_could_not_download.txt',
          failures.map((m) => `${m.file_name}\t${getMediaUrl(m.storage_path)}`).join('\n'),
        );
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${sku}_images_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      if (failures.length) {
        setErrorMessage(
          `${failures.length} file(s) couldn't be downloaded (likely Dropbox CORS) — their links are in _could_not_download.txt inside the zip.`,
        );
      }
    } catch (err) {
      setErrorMessage(`Download failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSetPrimary = async (mediaId) => {
    try {
      await setPrimaryMedia(sku, mediaId);
      reload();
    } catch (err) {
      console.error('Set primary error:', err);
      setErrorMessage(`Failed to set primary: ${err.message}`);
    }
  };

  const handleSetLanguage = async (mediaId, language) => {
    // Optimistic update so the badge/filter reflect the change immediately.
    mutate((prev) => prev.map((m) => (m.id === mediaId ? { ...m, language } : m)));
    try {
      await setMediaLanguage(mediaId, language);
    } catch (err) {
      setErrorMessage(`Failed to set language: ${err.message}`);
      reload();
    }
  };

  const handleRemove = async (mediaItem) => {
    const confirmed = await confirm({
      title: `Remove "${mediaItem.file_name}"?`,
      message: isSupabaseStored(mediaItem.storage_path)
        ? 'This permanently deletes the file from Supabase storage too. This cannot be undone.'
        : 'The file stays in Dropbox.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await removeMedia(mediaItem);
      reload();
    } catch (err) {
      console.error('Remove error:', err);
      setErrorMessage(`Failed to remove: ${err.message}`);
    }
  };

  // ---------------- Selection ----------------

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const selectAllVisible = () => setSelectedIds(new Set(filteredMedia.map((m) => m.id)));

  const handleBulkRemove = async () => {
    if (selectedIds.size === 0) return;
    const items = visualMedia.filter((m) => selectedIds.has(m.id));
    const supaCount = items.filter((m) => isSupabaseStored(m.storage_path)).length;
    const confirmed = await confirm({
      title: `Remove ${items.length} item${items.length === 1 ? '' : 's'}?`,
      message: supaCount
        ? `${supaCount} of these are hosted in Supabase and will be permanently deleted from storage. This cannot be undone.`
        : 'The files stay in Dropbox.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;

    setBusy(true);
    // Optimistic: drop the rows from local state immediately.
    mutate((prev) => prev.filter((m) => !selectedIds.has(m.id)));
    clearSelection();
    try {
      await removeMediaBatch(items);
      reload();
    } catch (err) {
      setErrorMessage(`Bulk remove failed: ${err.message}`);
      reload(); // resync on failure
    } finally {
      setBusy(false);
    }
  };

  const BUCKET_LABELS = {
    universal: 'Universal',
    en: 'English',
    en_fr: 'English-French',
    en_es: 'English-Spanish',
  };
  const FILTER_CHIPS = presentBuckets.map((id) => ({ id, label: BUCKET_LABELS[id] }));

  // ---------------- Links ----------------
  // Map a media row to the shape the links dialog renders.
  const toLinkItem = (m) => ({
    id: m.id,
    file_name: m.file_name,
    url: getMediaUrl(m.storage_path),
    thumb: getThumbnailUrl(m.storage_path, 120),
    language: m.language,
    is_primary: m.is_primary,
    media_type: m.media_type,
  });

  const openAllLinks = () =>
    setLinksModal({
      title: `All media · ${sku}`,
      subtitle: `${visualMedia.length} file${visualMedia.length === 1 ? '' : 's'}`,
      items: visualMedia.map(toLinkItem),
    });

  const openSelectedLinks = () => {
    const items = visualMedia.filter((m) => selectedIds.has(m.id)).map(toLinkItem);
    setLinksModal({
      title: `Selected media · ${sku}`,
      subtitle: `${items.length} file${items.length === 1 ? '' : 's'}`,
      items,
    });
  };

  return (
    <section
      className="relative rounded-xl border border-outline-variant bg-surface-container-lowest overflow-hidden"
      onDragOver={onSectionDragOver}
      onDragLeave={onSectionDragLeave}
      onDrop={onSectionDrop}
    >
      {/* Drop-to-upload overlay (only for OS file drags) */}
      {dragOver && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-primary/10 border-2 border-dashed border-primary rounded-xl pointer-events-none">
          <Upload className="w-10 h-10 text-primary" />
          <p className="text-title-md text-primary font-semibold">Drop images to upload to Supabase</p>
          <p className="text-body-sm text-on-surface-variant">
            Tagged as {langMeta(addLanguage || null).label}
          </p>
        </div>
      )}

      <div className="px-6 py-4 flex items-center justify-between border-b border-outline-variant gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="text-title-lg text-on-surface">Media</h2>
          {!loading && (
            <span className="text-body-sm text-on-surface-variant">
              {visualMedia.length} {visualMedia.length === 1 ? 'item' : 'items'}
            </span>
          )}
          {!loading && !error && visualMedia.length > 0 && (
            <button
              type="button"
              onClick={openAllLinks}
              title="View & copy links for all media"
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-outline-variant text-label-md text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors"
            >
              <Link2 className="w-3.5 h-3.5" />
              Links
            </button>
          )}
        </div>

        {canEdit && (
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1.5 text-label-md text-on-surface-variant">
              Tag new as
              <select
                value={addLanguage}
                onChange={(e) => setAddLanguage(e.target.value)}
                className="px-2 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              >
                {IMAGE_LANGUAGES.map((l) => (
                  <option key={l.id ?? 'universal'} value={l.id ?? ''}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={onFileInputChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || !!uploadProgress}
              title="Upload images from your computer to Supabase"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
            >
              {uploadProgress ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              {uploadProgress ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…` : 'Upload'}
            </button>
            <button
              type="button"
              onClick={() => setVideoModalOpen(true)}
              disabled={busy}
              title="Add a video by URL (YouTube, Vimeo, …)"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
            >
              <Video className="w-4 h-4" />
              Video URL
            </button>
            <button
              type="button"
              onClick={openDropboxPicker}
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <DropboxIcon className="w-4 h-4" />
              {busy ? 'Working…' : 'Add from Dropbox'}
            </button>
          </div>
        )}
      </div>

      {/* Language filter chips */}
      {!loading && !error && visualMedia.length > 0 && (
        <div className="px-6 py-3 flex items-center gap-2 flex-wrap border-b border-outline-variant">
          {FILTER_CHIPS.map((chip) => {
            const active = activeFilter === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => setLangFilter(chip.id)}
                aria-pressed={active}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-body-sm border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  active
                    ? 'bg-primary-container text-on-primary-container border-primary-container'
                    : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:bg-surface-container-low'
                }`}
              >
                {chip.label}
                <span className="text-label-md font-semibold tabular-nums">{counts[chip.id]}</span>
              </button>
            );
          })}
        </div>
      )}

      {canEdit && selectedIds.size > 0 && (
        <div className="px-6 py-3 flex items-center justify-between gap-4 flex-wrap bg-primary-container/40 border-b border-outline-variant">
          <span className="text-body-md text-on-surface">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={selectAllVisible}
              className="px-3 py-1.5 rounded-full bg-surface-container text-on-surface text-label-md hover:bg-surface-container-high transition-colors"
            >
              Select all ({filteredMedia.length})
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-surface-container text-on-surface text-label-md hover:bg-surface-container-high transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              Clear
            </button>
            <select
              value=""
              onChange={(e) => {
                handleBulkLanguage(e.target.value || null);
                e.target.value = '';
              }}
              title="Set language for all selected"
              className="px-3 py-1.5 rounded-full bg-surface-container text-on-surface text-label-md hover:bg-surface-container-high transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="" disabled>
                Set language…
              </option>
              {IMAGE_LANGUAGES.map((l) => (
                <option key={l.id ?? 'universal'} value={l.id ?? ''}>
                  {l.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleBulkDownload}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-surface-container text-on-surface text-label-md hover:bg-surface-container-high transition-colors disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </button>
            <button
              type="button"
              onClick={openSelectedLinks}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-surface-container text-on-surface text-label-md hover:bg-surface-container-high transition-colors"
            >
              <Link2 className="w-3.5 h-3.5" />
              Get links ({selectedIds.size})
            </button>
            <button
              type="button"
              onClick={handleBulkRemove}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-error text-on-error text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Remove {selectedIds.size}
            </button>
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="px-6 py-3 bg-error-container text-on-error-container text-body-sm border-b border-outline-variant">
          {errorMessage}
        </div>
      )}

      <div className="px-6 py-6">
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <p className="text-body-md text-error">Failed to load media: {error.message}</p>
        ) : visualMedia.length === 0 ? (
          <EmptyState onAddClick={openDropboxPicker} canEdit={canEdit} />
        ) : filteredMedia.length === 0 ? (
          <p className="text-body-md text-on-surface-variant text-center py-8">
            No media tagged as {langMeta(activeFilter === 'universal' ? null : activeFilter).label}.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {filteredMedia.map((item) => (
              <MediaCard
                key={item.id}
                item={item}
                canEdit={canEdit}
                reorderEnabled={reorderEnabled}
                selected={selectedIds.has(item.id)}
                onToggleSelect={() => toggleSelect(item.id)}
                onSetPrimary={() => handleSetPrimary(item.id)}
                onSetLanguage={(lang) => handleSetLanguage(item.id, lang)}
                onRemove={() => handleRemove(item)}
                onEditAlt={() => setAltEdit(item)}
                onView={() => setLightboxIndex(imageSlides.findIndex((m) => m.id === item.id))}
              />
            ))}

            {canEdit && (
              <button
                type="button"
                onClick={openDropboxPicker}
                className="aspect-square rounded-lg border-2 border-dashed border-outline-variant hover:border-primary hover:bg-surface-container-low transition-colors flex flex-col items-center justify-center text-on-surface-variant hover:text-primary"
              >
                <ImagePlus className="w-8 h-8 mb-1" strokeWidth={1.5} />
                <span className="text-body-sm">Add more</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Full-screen viewer with smooth zoom (wheel/pinch/double-click) and
          next/prev (arrows, keyboard, swipe). */}
      <Lightbox
        open={lightboxIndex >= 0}
        close={() => setLightboxIndex(-1)}
        index={Math.max(0, lightboxIndex)}
        slides={slides}
        plugins={[Zoom]}
        zoom={{
          maxZoomPixelRatio: 3,
          zoomInMultiplier: 1.15, // gentle steps (default 2 is jumpy)
          wheelZoomDistanceFactor: 900, // higher = smoother/slower wheel zoom
          pinchZoomDistanceFactor: 250,
          scrollToZoom: true,
          // Disable double-click/double-tap zoom: with delay 0 the
          // `timeStamp - lastPointerDown < delay` check never fires.
          doubleClickDelay: 0,
          doubleTapDelay: 0,
        }}
        carousel={{ finite: false }}
        animation={{ zoom: 500 }}
        // Click on the backdrop (outside the image) closes the lightbox.
        controller={{ closeOnBackdropClick: true }}
        // Semi-transparent + blurred backdrop so the page shows faintly behind.
        styles={{ container: { backgroundColor: 'rgba(0, 0, 0, 0.7)', backdropFilter: 'blur(4px)' } }}
      />

      {linksModal && (
        <LinksDialog
          title={linksModal.title}
          subtitle={linksModal.subtitle}
          items={linksModal.items}
          onClose={() => setLinksModal(null)}
        />
      )}

      {videoModalOpen && (
        <VideoUrlDialog
          defaultLanguage={addLanguage}
          onClose={() => setVideoModalOpen(false)}
          onAdd={handleAddVideo}
        />
      )}

      {altEdit && (
        <AltTextDialog
          item={altEdit}
          onClose={() => setAltEdit(null)}
          onSave={handleSaveAlt}
        />
      )}
    </section>
  );
}

function EmptyState({ onAddClick, canEdit }) {
  if (!canEdit) {
    return (
      <div className="w-full py-12 rounded-xl border-2 border-dashed border-outline-variant text-center">
        <ImagePlus className="w-12 h-12 mx-auto mb-3 text-on-surface-variant" strokeWidth={1.5} />
        <p className="text-body-md text-on-surface mb-1">No media linked yet</p>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onAddClick}
      className="w-full py-12 rounded-xl border-2 border-dashed border-outline-variant hover:border-primary hover:bg-surface-container-low transition-colors group"
    >
      <ImagePlus
        className="w-12 h-12 mx-auto mb-3 text-on-surface-variant group-hover:text-primary transition-colors"
        strokeWidth={1.5}
      />
      <p className="text-body-md text-on-surface mb-1">No media linked yet</p>
      <p className="text-body-sm text-on-surface-variant">
        Browse Dropbox to add product photos or videos
      </p>
    </button>
  );
}

function MediaCard({
  item,
  canEdit,
  reorderEnabled,
  selected,
  onToggleSelect,
  onSetPrimary,
  onSetLanguage,
  onRemove,
  onEditAlt,
  onView,
}) {
  const ref = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState(null);
  const [copied, setCopied] = useState(false);
  const draggableOn = canEdit && reorderEnabled;

  const isImage = item.media_type === 'image';
  const isVideo = item.media_type === 'video';
  const url = getMediaUrl(item.storage_path);
  const thumbUrl = getThumbnailUrl(item.storage_path, 400);
  const videoThumb = isVideo ? getVideoThumbnail(item.storage_path) : null;

  // Register the card as both a draggable and a drop target (Pragmatic DnD).
  useEffect(() => {
    const el = ref.current;
    if (!el || !draggableOn) return undefined;
    return combine(
      draggable({
        element: el,
        getInitialData: () => ({ type: 'media-card', id: item.id }),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) => source.data?.type === 'media-card' && source.data.id !== item.id,
        getData: ({ input, element }) =>
          attachClosestEdge(
            { type: 'media-card', id: item.id },
            { input, element, allowedEdges: ['left', 'right'] },
          ),
        onDrag: ({ self }) => setClosestEdge(extractClosestEdge(self.data)),
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      }),
    );
  }, [item.id, draggableOn]);

  const openInNewTab = () => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const handleCopyLink = (e) => {
    e.stopPropagation();
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const containerClasses = [
    'relative aspect-square rounded-lg overflow-hidden bg-surface-container group transition-all',
    draggableOn ? 'cursor-grab active:cursor-grabbing' : '',
    dragging ? 'opacity-40' : '',
    selected ? 'ring-2 ring-primary' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={ref} className={containerClasses}>
      {/* Drop indicator — bar on the near edge of the target card */}
      {closestEdge && (
        <div
          className={`absolute top-1 bottom-1 w-1.5 rounded-full bg-primary z-20 ${
            closestEdge === 'left' ? 'left-0' : 'right-0'
          }`}
        />
      )}

      {isImage ? (
        <img
          src={thumbUrl}
          alt={item.alt_text || item.file_name}
          onClick={onView}
          className="w-full h-full object-cover block cursor-zoom-in"
          loading="lazy"
          draggable={false}
        />
      ) : isVideo && videoThumb ? (
        <div
          onClick={openInNewTab}
          role="link"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') openInNewTab();
          }}
          className="relative w-full h-full cursor-pointer"
          title={item.file_name}
        >
          <img
            src={videoThumb}
            alt={item.alt_text || item.file_name}
            className="w-full h-full object-cover block"
            loading="lazy"
            draggable={false}
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
            <div className="w-11 h-11 rounded-full bg-black/60 flex items-center justify-center">
              <Film className="w-5 h-5 text-white" />
            </div>
          </div>
        </div>
      ) : (
        <div
          onClick={openInNewTab}
          role="link"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') openInNewTab();
          }}
          className="w-full h-full flex flex-col items-center justify-center p-3 text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
        >
          {isVideo ? <Film className="w-10 h-10 mb-2" strokeWidth={1.5} /> : null}
          <span className="text-body-sm text-center break-words line-clamp-2 px-1">
            {item.file_name}
          </span>
          <ExternalLink className="w-3 h-3 mt-1 opacity-50" />
        </div>
      )}

      {/* Selection checkbox — top-left, always visible (editors only) */}
      {canEdit && (
        <label
          className="absolute top-2 left-2 z-10 cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            className="w-5 h-5 rounded border-2 border-white shadow-md cursor-pointer accent-primary"
            aria-label={`Select ${item.file_name}`}
          />
        </label>
      )}

      {item.is_primary && (
        <div className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-primary text-on-primary text-label-md font-semibold inline-flex items-center gap-1 z-10">
          <Star className="w-3 h-3 fill-current" />
          Primary
        </div>
      )}

      {/* Language tag — bottom-right. Editors get a selector; viewers see a
          short badge only when the image is language-specific. */}
      {canEdit ? (
        <select
          value={item.language ?? ''}
          onChange={(e) => onSetLanguage(e.target.value || null)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          draggable={false}
          aria-label="Image language"
          className="absolute bottom-2 right-2 z-10 max-w-[88px] text-label-md rounded bg-black/60 text-white border-0 pl-1.5 pr-1 py-0.5 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {IMAGE_LANGUAGES.map((l) => (
            <option key={l.id ?? 'universal'} value={l.id ?? ''} className="text-on-surface bg-surface">
              {l.label}
            </option>
          ))}
        </select>
      ) : item.language ? (
        <span className="absolute bottom-2 right-2 z-10 px-1.5 py-0.5 rounded bg-black/60 text-white text-label-md font-semibold">
          {langMeta(item.language).short}
        </span>
      ) : null}

      {/* Drag handle hint — editors only */}
      {canEdit && reorderEnabled && (
        <div className="absolute bottom-2 left-2 p-1 rounded bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          <GripVertical className="w-3.5 h-3.5" />
        </div>
      )}

      {/* Hover actions — copy link (everyone), set primary + remove (editors) */}
      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 pointer-events-none">
        <div className="flex gap-2 pointer-events-auto">
          <button
            type="button"
            onClick={handleCopyLink}
            className={`p-2 rounded-full transition-colors ${
              copied ? 'bg-primary text-on-primary' : 'bg-white/90 hover:bg-white text-neutral-800'
            }`}
            title={copied ? 'Link copied!' : 'Copy image link'}
          >
            {copied ? <Check className="w-4 h-4" /> : <Link2 className="w-4 h-4" />}
          </button>
          {canEdit && isImage && (
            <button
              type="button"
              onClick={onEditAlt}
              className="p-2 rounded-full bg-white/90 hover:bg-white text-neutral-800 transition-colors"
              title={item.alt_text ? `Alt text: ${item.alt_text}` : 'Add alt text'}
            >
              <Pencil className="w-4 h-4" />
            </button>
          )}
          {canEdit && isImage && !item.is_primary && (
            <button
              type="button"
              onClick={onSetPrimary}
              className="p-2 rounded-full bg-white/90 hover:bg-white text-neutral-800 transition-colors"
              title="Set as primary"
            >
              <Star className="w-4 h-4" />
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={onRemove}
              className="p-2 rounded-full bg-white/90 hover:bg-error hover:text-on-error text-neutral-800 transition-colors"
              title="Remove from product"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function VideoUrlDialog({ defaultLanguage, onClose, onAdd }) {
  const [url, setUrl] = useState('');
  const [language, setLanguage] = useState(defaultLanguage ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onAdd(url, language || null);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Add video by URL"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl bg-surface border border-outline-variant shadow-xl overflow-hidden"
      >
        <div className="px-5 py-4 flex items-center justify-between border-b border-outline-variant">
          <h3 className="text-title-md text-on-surface flex items-center gap-2">
            <Video className="w-4 h-4 text-primary" />
            Add video by URL
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-full text-on-surface-variant hover:bg-surface-container-low transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-body-sm text-on-surface-variant">
            Paste a YouTube, Vimeo, or direct video link. Nothing is uploaded — the PIM stores the
            link only.
          </p>
          <input
            autoFocus
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://youtube.com/watch?v=…"
            className="w-full px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          />
          <label className="flex items-center gap-2 text-label-md text-on-surface-variant">
            Language
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="px-2 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              {IMAGE_LANGUAGES.map((l) => (
                <option key={l.id ?? 'universal'} value={l.id ?? ''}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="text-body-sm text-error">{error}</p>}
        </div>

        <div className="px-5 py-3 flex items-center justify-end gap-2 border-t border-outline-variant bg-surface-container-lowest">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-full text-label-md text-on-surface hover:bg-surface-container-low transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Video className="w-4 h-4" />}
            Add video
          </button>
        </div>
      </form>
    </div>
  );
}

function AltTextDialog({ item, onClose, onSave }) {
  const [value, setValue] = useState(item.alt_text ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    await onSave(item.id, value.trim());
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Edit alt text"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl bg-surface border border-outline-variant shadow-xl overflow-hidden"
      >
        <div className="px-5 py-4 flex items-center justify-between border-b border-outline-variant">
          <h3 className="text-title-md text-on-surface flex items-center gap-2">
            <Pencil className="w-4 h-4 text-primary" />
            Alt text
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-full text-on-surface-variant hover:bg-surface-container-low transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="flex gap-3 mb-3">
            <div className="w-20 h-20 rounded-lg overflow-hidden bg-surface-container flex-shrink-0">
              <img
                src={getThumbnailUrl(item.storage_path, 160)}
                alt=""
                className="w-full h-full object-cover"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-body-sm text-on-surface truncate" title={item.file_name}>
                {item.file_name}
              </p>
              <p className="text-label-sm text-on-surface-variant mt-1">
                Describe the image for accessibility, SEO and marketplace feeds.
              </p>
            </div>
          </div>
          <textarea
            autoFocus
            rows={3}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. Brushed gold pull-down kitchen faucet, side view"
            className="w-full px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md resize-none focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          />
          <p className="text-label-sm text-on-surface-variant mt-1 text-right">{value.length} chars</p>
        </div>

        <div className="px-5 py-3 flex items-center justify-end gap-2 border-t border-outline-variant bg-surface-container-lowest">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-full text-label-md text-on-surface hover:bg-surface-container-low transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

function LinksDialog({ title, subtitle, items, onClose }) {
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedId, setCopiedId] = useState(null);

  // Close on Escape + lock the background page scroll while the modal is open
  // (otherwise the wheel scrolls the page behind instead of the modal list).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const allText = items.map((i) => i.url).join('\n');

  const copy = (text, onDone) => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(onDone);
  };

  const copyAll = () =>
    copy(allText, () => {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    });

  const copyOne = (item) =>
    copy(item.url, () => {
      setCopiedId(item.id);
      setTimeout(() => setCopiedId((cur) => (cur === item.id ? null : cur)), 1500);
    });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-lenis-prevent
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl bg-surface border border-outline-variant shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 flex items-center justify-between gap-4 border-b border-outline-variant">
          <div className="min-w-0">
            <h3 className="text-title-md text-on-surface truncate flex items-center gap-2">
              <Link2 className="w-4 h-4 text-primary flex-shrink-0" />
              {title}
            </h3>
            {subtitle && <p className="text-body-sm text-on-surface-variant mt-0.5">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors flex-shrink-0"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 py-2" data-lenis-prevent>
          {items.length === 0 ? (
            <p className="text-body-md text-on-surface-variant text-center py-10">No media to link.</p>
          ) : (
            <ul className="divide-y divide-outline-variant">
              {items.map((item) => {
                const isCopied = copiedId === item.id;
                return (
                  <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                    {/* Thumbnail / icon */}
                    <div className="w-12 h-12 rounded-md overflow-hidden bg-surface-container flex items-center justify-center flex-shrink-0">
                      {item.media_type === 'image' ? (
                        <img src={item.thumb} alt="" className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        <Film className="w-5 h-5 text-on-surface-variant" />
                      )}
                    </div>

                    {/* Name + URL */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-body-sm text-on-surface truncate" title={item.file_name}>
                          {item.file_name}
                        </span>
                        {item.is_primary && (
                          <Star className="w-3 h-3 text-primary fill-current flex-shrink-0" />
                        )}
                        {item.language && (
                          <span className="px-1 py-0.5 rounded bg-surface-container-high text-on-surface-variant text-label-sm font-semibold flex-shrink-0">
                            {langMeta(item.language).short}
                          </span>
                        )}
                      </div>
                      <p className="text-label-sm text-on-surface-variant font-mono truncate" title={item.url}>
                        {item.url}
                      </p>
                    </div>

                    {/* Copy one */}
                    <button
                      type="button"
                      onClick={() => copyOne(item)}
                      className={`p-2 rounded-full transition-colors flex-shrink-0 ${
                        isCopied
                          ? 'bg-primary text-on-primary'
                          : 'text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface'
                      }`}
                      title={isCopied ? 'Copied!' : 'Copy link'}
                    >
                      {isCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        {items.length > 0 && (
          <div className="px-5 py-3 flex items-center justify-between gap-3 border-t border-outline-variant bg-surface-container-lowest">
            <span className="text-label-md text-on-surface-variant">
              {items.length} link{items.length === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              onClick={copyAll}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-label-md font-semibold transition-colors ${
                copiedAll ? 'bg-primary text-on-primary' : 'bg-primary text-on-primary hover:opacity-90'
              }`}
            >
              {copiedAll ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copiedAll ? 'Copied all!' : `Copy all (${items.length})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DropboxIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M6 2L0 6l6 4 6-4-6-4zM18 2l-6 4 6 4 6-4-6-4zM0 14l6 4 6-4-6-4-6 4zM18 10l-6 4 6 4 6-4-6-4zM6 19l6 4 6-4-6-4-6 4z" />
    </svg>
  );
}
