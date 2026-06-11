import { useState } from 'react';
import { Star, Trash2, Film, ImagePlus, ExternalLink, X, GripVertical } from 'lucide-react';
import { useProductMedia } from '../hooks/useProductMedia';
import {
  addDropboxMedia,
  setPrimaryMedia,
  removeMedia,
  removeMediaBatch,
  reorderMedia,
  getMediaUrl,
} from '../api/media';
import Skeleton from '@/components/ui/Skeleton';
import { useConfirm } from '@/components/ui/ConfirmProvider';

export default function MediaSection({ sku }) {
  const confirm = useConfirm();
  const { images, videos, loading, error, reload, mutate } = useProductMedia(sku);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  // Visual media only, sorted by display_order
  const visualMedia = [...images, ...videos].sort(
    (a, b) => (a.display_order ?? 0) - (b.display_order ?? 0),
  );

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
          await addDropboxMedia(sku, files);
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

  const selectAllVisible = () =>
    setSelectedIds(new Set(visualMedia.map((m) => m.id)));

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

  // ---------------- Drag & drop ----------------

  const handleDragStart = (id) => (e) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', id);
    } catch {
      // Some browsers throw if dataTransfer is read-only — safe to ignore.
    }
  };

  const handleDragOver = (id) => (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverId !== id) setDragOverId(id);
  };

  const handleDragLeave = (id) => () => {
    if (dragOverId === id) setDragOverId(null);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverId(null);
  };

  const handleDrop = (targetId) => async (e) => {
    e.preventDefault();
    const sourceId = draggingId;
    setDraggingId(null);
    setDragOverId(null);
    if (!sourceId || sourceId === targetId) return;

    const fromIdx = visualMedia.findIndex((m) => m.id === sourceId);
    const toIdx = visualMedia.findIndex((m) => m.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    // Build the new visual order, then re-stitch with display_order indexes
    // and patch the in-memory media list optimistically.
    const reordered = [...visualMedia];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);

    const orderById = new Map(reordered.map((m, i) => [m.id, i]));
    mutate((prev) =>
      prev.map((m) =>
        orderById.has(m.id) ? { ...m, display_order: orderById.get(m.id) } : m,
      ),
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

      {selectedIds.size > 0 && (
        <div className="px-6 py-3 flex items-center justify-between gap-4 flex-wrap bg-primary-container/40 border-b border-outline-variant">
          <span className="text-body-md text-on-surface">
            {selectedIds.size} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={selectAllVisible}
              className="px-3 py-1.5 rounded-full bg-surface-container text-on-surface text-label-md hover:bg-surface-container-high transition-colors"
            >
              Select all ({visualMedia.length})
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
          <EmptyState onAddClick={openDropboxPicker} />
        ) : (
          <MediaGrid
            media={visualMedia}
            selectedIds={selectedIds}
            draggingId={draggingId}
            dragOverId={dragOverId}
            onToggleSelect={toggleSelect}
            onSetPrimary={handleSetPrimary}
            onRemove={handleRemove}
            onAddClick={openDropboxPicker}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDragEnd={handleDragEnd}
            onDrop={handleDrop}
          />
        )}
      </div>
    </section>
  );
}

function EmptyState({ onAddClick }) {
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

function MediaGrid({
  media,
  selectedIds,
  draggingId,
  dragOverId,
  onToggleSelect,
  onSetPrimary,
  onRemove,
  onAddClick,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDragEnd,
  onDrop,
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
      {media.map((item) => (
        <MediaCard
          key={item.id}
          item={item}
          selected={selectedIds.has(item.id)}
          isDragging={draggingId === item.id}
          isDragOver={dragOverId === item.id && draggingId !== item.id}
          onToggleSelect={() => onToggleSelect(item.id)}
          onSetPrimary={() => onSetPrimary(item.id)}
          onRemove={() => onRemove(item)}
          onDragStart={onDragStart(item.id)}
          onDragOver={onDragOver(item.id)}
          onDragLeave={onDragLeave(item.id)}
          onDragEnd={onDragEnd}
          onDrop={onDrop(item.id)}
        />
      ))}

      <button
        type="button"
        onClick={onAddClick}
        className="aspect-square rounded-lg border-2 border-dashed border-outline-variant hover:border-primary hover:bg-surface-container-low transition-colors flex flex-col items-center justify-center text-on-surface-variant hover:text-primary"
      >
        <ImagePlus className="w-8 h-8 mb-1" strokeWidth={1.5} />
        <span className="text-body-sm">Add more</span>
      </button>
    </div>
  );
}

function MediaCard({
  item,
  selected,
  isDragging,
  isDragOver,
  onToggleSelect,
  onSetPrimary,
  onRemove,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDragEnd,
  onDrop,
}) {
  const isImage = item.media_type === 'image';
  const isVideo = item.media_type === 'video';
  const url = getMediaUrl(item.storage_path);

  const openInNewTab = () => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const containerClasses = [
    'relative aspect-square rounded-lg overflow-hidden bg-surface-container group transition-all',
    isDragging ? 'opacity-40 scale-95' : '',
    isDragOver ? 'ring-2 ring-primary ring-offset-2 ring-offset-surface-container-lowest' : '',
    selected ? 'ring-2 ring-primary' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={containerClasses}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
    >
      {isImage ? (
        <img
          src={url}
          alt={item.alt_text || item.file_name}
          className="w-full h-full object-cover block pointer-events-none"
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
          {isVideo ? (
            <Film className="w-10 h-10 mb-2" strokeWidth={1.5} />
          ) : null}
          <span className="text-body-sm text-center break-words line-clamp-2 px-1">
            {item.file_name}
          </span>
          <ExternalLink className="w-3 h-3 mt-1 opacity-50" />
        </div>
      )}

      {/* Selection checkbox — top-left, always visible */}
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

      {item.is_primary && (
        <div className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-primary text-on-primary text-label-md font-semibold inline-flex items-center gap-1 z-10">
          <Star className="w-3 h-3 fill-current" />
          Primary
        </div>
      )}

      {/* Drag handle indicator — bottom-left, shown on hover */}
      <div className="absolute bottom-2 left-2 p-1 rounded bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        <GripVertical className="w-3.5 h-3.5" />
      </div>

      {/* Hover action overlay */}
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
