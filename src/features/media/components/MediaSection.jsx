import { useEffect, useRef, useState } from 'react';
import { Star, Trash2, Film, ImagePlus, ExternalLink, X, GripVertical } from 'lucide-react';
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import { attachClosestEdge, extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { useProductMedia } from '../hooks/useProductMedia';
import {
  addDropboxMedia,
  setPrimaryMedia,
  setMediaLanguage,
  removeMedia,
  removeMediaBatch,
  reorderMedia,
  getMediaUrl,
  getThumbnailUrl,
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
      message: 'The file stays in Dropbox.',
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
    const confirmed = await confirm({
      title: `Remove ${selectedIds.size} item${selectedIds.size === 1 ? '' : 's'}?`,
      message: 'The files stay in Dropbox.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;

    const ids = Array.from(selectedIds);
    setBusy(true);
    // Optimistic: drop the rows from local state immediately.
    mutate((prev) => prev.filter((m) => !selectedIds.has(m.id)));
    clearSelection();
    try {
      await removeMediaBatch(ids);
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

  return (
    <section className="rounded-xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-6 py-4 flex items-center justify-between border-b border-outline-variant gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="text-title-lg text-on-surface">Media</h2>
          {!loading && (
            <span className="text-body-sm text-on-surface-variant">
              {visualMedia.length} {visualMedia.length === 1 ? 'item' : 'items'}
            </span>
          )}
        </div>

        {canEdit && (
          <div className="flex items-center gap-2">
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
  onView,
}) {
  const ref = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState(null);
  const draggableOn = canEdit && reorderEnabled;

  const isImage = item.media_type === 'image';
  const isVideo = item.media_type === 'video';
  const url = getMediaUrl(item.storage_path);
  const thumbUrl = getThumbnailUrl(item.storage_path, 400);

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

      {/* Drag handle hint + hover actions — editors only */}
      {canEdit && (
        <>
          {reorderEnabled && (
            <div className="absolute bottom-2 left-2 p-1 rounded bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              <GripVertical className="w-3.5 h-3.5" />
            </div>
          )}

          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 pointer-events-none">
            <div className="flex gap-2 pointer-events-auto">
              {isImage && !item.is_primary && (
                <button
                  type="button"
                  onClick={onSetPrimary}
                  className="p-2 rounded-full bg-white/90 hover:bg-white text-on-surface transition-colors"
                  title="Set as primary"
                >
                  <Star className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={onRemove}
                className="p-2 rounded-full bg-white/90 hover:bg-red-600 hover:text-white text-on-surface transition-colors"
                title="Remove from product"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </>
      )}
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
