import { useState, useRef, lazy, Suspense } from 'react';
import { FileText, ExternalLink, Eye, Trash2, Loader2, Upload, ChevronDown } from 'lucide-react';
import { MorphIcon } from 'morphicons/react';
import { Link as LinkGlyph, Check as CheckGlyph } from 'lucide';
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
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'fr', label: 'French', short: 'FR' },
  { id: 'en_fr', label: 'English-French', short: 'EN-FR' },
  { id: 'en_es', label: 'English-Spanish', short: 'EN-ES' },
];

// Sink installation manuals AND DXF files split by installation type: a
// Dual Mount sink carries THREE of each (undermount + drop-in + dual
// mount). Manuals keep their language variants; DXFs are CAD files with no
// language. The generic 'installation_manual' / 'dxf_file' stay for
// faucets, accessories and legacy sink docs.
const INSTALL_MANUAL_TYPES = {
  undermount: { id: 'installation_undermount', label: 'Installation Manual — Undermount' },
  drop_in: { id: 'installation_drop_in', label: 'Installation Manual — Drop-In' },
  dual_mount: { id: 'installation_dual_mount', label: 'Installation Manual — Dual Mount' },
  top_mount: { id: 'installation_top_mount', label: 'Installation Manual — Top Mount' },
};
const DXF_TYPES = {
  undermount: { id: 'dxf_undermount', label: 'DXF File — Undermount' },
  drop_in: { id: 'dxf_drop_in', label: 'DXF File — Drop-In' },
  dual_mount: { id: 'dxf_dual_mount', label: 'DXF File — Dual Mount' },
  top_mount: { id: 'dxf_top_mount', label: 'DXF File — Top Mount' },
};
const manualKindsFor = (installationType) => {
  const t = String(installationType ?? '').toLowerCase();
  if (/dual/.test(t)) return ['undermount', 'drop_in', 'dual_mount'];
  if (/under/.test(t)) return ['undermount'];
  if (/drop|top.?mount/.test(t) && /top/.test(t)) return ['top_mount'];
  if (/drop/.test(t)) return ['drop_in'];
  if (/top/.test(t)) return ['top_mount'];
  return [];
};

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

const LANG_AWARE = new Set([
  ...DOCUMENT_TYPES.filter((t) => t.languages).map((t) => t.id),
  ...Object.values(INSTALL_MANUAL_TYPES).map((t) => t.id),
  // DXF_TYPES stay OUT: CAD files carry no language variants.
]);


// Faucets don't have CAD fabrication docs (DXF / cut-out template) — those are
// for stone fabricators cutting countertops for sinks.
const FAUCET_HIDDEN_TYPES = new Set(['dxf_file', 'cut_out_template']);

