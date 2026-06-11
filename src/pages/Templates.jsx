import { useState, useRef } from 'react';
import {
  Upload,
  Trash2,
  FileSpreadsheet,
  Plus,
  Loader2,
  AlertCircle,
  X,
} from 'lucide-react';
import { useTemplates } from '@/features/templates/hooks/useTemplates';
import { uploadTemplate, deleteTemplate } from '@/features/templates/api/templates';
import { formatTimeAgo } from '@/lib/format';
import { useConfirm } from '@/components/ui/ConfirmProvider';

const MARKETPLACE_OPTIONS = [
  'BB&B / Overstock',
  'Amazon CA',
  'Amazon US',
  'Wayfair',
  'Home Depot',
  'Lowe\'s',
  'Rona',
  'Best Buy',
];

export default function Templates() {
  const { templates, loading, error, reload } = useTemplates();
  const [showUpload, setShowUpload] = useState(false);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-display-lg text-on-surface">Templates</h1>
          <p className="text-body-md text-on-surface-variant mt-1">
            Upload marketplace templates (XLSX/CSV) to generate pre-filled export files.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowUpload(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
        >
          <Plus className="w-4 h-4" />
          Upload Template
        </button>
      </header>

      {showUpload && (
        <UploadCard
          onDone={() => { setShowUpload(false); reload(); }}
          onCancel={() => setShowUpload(false)}
        />
      )}

      {loading && (
        <div className="flex items-center justify-center py-16 text-on-surface-variant">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading templates…
        </div>
      )}

      {error && (
        <div className="px-4 py-3 rounded-xl bg-error-container text-on-error-container text-body-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error.message}
        </div>
      )}

      {!loading && !error && templates.length === 0 && !showUpload && (
        <div className="rounded-xl border border-outline-variant bg-surface-container-lowest py-16 px-6 text-center">
          <FileSpreadsheet className="w-10 h-10 mx-auto mb-3 text-on-surface-variant opacity-40" strokeWidth={1.5} />
          <p className="text-body-lg text-on-surface mb-2">No templates uploaded yet</p>
          <p className="text-body-md text-on-surface-variant mb-6">
            Upload a marketplace template to start generating export files.
          </p>
          <button
            type="button"
            onClick={() => setShowUpload(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
          >
            <Upload className="w-4 h-4" />
            Upload your first template
          </button>
        </div>
      )}

      {!loading && templates.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((t) => (
            <TemplateCard key={t.id} template={t} onDelete={reload} />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({ template, onDelete }) {
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  async function handleDelete() {
    const ok = await confirm({
      title: `Delete the "${template.marketplace}" template?`,
      message: 'Product exports for this marketplace will stop working until a new template is uploaded.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteTemplate(template.id, template.storage_path);
      onDelete();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-tertiary-container text-on-tertiary-container flex items-center justify-center flex-shrink-0">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="text-body-md text-on-surface font-medium truncate">{template.marketplace}</p>
            <p className="text-body-sm text-on-surface-variant truncate">{template.file_name}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="p-1.5 rounded-full text-on-surface-variant hover:text-error hover:bg-error-container/40 transition-colors disabled:opacity-50"
          title="Delete template"
        >
          {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-label-md text-on-surface-variant">
        Uploaded {formatTimeAgo(template.uploaded_at)}
      </p>
      {error && <p className="text-body-sm text-error">{error}</p>}
    </div>
  );
}

function UploadCard({ onDone, onCancel }) {
  const [marketplace, setMarketplace] = useState('');
  const [customMarketplace, setCustomMarketplace] = useState('');
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const effectiveMarketplace = marketplace === '__custom__' ? customMarketplace.trim() : marketplace;
  const canSubmit = effectiveMarketplace && file && !uploading;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setUploading(true);
    setError(null);
    try {
      await uploadTemplate(effectiveMarketplace, file);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  function handleFileChange(e) {
    const f = e.target.files?.[0];
    if (f) setFile(f);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-outline-variant bg-surface-container-lowest p-6 space-y-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-title-lg text-on-surface">Upload Template</h2>
        <button type="button" onClick={onCancel} className="p-1 rounded-full hover:bg-surface-container-high transition-colors">
          <X className="w-5 h-5 text-on-surface-variant" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-label-md text-on-surface-variant">Marketplace</label>
          <select
            value={marketplace}
            onChange={(e) => setMarketplace(e.target.value)}
            className="px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
          >
            <option value="">Select a marketplace…</option>
            {MARKETPLACE_OPTIONS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            <option value="__custom__">Other…</option>
          </select>
          {marketplace === '__custom__' && (
            <input
              type="text"
              value={customMarketplace}
              onChange={(e) => setCustomMarketplace(e.target.value)}
              placeholder="Marketplace name"
              className="mt-1 px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
            />
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-label-md text-on-surface-variant">Template File</label>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-outline-variant bg-surface hover:bg-surface-container-low transition-colors text-body-md text-on-surface-variant"
          >
            <Upload className="w-4 h-4" />
            {file ? file.name : 'Choose .xlsx or .csv file…'}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-body-sm text-error">{error}</p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-body-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </form>
  );
}
