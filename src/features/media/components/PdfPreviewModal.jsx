import { usePDFSlick } from '@pdfslick/react';
import '@pdfslick/react/dist/pdf_viewer.css';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  ExternalLink,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  Maximize2,
} from 'lucide-react';
import Dialog from '@/components/ui/Dialog';

// PDFSlick's bundled worker path 404s under Vite (it points at a vendored copy
// without the .mjs extension), so PDF.js silently falls back to a non-working
// "fake worker" and renders nothing. Point pdf.js at the real worker via Vite's
// ?url asset import. pdfjs-dist is deduped, so this sets the worker on the same
// instance PDFSlick uses.
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Dropbox's www→content-host redirect breaks browser CORS, so PDF.js can't
// fetch the file directly. Route those through our edge proxy, which streams the
// PDF back with permissive CORS headers. Supabase-hosted PDFs already send
// `Access-Control-Allow-Origin: *`, so they load directly — no proxy hop.
function proxied(url) {
  const base = import.meta.env.VITE_SUPABASE_URL;
  if (!base || !url) return url;
  if (url.startsWith(base)) return url; // Supabase Storage — CORS-ready
  return `${base}/functions/v1/pdf-proxy?url=${encodeURIComponent(url)}`;
}

export default function PdfPreviewModal({ url, title, onClose }) {
  const { viewerRef, usePDFSlickStore, PDFSlickViewer } = usePDFSlick(proxied(url), {
    scaleValue: 'page-width',
  });

  return (
    <Dialog onClose={onClose} title={title} maxWidth="max-w-5xl">
      <Toolbar usePDFSlickStore={usePDFSlickStore} url={url} />
      <div className="relative h-[70vh] w-full rounded-lg overflow-hidden border border-outline-variant bg-surface-container-low">
        <PDFSlickViewer {...{ viewerRef, usePDFSlickStore }} />
      </div>
    </Dialog>
  );
}

function Toolbar({ usePDFSlickStore, url }) {
  const pdfSlick = usePDFSlickStore((s) => s.pdfSlick);
  const pageNumber = usePDFSlickStore((s) => s.pageNumber);
  const numPages = usePDFSlickStore((s) => s.numPages);
  const scale = usePDFSlickStore((s) => s.scale);
  const ready = Boolean(pdfSlick);

  const iconBtn =
    'p-1.5 rounded-lg text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
      {/* Page navigation */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={iconBtn}
          disabled={!ready || pageNumber <= 1}
          onClick={() => pdfSlick?.gotoPage(pageNumber - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-body-sm text-on-surface-variant tabular-nums min-w-[5rem] text-center">
          {ready ? `${pageNumber} / ${numPages || '…'}` : '…'}
        </span>
        <button
          type="button"
          className={iconBtn}
          disabled={!ready || pageNumber >= numPages}
          onClick={() => pdfSlick?.gotoPage(pageNumber + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Zoom + fit + open */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={iconBtn}
          disabled={!ready}
          onClick={() => pdfSlick?.decreaseScale()}
          aria-label="Zoom out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="text-body-sm text-on-surface-variant tabular-nums w-12 text-center">
          {ready ? `${Math.round((scale || 1) * 100)}%` : '—'}
        </span>
        <button
          type="button"
          className={iconBtn}
          disabled={!ready}
          onClick={() => pdfSlick?.increaseScale()}
          aria-label="Zoom in"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          type="button"
          className={iconBtn}
          disabled={!ready}
          onClick={() => {
            // PDFSlick's documented API for fit modes is a property setter on
            // the controller instance (not a reactive value to keep immutable).
            // eslint-disable-next-line react-hooks/immutability
            if (pdfSlick) pdfSlick.currentScaleValue = 'page-width';
          }}
          title="Fit width"
          aria-label="Fit width"
        >
          <Maximize2 className="w-4 h-4" />
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 ml-1 px-2.5 py-1.5 rounded-lg text-body-sm text-primary hover:bg-surface-container-high transition-colors"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Open
        </a>
      </div>
    </div>
  );
}
