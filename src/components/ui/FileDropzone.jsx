import { useRef, useState } from 'react';

/**
 * A file picker that is also a drop target: click to browse, or drag the
 * file straight from Explorer. The caller supplies the inner content; this
 * wrapper adds the hidden input, the drop handlers, and a highlight while a
 * file is hovering. Extension checking runs on drop too — the input's
 * `accept` attribute only filters the browse dialog, never a drop.
 */
export default function FileDropzone({ onFile, accept = '', disabled = false, className = '', children }) {
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState(null);
  // Enter/leave fire for every child node — a counter beats flicker.
  const depth = useRef(0);

  const extensions = accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.startsWith('.'));

  function acceptFile(file) {
    if (!file) return;
    if (extensions.length && !extensions.some((ext) => file.name.toLowerCase().endsWith(ext))) {
      setDropError(`Only ${extensions.join(' / ')} files — got "${file.name}".`);
      return;
    }
    setDropError(null);
    onFile(file);
  }

  return (
    <div>
      <label
        onDragEnter={(e) => {
          e.preventDefault();
          if (disabled) return;
          depth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          depth.current = 0;
          setDragging(false);
          if (!disabled) acceptFile(e.dataTransfer.files?.[0]);
        }}
        className={`${className} ${dragging ? 'ring-2 ring-primary border-primary bg-primary-container/20' : ''} ${disabled ? 'opacity-40 pointer-events-none' : 'cursor-pointer'}`}
      >
        {children}
        <input
          type="file"
          accept={accept}
          className="hidden"
          disabled={disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            acceptFile(file);
          }}
        />
      </label>
      {dropError && (
        <p className="mt-1.5 text-body-sm text-error">{dropError}</p>
      )}
    </div>
  );
}