export default function DocumentsSection({ sku, category, familyNumber = null, installationType = null }) {
  const confirm = useConfirm();
  // Documents are family-shared: uploads land on every variant of the family
  // (replacing the slot family-wide) and removals clear them family-wide.
  // EXCEPT sinks — their variants differ in gauge/mount, so documents stay
  // per-product. Only used for messaging — the API resolves this itself.
  const inFamily = familyNumber != null && !category?.includes('sink');
  const isFaucet = category?.includes('faucet');
  const isSink = category?.includes('sink');
  const { documents, loading, error, reload } = useProductMedia(sku);

  // Sinks: the Installation Manual and DXF groups expand into one entry per
  // manual/DXF the product's installation type requires (Dual Mount → three
  // of each). The generic groups only remain visible while legacy docs
  // still sit in them.
  const manualKinds = isSink ? manualKindsFor(installationType) : [];
  const hasLegacy = (typeId) => documents.some((d) => d.document_type === typeId);
  const visibleTypes = DOCUMENT_TYPES.filter(
    (t) => !(isFaucet && FAUCET_HIDDEN_TYPES.has(t.id)),
  ).flatMap((t) => {
    if (manualKinds.length === 0) return [t];
    if (t.id === 'installation_manual') {
      const perType = manualKinds.map((k) => ({
        id: INSTALL_MANUAL_TYPES[k].id,
        label: INSTALL_MANUAL_TYPES[k].label,
        extensions: ['.pdf'],
        description: `${INSTALL_MANUAL_TYPES[k].label} PDF`,
        languages: true,
      }));
      return hasLegacy(t.id) ? [...perType, { ...t, label: 'Installation Manual (generic)' }] : perType;
    }
    if (t.id === 'dxf_file') {
      const perType = manualKinds.map((k) => ({
        id: DXF_TYPES[k].id,
        label: DXF_TYPES[k].label,
        extensions: ['.dxf'],
        description: `${DXF_TYPES[k].label} — CAD drawing for fabricators`,
      }));
      return hasLegacy(t.id) ? [...perType, { ...t, label: 'DXF File (generic)' }] : perType;
    }
    return [t];
  });
  const totalSlots = visibleTypes.reduce(
    (sum, t) => sum + (t.languages ? LANGUAGES.length : 1),
    0,
  );
  const { canEditMedia: canEdit } = useAuth();
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
      // uploadDocumentFile replaces the (type, language) slot across the whole
      // variant family — no need to pre-delete the existing document here.
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
    const sharedNote = inFamily
      ? ' The document is also removed from every variant of this family.'
      : '';
    const confirmed = await confirm({
      title: `Remove the ${label}?`,
      message: isSupabaseStored(doc.storage_path)
        ? `This permanently deletes the file.${sharedNote} This cannot be undone.`
        : `The externally hosted file itself is not deleted.${sharedNote}`,
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
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-title-lg text-on-surface">Documents</h2>
          <span className="text-body-sm text-on-surface-variant">
            {linkedCount} of {totalSlots} linked
          </span>
          {inFamily && (
            <span className="text-body-sm text-on-surface-variant">
              · Shared with all variants in this family
            </span>
          )}
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
          // Language-aware types render as collapsible groups whose header
          // chips show completion at a glance; consecutive language-less
          // types (DXFs, warranty, cut-out) pack into a two-column grid so
          // single slots don't each claim a full row.
          (() => {
            const blocks = [];
            let singles = [];
            const flushSingles = () => {
              if (!singles.length) return;
              blocks.push(
                <div key={`singles-${blocks.length}`} className="grid sm:grid-cols-2 gap-2">
                  {singles.map((t) => renderSlot(t, null))}
                </div>,
              );
              singles = [];
            };
            for (const docType of visibleTypes) {
              if (docType.languages) {
                flushSingles();
                blocks.push(
                  <LanguageGroup
                    key={docType.id}
                    docType={docType}
                    linkedLangs={new Set(LANGUAGES.filter((l) => docsBySlot[slotKey(docType.id, l.id)]).map((l) => l.id))}
                  >
                    {LANGUAGES.map((lang) => renderSlot(docType, lang.id))}
                  </LanguageGroup>,
                );
              } else {
                singles.push(docType);
              }
            }
            flushSingles();
            return blocks;
          })()
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

// Collapsible group for a language-aware document type. The header chips ARE
// the status: a filled chip per uploaded language, a ghost chip per missing
// one — completion reads at a glance without expanding anything.
function LanguageGroup({ docType, linkedLangs, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-low overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-container transition-colors"
      >
        <ChevronDown
          className={`w-4 h-4 text-on-surface-variant flex-shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
        />
        <FileText className="w-4 h-4 text-on-surface-variant flex-shrink-0" strokeWidth={1.5} />
        <span className="text-body-md text-on-surface font-semibold flex-1 min-w-0 truncate">
          {docType.label}
        </span>
        <span className="flex items-center gap-1.5 flex-shrink-0">
          {LANGUAGES.map((l) =>
            linkedLangs.has(l.id) ? (
              <span
                key={l.id}
                title={`${l.label} — uploaded`}
                className="px-1 py-px rounded-sm bg-primary-container text-on-primary-container text-[10px] leading-4 font-semibold tracking-wide"
              >
                {l.short}
              </span>
            ) : (
              <span
                key={l.id}
                title={`${l.label} — missing`}
                className="px-1 py-px rounded-sm border border-outline-variant text-on-surface-variant/70 text-[10px] leading-4 tracking-wide"
              >
                {l.short}
              </span>
            ),
          )}
        </span>
      </button>
      <div className={open ? 'px-2 pb-2 space-y-1.5' : 'hidden'}>{children}</div>
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

  const fileInput = (
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
  );

  // Empty slot: a quiet one-line ghost — the section should be dominated by
  // the files that exist, not by the holes.
  if (!linked) {
    return (
      <div
        className="flex items-center gap-3 px-3 py-2 rounded-lg border border-dashed border-outline-variant text-on-surface-variant"
        title={description}
      >
        <FileText className="w-4 h-4 flex-shrink-0 opacity-60" strokeWidth={1.5} />
        <span className="flex-1 min-w-0 truncate text-body-sm">{label}</span>
        {canEdit && (
          <>
            {fileInput}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              title="Upload from your computer"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-outline-variant text-label-md text-on-surface-variant hover:text-primary hover:border-primary transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              Upload
            </button>
          </>
        )}
      </div>
    );
  }

  // Filled slot: solid card, file name first, full action set.
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-low">
      <div className="flex items-center gap-3 p-2.5">
        <div className="w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 bg-primary-container text-on-primary-container">
          <FileText className="w-4 h-4" strokeWidth={1.5} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-label-sm text-on-surface-variant">{label}</div>
          <div className="text-body-sm text-on-surface truncate">
            {doc.file_name}
            {doc.file_size_bytes ? (
              <span className="text-label-sm text-on-surface-variant ml-2">
                ({formatFileSize(doc.file_size_bytes)})
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center flex-shrink-0">
          {fileInput}
          {canPreview && (
            <button type="button" onClick={onPreview} className={iconBtn} title="Preview PDF">
              <Eye className="w-4 h-4" />
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
            <MorphIcon icon={copied ? CheckGlyph : LinkGlyph} size={16} reducedMotion="user" />
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
        </div>
      </div>
    </div>
  );
}
