import { useRef, useState } from 'react';

/**
 * A file picker that is also a drop target: click to browse, or drag the
 * file straight from Explorer. The caller supplies the inner content; this
 * wrapper adds the hidden input, the drop handlers, and a highlight while a
 * file is hovering. Extension checking runs on drop too — the input's
 * `accept` attribute only filters the browse dialog, never a drop.
 */
export default function FileDropzone({ onFile, onFiles, multiple = false, accept = '', disabled = false, className = '', children }) {
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState(null);
  // Enter/leave fire for every child node — a counter beats flicker.
  const depth = useRef(0);

  const extensions = accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.startsWith('.'));

  // One file by default; with `multiple` every accepted file goes to
  // onFiles at once (a set of workbooks dropped together).
  function acceptFiles(fileList) {
    const list = [...(fileList ?? [])].filter(Boolean);
    if (!list.length) return;
    const ok = (f) => !extensions.length || extensions.some((ext) => f.name.toLowerCase().endsWith(ext));
    const rejected = list.filter((f) => !ok(f));
    if (rejected.length) {
      setDropError(`Only ${extensions.join(' / ')} files — got "${rejected[0].name}"${rejected.length > 1 ? ` and ${rejected.length - 1} more` : ''}.`);
      if (!multiple) return;
    } else {
      setDropError(null);
    }
    const valid = list.filter(ok);
    if (!valid.length) return;
    if (multiple) onFiles?.(valid);
    else onFile?.(valid[0]);
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
          if (!disabled) acceptFiles(multiple ? e.dataTransfer.files : [e.dataTransfer.files?.[0]]);
        }}
        className={`${className} ${dragging ? 'ring-2 ring-primary border-primary bg-primary-container/20' : ''} ${disabled ? 'opacity-40 pointer-events-none' : 'cursor-pointer'}`}
      >
        {children}
        <input
          type="file"
          accept={accept}
          multiple={multiple}
          className="hidden"
          disabled={disabled}
          onChange={(e) => {
            const picked = multiple ? [...e.target.files] : [e.target.files?.[0]];
            e.target.value = '';
            acceptFiles(picked);
          }}
        />
      </label>
      {dropError && (
        <p className="mt-1.5 text-body-sm text-error">{dropError}</p>
      )}
    </div>
  );
}
