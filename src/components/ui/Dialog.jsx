import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

/**
 * Shared modal shell. Handles backdrop click, Escape-to-close, initial focus,
 * and focus restore on close — so individual dialogs don't reimplement it.
 *
 * Props:
 *   onClose    — called on backdrop click, Escape, or the X button
 *   title      — header title (string or node)
 *   subtitle   — optional smaller line under the title
 *   footer     — optional footer node (right-aligned flex row)
 *   maxWidth   — tailwind max-w class, default 'max-w-2xl'
 *   as         — wrapper element, 'div' (default) or 'form' (pass onSubmit too)
 *   ariaLabel  — accessible name when the dialog renders its own title in
 *                `children` instead of using the `title` prop (e.g. Confirm)
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
  children,
}) {
  const panelRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement;

    // Lock background scroll while the modal is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus the first focusable element inside the panel (or the panel itself)
    const panel = panelRef.current;
    if (panel) {
      const target = panel.querySelector(
        'input, select, textarea, button:not([data-dialog-close])',
      );
      (target ?? panel).focus();
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
      // Minimal focus trap: keep Tab cycling inside the panel
      if (e.key === 'Tab' && panel) {
        const focusables = panel.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
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
      document.body.style.overflow = prevOverflow;
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose]);

  const Panel = as;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 animate-fade-in"
      onClick={onClose}
      role="presentation"
      data-lenis-prevent
    >
      <Panel
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? ariaLabel : undefined}
        tabIndex={-1}
        onSubmit={onSubmit}
        className={`bg-surface rounded-2xl shadow-xl w-full ${maxWidth} max-h-[85vh] flex flex-col focus:outline-none animate-dialog-in`}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || subtitle) && (
          <header className="px-6 py-4 border-b border-outline-variant flex items-start justify-between gap-4">
            <div className="min-w-0">
              {title && <h3 id={titleId} className="text-title-lg text-on-surface">{title}</h3>}
              {subtitle && (
                <p className="text-body-sm text-on-surface-variant mt-0.5">{subtitle}</p>
              )}
            </div>
            <button
              type="button"
              data-dialog-close
              onClick={onClose}
              className="p-1.5 rounded-full text-on-surface-variant hover:bg-surface-container-low transition-colors flex-shrink-0"
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
