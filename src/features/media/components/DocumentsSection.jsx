import { useState } from 'react';
import { FileText, ExternalLink, Trash2, Plus, Link as LinkIcon, X, Check, Loader2 } from 'lucide-react';
import { useProductMedia } from '../hooks/useProductMedia';
import { addDropboxDocument, addDocumentByUrl, removeMedia, getMediaUrl } from '../api/media';
import { formatFileSize } from '@/lib/format';
import Skeleton from '@/components/ui/Skeleton';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { useAuth } from '@/features/auth/AuthContext';

const DOCUMENT_TYPES = [
  {
    id: 'spec_sheet',
    label: 'Spec Sheet',
    extensions: ['.pdf'],
    description: 'Product specification PDF',
  },
  {
    id: 'installation_manual',
    label: 'Installation Manual',
    extensions: ['.pdf'],
    description: 'Installation instructions PDF',
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

export default function DocumentsSection({ sku }) {
  const confirm = useConfirm();
  const { canEdit } = useAuth();
  const { documents, loading, error, reload } = useProductMedia(sku);
  const [busyType, setBusyType] = useState(null);
  const [urlFormType, setUrlFormType] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);

  // Map docs by document_type
  const docsByType = {};
  documents.forEach((d) => {
    if (d.document_type) docsByType[d.document_type] = d;
  });

  const openPickerForType = (docTypeConfig) => {
    if (typeof window === 'undefined' || !window.Dropbox) {
      setErrorMessage('Dropbox Chooser is not loaded.');
      return;
    }

    setErrorMessage(null);
    setBusyType(docTypeConfig.id);

    window.Dropbox.choose({
      // 'preview' links are permanent; 'direct' links expire after ~4 hours.
      linkType: 'preview',
      multiselect: false,
      extensions: docTypeConfig.extensions,
      success: async (files) => {
        try {
          const existing = docsByType[docTypeConfig.id];
          if (existing) {
            await removeMedia(existing);
          }
          await addDropboxDocument(sku, docTypeConfig.id, files[0]);
          reload();
        } catch (err) {
          setErrorMessage(err.message);
          console.error('Add document error:', err);
        } finally {
          setBusyType(null);
        }
      },
      cancel: () => setBusyType(null),
    });
  };

  const handleAddByUrl = async (docTypeConfig, url) => {
    setErrorMessage(null);
    setBusyType(docTypeConfig.id);
    try {
      const existing = docsByType[docTypeConfig.id];
      if (existing) {
        await removeMedia(existing);
      }
      await addDocumentByUrl(sku, docTypeConfig.id, url);
      setUrlFormType(null);
      reload();
    } catch (err) {
      setErrorMessage(err.message);
    } finally {
      setBusyType(null);
    }
  };

  const handleRemove = async (doc, label) => {
    const confirmed = await confirm({
      title: `Remove the ${label}?`,
      message: 'The file stays in Dropbox.',
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

  return (
    <section className="rounded-xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-6 py-4 border-b border-outline-variant">
        <div className="flex items-center gap-3">
          <h2 className="text-title-lg text-on-surface">Documents</h2>
          <span className="text-body-sm text-on-surface-variant">
            {Object.keys(docsByType).length} of {DOCUMENT_TYPES.length} linked
          </span>
        </div>
      </div>

      {errorMessage && (
        <div className="px-6 py-3 bg-error-container text-on-error-container text-body-sm border-b border-outline-variant">
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
          DOCUMENT_TYPES.map((docType) => (
            <DocumentRow
              key={docType.id}
              docType={docType}
              doc={docsByType[docType.id]}
              canEdit={canEdit}
              busy={busyType === docType.id}
              showUrlForm={urlFormType === docType.id}
              onAdd={() => openPickerForType(docType)}
              onShowUrlForm={() => {
                setErrorMessage(null);
                setUrlFormType(urlFormType === docType.id ? null : docType.id);
              }}
              onSubmitUrl={(url) => handleAddByUrl(docType, url)}
              onRemove={() => handleRemove(docsByType[docType.id], docType.label)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function DocumentRow({ docType, doc, canEdit, busy, showUrlForm, onAdd, onShowUrlForm, onSubmitUrl, onRemove }) {
  const [url, setUrl] = useState('');
  const linked = !!doc;

  const openInNewTab = () => {
    if (doc) {
      window.open(getMediaUrl(doc.storage_path), '_blank', 'noopener,noreferrer');
    }
  };

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
          <div className="text-label-md text-on-surface-variant">
            {docType.label}
          </div>
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
            <div className="text-body-sm text-on-surface-variant italic">
              {docType.description}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {linked && (
            <button
              type="button"
              onClick={openInNewTab}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full border border-outline-variant text-body-sm text-on-surface hover:bg-surface-container transition-colors"
              title="Open in new tab"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open
            </button>
          )}
          {canEdit && (
            <>
              {linked && (
                <button
                  type="button"
                  onClick={onRemove}
                  className="p-2 rounded-full hover:bg-error-container text-on-surface-variant hover:text-error transition-colors"
                  title="Remove"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={onShowUrlForm}
                disabled={busy}
                className="p-2 rounded-full text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors disabled:opacity-50"
                title="Paste a URL instead"
              >
                <LinkIcon className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={onAdd}
                disabled={busy}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-primary text-on-primary text-body-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {busy ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Adding…
                  </>
                ) : linked ? (
                  'Replace'
                ) : (
                  <>
                    <Plus className="w-3.5 h-3.5" />
                    Add from Dropbox
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>

      {canEdit && showUrlForm && (
        <form
          className="flex items-center gap-2 px-3 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) onSubmitUrl(url);
          }}
        >
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste a Dropbox or web URL…"
            autoFocus
            className="flex-1 px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          />
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-primary text-on-primary text-body-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" />
            Save
          </button>
          <button
            type="button"
            onClick={onShowUrlForm}
            className="p-1.5 rounded-full text-on-surface-variant hover:bg-surface-container transition-colors"
            title="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </form>
      )}
    </div>
  );
}
