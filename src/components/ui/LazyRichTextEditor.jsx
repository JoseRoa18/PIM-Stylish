import { lazy, Suspense } from 'react';

// TipTap/ProseMirror is ~360 kB — the heaviest part of the product page —
// and only needed once someone edits a description. This wrapper loads the
// editor on first use; meanwhile it shows the same box the editor itself
// renders while it mounts, so the layout does not jump.
// (preloadRichTextEditor.js warms the same chunk ahead of time.)
const RichTextEditor = lazy(() => import('./RichTextEditor'));

export default function LazyRichTextEditor(props) {
  const minRows = props.minRows ?? 4;
  return (
    <Suspense
      fallback={
        <div
          className="rounded-lg border border-outline-variant bg-surface-container-low/50"
          style={{ minHeight: `${minRows * 1.5 + 3}rem` }}
        />
      }
    >
      <RichTextEditor {...props} />
    </Suspense>
  );
}
