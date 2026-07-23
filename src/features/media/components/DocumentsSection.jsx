import { useState, useRef, lazy, Suspense } from 'react';
import { FileText, ExternalLink, Eye, Trash2, Plus, Link as LinkIcon, Check, Loader2, Upload } from 'lucide-react';
import { useProductMedia } from '../hooks/useProductMedia';
import { uploadDocumentFile, removeMedia, getMediaUrl, isSupabaseStored } from '../api/media';
import { formatFileSize } from '@/lib/format';
import Skeleton from '@/components/ui/Skeleton';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { useAuth } from '@/features/auth/AuthContext';

// Heavy (bundles PDF.js) — loaded only when a user previews a PDF.
const PdfPreviewModal = lazy(() => import('./PdfPreviewModal'));

const isPdfDoc = (doc) => {
  if (!doc) return false;
  if (doc.mime_type === 'application/pdf') return true;
  return /\.pdf(\?|#|$)/i.test(`${doc.file_name ?? ''} ${doc.storage_path ?? ''}`);
};

// Language variants for documents that ship in multiple languages
// (spec sheets, installation manuals). Order matters — English first.
const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'en_fr', label: 'English-French' },
  { id: 'en_es', label: 'English-Spanish' },
];

const DOCUMENT_TYPES = [
  {
    id: 'spec_sheet',
    label: 'Spec Sheet',
    extensions: ['.pdf'],
    description: 'Product specification PDF',
    languages: true,
  },
  {
    id: 'installation_manual',
    label: 'Installation Manual',
    extensions: ['.pdf'],
    description: 'Installation instructions PDF',
    languages: true,
  },
  {
    id: 'warranty_file',
    label: 'Warranty File',
    extensions: ['.pdf'],
    description: 'Warranty terms PDF',
  },
  {
    id: 'dxf_file',
    label: 'DXF File',
    extensions: ['.dxf'],
    description: 'CAD drawing for fabricators',
  },
  {
    id: 'cut_out_template',
    label: 'Cut Out Template',
    extensions: ['.pdf', '.dxf'],
    description: 'Countertop cutout template',
  },
];

// A "slot" is a (type, language) pair the UI can hold one document in.
// Non-language types use language = null. Spec sheets / manuals expand
// into one slot per language.
const slotKey = (typeId, language) => (language ? `${typeId}:${language}` : typeId);

const LANG_AWARE = new Set(DOCUMENT_TYPES.filter((t) => t.languages).map((t) => t.id));


// Faucets don't have CAD fabrication docs (DXF / cut-out template) — those are
// for stone fabricators cutting countertops for sinks.
const FAUCET_HIDDEN_TYPES = new Set(['dxf_file', 'cut_out_template']);

export default function DocumentsSection({ sku, category }) {
  const confirm = useConfirm();
  const isFaucet = category?.includes('faucet');
  const visibleTypes = DOCUMENT_TYPES.filter(
    (t) => !(isFaucet && FAUCET_HIDDEN_TYPES.has(t.id)),
  );
  const totalSlots = visibleTypes.reduce(
    (sum, t) => sum + (t.languages ? LANGUAGES.length : 1),
    0,
  );
  const { canEdit } = useAuth();
  const { documents, loading, error, reload } = useProductMedia(sku);
  const [busyKey, setBusyKey] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [previewDoc, setPreviewDoc] = useState(null);

  // Map docs by slot key. Language-aware types key on (type, language);
  // a legacy spec sheet/manual with no language defaults to the English
  // slot so existing files keep showing up after the migration.
  const docsBySlot = {};
  documents.forEach((d) => {
    if (!d.document_type) return;
    if (LANG_AWARE.has(d.document_type)) {
      docsBySlot[slotKey(d.document_type, d.language || 'en')] = d;
    } else {
      docsBySlot[d.document_type] = d;
    }
  });

  const handleUploadFile = async (docTypeConfig, language, file) => {
    if (!file) return;
    const key = slotKey(docTypeConfig.id, language);
    setErrorMessage(null);
    setBusyKey(key);
    try {
      const existing = docsBySlot[key];
      if (existing) await removeMedia(existing);
      await uploadDocumentFile(sku, docTypeConfig.id, file, language);
      reload();
    } catch (err) {
      setErrorMessage(err.message);
      console.error('Upload document error:', err);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemove = async (doc, label) => {
    const confirmed = await confirm({
      title: `Remove the ${label}?`,
      message: isSupabaseStored(doc.storage_path)
        ? 'This permanently deletes the file from Supabase storage too. This cannot be undone.'
        : 'The externally hosted file itself is not deleted.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await removeMedia(doc);
      reload();
    } catch (err) {
      setErrorMessage(err.message);
      console.error('Remove document error:', err);
    }
  };

  const linkedCount = Object.keys(docsBySlot).length;

  // Render one slot (type + optional language) as a document row.
  const renderSlot = (docType, language) => {
    const key = slotKey(docType.id, language);
    const langLabel = language ? LANGUAGES.find((l) => l.id === language)?.label : null;
    return (
      <DocumentRow
        key={key}
        label={langLabel ?? docType.label}
        description={langLabel ? `${docType.label} — ${langLabel}` : docType.description}
        doc={docsBySlot[key]}
        canEdit={canEdit}
        canPreview={isPdfDoc(docsBySlot[key])}
        busy={busyKey === key}
        accept={docType.extensions.join(',')}
        onPreview={() => setPreviewDoc(docsBySlot[key])}
        onUploadFile={(file) => handleUploadFile(docType, language, file)}
        onRemove={() => handleRemove(docsBySlot[key], langLabel ?? docType.label)}
      />
    );
  };

  return (
    <section className="rounded-xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-6 py-4 border-b border-outline-variant">
        <div className="flex items-center gap-3">
          <h2 className="text-title-lg text-on-surface">Documents</h2>
          <span className="text-body-sm text-on-surface-variant">
            {linkedCount} of {totalSlots} linked
          </span>
        </div>
      </div>

      {errorMessage && (
        <div className="px-6 py-3 bg-error-container text-on-error-container text-body-sm border-b border-outline-variant animate-banner-in">
          {errorMessage}
        </div>
      )}

      <div className="p-4 space-y-2">
        {loading ? (
          <>
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </>
        ) : error ? (
          <p className="text-body-md text-error p-4">
            Failed to load documents: {error.message}
          </p>
        ) : (
          visibleTypes.map((docType) =>
            docType.languages ? (
              <LanguageGroup
                key={docType.id}
                docType={docType}
                linkedCount={LANGUAGES.filter((l) => docsBySlot[slotKey(docType.id, l.id)]).length}
              >
                {LANGUAGES.map((lang) => renderSlot(docType, lang.id))}
              </LanguageGroup>
            ) : (
              renderSlot(docType, null)
            ),
          )
        )}
      </div>

      {previewDoc && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 animate-fade-in" data-lenis-prevent>
              <Loader2 className="w-8 h-8 animate-spin text-white" />
            </div>
          }
        >
          <PdfPreviewModal
            url={getMediaUrl(previewDoc.storage_path)}
            title={previewDoc.file_name}
            onClose={() => setPreviewDoc(null)}
          />
        </Suspense>
      )}
    </section>
  );
}

// Groups the per-language rows of a single document type under one heading.
function LanguageGroup({ docType, linkedCount, children }) {
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-low overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-outline-variant bg-surface-container">
        <FileText className="w-4 h-4 text-on-surface-variant" strokeWidth={1.5} />
        <span className="text-label-md text-on-surface font-semibold">{docType.label}</span>
        <span className="text-body-sm text-on-surface-variant">
          {linkedCount} of {LANGUAGES.length} languages
        </span>
      </div>
      <div className="p-2 space-y-2">{children}</div>
    </div>
  );
}

