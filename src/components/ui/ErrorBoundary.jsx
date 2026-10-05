import { Component } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

// A file of a build that is no longer deployed (a tab opened before a
// deploy): reloading picks up the current one.
const NEW_VERSION_RE = /dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError|error loading dynamically imported/i;

/**
 * Keeps a crash in one screen from blanking the whole PIM (2026-10-05: an
 * editor error on the product page left the window white). The screen is
 * replaced by a message with Reload / Go to Dashboard; the sidebar and the
 * top bar keep working. `resetKey` (the route) clears it when the person
 * navigates away; `fullScreen` is the app-wide variant around everything.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[PIM] A screen crashed:', error, info?.componentStack ?? '');
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const message = String(error?.message ?? error ?? 'Unknown error');
    const newVersion = NEW_VERSION_RE.test(message);
    const box = (
      <div role="alert" className="max-w-xl w-full rounded-2xl border border-outline-variant bg-surface p-8 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-error-container text-on-error-container flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-3">
            <h1 className="text-headline-sm text-on-surface">
              {newVersion ? 'A new version of the PIM is available' : 'Something went wrong on this page'}
            </h1>
            <p className="text-body-md text-on-surface-variant">
              {newVersion
                ? 'Reload to get it. Your saved work is not affected.'
                : 'The rest of the PIM still works. Reload the page to try again — changes you had not saved on this page may be lost. If it happens again, tell us what you were doing.'}
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-lg font-semibold hover:opacity-90 transition-opacity"
              >
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
                Reload page
              </button>
              <a
                href="/"
                className="inline-flex items-center px-4 py-2 rounded-full border border-outline-variant text-label-lg font-medium text-on-surface hover:bg-surface-container-low transition-colors"
              >
                Go to Dashboard
              </a>
            </div>
            {!newVersion && (
              <details className="pt-1">
                <summary className="cursor-pointer text-label-md text-on-surface-variant hover:text-on-surface">Technical details</summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-surface-container-low p-3 text-body-sm text-on-surface-variant whitespace-pre-wrap break-words">{message}</pre>
              </details>
            )}
          </div>
        </div>
      </div>
    );
    if (this.props.fullScreen) {
      return <div className="min-h-screen bg-background flex items-center justify-center p-4">{box}</div>;
    }
    return <div className="flex justify-center py-16">{box}</div>;
  }
}
