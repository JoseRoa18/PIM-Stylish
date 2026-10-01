import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

// The dialogs open right now, oldest first. Only the top one answers Escape
// and traps Tab — a confirm opened over a dialog used to close both.
const openDialogs = [];

// Controls that can take focus: enabled and actually rendered (a display:none
// field first or last in the panel let focus escape the trap).
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const focusablesIn = (panel) => [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);

/**
 * Shared modal shell. Handles backdrop click, Escape-to-close, initial focus,
 * and focus restore on close — so individual dialogs don't reimplement it.
 *
 * Props:
 *   onClose    — called on backdrop click, Escape, or the X button
 *   title      — header title (string or node)
 *   subtitle   — optional smaller line under the title (also read as the
 *                dialog's description)
 *   footer     — optional footer node (right-aligned flex row)
 *   maxWidth   — tailwind max-w class, default 'max-w-2xl'
 *   as         — wrapper element, 'div' (default) or 'form' (pass onSubmit too)
 *   ariaLabel  — accessible name when the dialog renders its own title in
 *                `children` instead of using the `title` prop (e.g. Confirm)
 *   ariaDescribedby — id of the element that describes the dialog (defaults
 *                to the subtitle)
 */
export default function Dialog({
  onClose,
  title,
  subtitle,
  footer,
  maxWidth = 'max-w-2xl',
  as = 'div',
  onSubmit,
  ariaLabel,
  ariaDescribedby,
  children,
}) {
  const panelRef = useRef(null);
  const titleId = useId();
  const subtitleId = useId();
  // The latest onClose, so a parent that passes a new function on every
  // render doesn't re-run the effect (which threw focus back to the first
  // field and briefly to the page behind).
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  // A backdrop click closes only when the press STARTED on the backdrop —
  // selecting text in a field and releasing outside used to close the dialog.
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const token = {};
    openDialogs.push(token);
    const isTop = () => openDialogs[openDialogs.length - 1] === token;

    // Lock background scroll while the modal is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus the first focusable element inside the panel (or the panel itself)
    const panel = panelRef.current;
    if (panel) {
      const target = focusablesIn(panel).find((el) => el.matches('input, select, textarea, button:not([data-dialog-close])'));
      (target ?? panel).focus();
    }

    function onKey(e) {
      if (!isTop()) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current?.();
      }
      // Minimal focus trap: keep Tab cycling inside the panel
      if (e.key === 'Tab' && panel) {
        const focusables = focusablesIn(panel);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      openDialogs.splice(openDialogs.indexOf(token), 1);
      document.body.style.overflow = prevOverflow;
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  const Panel = as;
  const describedBy = ariaDescribedby ?? (subtitle ? subtitleId : undefined);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 animate-fade-in"
      onMouseDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) onClose?.();
        pressedBackdrop.current = false;
      }}
      role="presentation"
      data-lenis-prevent
    >
      <Panel
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? ariaLabel : undefined}
        aria-describedby={describedBy}
        tabIndex={-1}
        onSubmit={onSubmit}
        className={`bg-surface rounded-2xl shadow-xl w-full ${maxWidth} max-h-[85vh] flex flex-col focus:outline-none animate-dialog-in`}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || subtitle) && (
          <header className="px-6 py-4 border-b border-outline-variant flex items-start justify-between gap-4">
            <div className="min-w-0">
              {title && <h2 id={titleId} className="text-title-lg text-on-surface">{title}</h2>}
              {subtitle && (
                <p id={subtitleId} className="text-body-sm text-on-surface-variant mt-0.5">{subtitle}</p>
              )}
            </div>
            <button
              type="button"
              data-dialog-close
              onClick={onClose}
              className="relative p-1.5 rounded-full text-on-surface-variant hover:bg-surface-container-low transition-colors flex-shrink-0 after:absolute after:-inset-1.5"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </header>
        )}

        <div className="overflow-y-auto flex-1 px-6 py-5">{children}</div>

        {footer && (
          <footer className="px-6 py-4 border-t border-outline-variant flex justify-end gap-2">
            {footer}
          </footer>
        )}
      </Panel>
    </div>
  );
}