function DocumentRow({ label, description, doc, canEdit, canPreview, busy, accept, onPreview, onUploadFile, onRemove }) {
  const fileRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const linked = !!doc;

  const openInNewTab = () => {
    if (doc) window.open(getMediaUrl(doc.storage_path), '_blank', 'noopener,noreferrer');
  };

  const copyLink = () => {
    if (!doc || !navigator.clipboard) return;
    navigator.clipboard.writeText(getMediaUrl(doc.storage_path)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const iconBtn =
    'p-2 rounded-full text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors disabled:opacity-50';

  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-low">
      <div className="flex items-center gap-4 p-3">
        <div
          className={`w-10 h-10 rounded-md flex items-center justify-center flex-shrink-0 ${
            linked
              ? 'bg-primary-container text-on-primary-container'
              : 'bg-surface-container text-on-surface-variant'
          }`}
        >
          <FileText className="w-5 h-5" strokeWidth={1.5} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-label-md text-on-surface-variant">{label}</div>
          {linked ? (
            <div className="text-body-md text-on-surface truncate">
              {doc.file_name}
              {doc.file_size_bytes ? (
                <span className="text-body-sm text-on-surface-variant ml-2">
                  ({formatFileSize(doc.file_size_bytes)})
                </span>
              ) : null}
            </div>
          ) : (
            <div className="text-body-sm text-on-surface-variant italic">{description}</div>
          )}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Shared hidden file input for upload / replace */}
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            hidden
            onChange={(e) => {
              if (e.target.files?.[0]) onUploadFile(e.target.files[0]);
              e.target.value = '';
            }}
          />

          {linked ? (
            <>
              {canPreview && (
                <button
                  type="button"
                  onClick={onPreview}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-primary text-on-primary text-body-sm font-semibold hover:opacity-90 transition-opacity"
                  title="Preview PDF"
                >
                  <Eye className="w-3.5 h-3.5" />
                  Preview
                </button>
              )}
              <button type="button" onClick={openInNewTab} className={iconBtn} title="Open in new tab">
                <ExternalLink className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={copyLink}
                className={copied ? 'p-2 rounded-full bg-primary text-on-primary' : iconBtn}
                title={copied ? 'Link copied!' : 'Copy link'}
              >
                {copied ? <Check className="w-4 h-4" /> : <LinkIcon className="w-4 h-4" />}
              </button>
              {canEdit && (
                <>
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={busy}
                    className={iconBtn}
                    title="Replace — upload from your computer"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={onRemove}
                    disabled={busy}
                    className="p-2 rounded-full text-on-surface-variant hover:bg-error-container hover:text-error transition-colors disabled:opacity-50"
                    title="Remove"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </>
              )}
            </>
          ) : (
            canEdit && (
              <>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                  title="Upload from your computer"
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-primary text-on-primary text-body-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {busy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Upload className="w-3.5 h-3.5" />
                  )}
                  Upload
                </button>
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}
