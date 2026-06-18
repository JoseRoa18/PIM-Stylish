import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Dialog from './Dialog';

const ConfirmContext = createContext(null);

/**
 * App-wide confirmation dialog. Replaces window.confirm with a styled,
 * promise-based dialog:
 *
 *   const confirm = useConfirm();
 *   const ok = await confirm({
 *     title: 'Remove document?',
 *     message: 'The file stays in Dropbox.',
 *     confirmLabel: 'Remove',
 *     destructive: true,
 *   });
 */
export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null);
  const resolverRef = useRef(null);

  const confirm = useCallback((options) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setRequest({
        title: options?.title ?? 'Are you sure?',
        message: options?.message ?? null,
        confirmLabel: options?.confirmLabel ?? 'Confirm',
        cancelLabel: options?.cancelLabel ?? 'Cancel',
        destructive: options?.destructive ?? false,
      });
    });
  }, []);

  const settle = useCallback((answer) => {
    resolverRef.current?.(answer);
    resolverRef.current = null;
    setRequest(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <Dialog
          onClose={() => settle(false)}
          ariaLabel={request.title}
          maxWidth="max-w-md"
          footer={
            <>
              <button
                type="button"
                onClick={() => settle(false)}
                className="px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors"
              >
                {request.cancelLabel}
              </button>
              <button
                type="button"
                onClick={() => settle(true)}
                className={`px-5 py-2 rounded-full text-body-md font-semibold hover:opacity-90 transition-opacity ${
                  request.destructive
                    ? 'bg-error text-on-error'
                    : 'bg-primary text-on-primary'
                }`}
              >
                {request.confirmLabel}
              </button>
            </>
          }
        >
          <div className="flex items-start gap-3">
            <div
              className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                request.destructive
                  ? 'bg-error-container text-error'
                  : 'bg-primary-container text-on-primary-container'
              }`}
            >
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="min-w-0 pt-1">
              <h3 className="text-title-md text-on-surface">{request.title}</h3>
              {request.message && (
                <p className="text-body-sm text-on-surface-variant mt-1.5 whitespace-pre-line">
                  {request.message}
                </p>
              )}
            </div>
          </div>
        </Dialog>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error('useConfirm must be used inside <ConfirmProvider>.');
  }
  return confirm;
}
