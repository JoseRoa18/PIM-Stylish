import { useState, useRef } from 'react';
import {
  Upload,
  Trash2,
  FileSpreadsheet,
  Plus,
  Loader2,
  AlertCircle,
  X,
  Pencil,
  Check,
  ChevronDown,
} from 'lucide-react';
import { useTemplates } from '@/features/templates/hooks/useTemplates';
import {
  uploadTemplate,
  deleteTemplate,
  updateTemplateCategories,
  TEMPLATE_CATEGORIES,
  templateCategoryLabel,
} from '@/features/templates/api/templates';
import { formatTimeAgo } from '@/lib/format';
import { useConfirm } from '@/components/ui/ConfirmProvider';

const MARKETPLACE_OPTIONS = [
  'Wayfair CA',
  'Wayfair US',
  'Amazon CA',
  'Amazon US',
  'BB&B / Overstock CA',
  'BB&B / Overstock US',
  'Home Depot CA',
  'Home Depot US',
  'Lowe\'s CA',
  'Lowe\'s US',
  'Rona (CA)',
  'Best Buy CA',
  'Walmart CA',
  'Walmart US',
  'Menards',
];

// "StylishInternatio-Menards-…-KitchenSinks-Containers-07022026 (2).xlsx"
// → keep the start and the distinctive tail.
function middleTruncate(name, max) {
  const s = String(name ?? '');
  if (s.length <= max) return s;
  const tail = Math.floor((max - 1) / 2);
  const head = max - 1 - tail;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

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
        <div className="space-y-3">
          {[...new Map(templates.map((t) => [t.marketplace, true])).keys()].sort().map((marketplace) => (
            <MarketplaceGroup
              key={marketplace}
              marketplace={marketplace}
              templates={templates.filter((t) => t.marketplace === marketplace)}
              reload={reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One collapsible card per marketplace; on expand, its templates are grouped
// by category (Menards alone ships 7 files for a single category — a flat
// list would drown once more categories arrive).
function MarketplaceGroup({ marketplace, templates, reload }) {
  const [open, setOpen] = useState(false);

  // category key → templates (multi-category templates label with all of them)
  const byCategory = new Map();
  for (const t of templates) {
    const key = (t.categories ?? []).length ? t.categories.map(templateCategoryLabel).join(' + ') : 'General · all products';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(t);
  }
  const catGroups = [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
  const summary = catGroups.map(([label, list]) => `${label} (${list.length})`).join(' · ');

  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-surface-container-low transition-colors rounded-xl"
      >
        <ChevronDown
          className={`w-4 h-4 text-on-surface-variant flex-shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
        />
        <div className="w-10 h-10 rounded-lg bg-tertiary-container text-on-tertiary-container flex items-center justify-center flex-shrink-0">
          <FileSpreadsheet className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-body-md text-on-surface font-medium">{marketplace}</p>
          <p className="text-body-sm text-on-surface-variant truncate">{summary}</p>
        </div>
      </button>
      {open && (
        <div className="px-5 pb-5 pt-4 border-t border-outline-variant space-y-5">
          {catGroups.map(([label, list]) => (
            <div key={label}>
              <p className="text-label-md font-semibold text-on-surface-variant uppercase tracking-wide mb-2">
                {label} <span className="font-normal normal-case">· {list.length} file{list.length === 1 ? '' : 's'}</span>
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {list.map((t) => (
                  <TemplateCard key={t.id} template={t} reload={reload} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({ template, reload }) {
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(template.categories ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  function startEdit() {
    setDraft(template.categories ?? []);
    setError(null);
    setEditing(true);
  }

  function toggle(value) {
    setDraft((prev) => (prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value]));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await updateTemplateCategories(template.id, draft);
      setEditing(false);
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

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
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        {/* min-w-0 lets the name column shrink so truncate can kick in */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="w-10 h-10 rounded-lg bg-tertiary-container text-on-tertiary-container flex items-center justify-center flex-shrink-0">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="text-body-md text-on-surface font-medium truncate">{template.marketplace}</p>
            {/* Middle-truncate: Syndigo-style names only differ at the end
                ("…Containers-07022026 (2)"), so keep the tail visible.
                Full name on hover via title. */}
            <p className="text-body-sm text-on-surface-variant truncate" title={template.file_name}>
              {middleTruncate(template.file_name, 46)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {!editing && (
            <button
              type="button"
              onClick={startEdit}
              className="p-1.5 rounded-full text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors"
              title="Edit categories"
            >
              <Pencil className="w-4 h-4" />
            </button>
          )}
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || editing}
            className="p-1.5 rounded-full text-on-surface-variant hover:text-error hover:bg-error-container/40 transition-colors disabled:opacity-50"
            title="Delete template"
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <p className="text-label-md text-on-surface-variant">Available for categories (none = general):</p>
          <div className="flex flex-wrap gap-2">
            {TEMPLATE_CATEGORIES.map((c) => {
              const active = draft.includes(c.value);
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => toggle(c.value)}
                  className={`px-3 py-1 rounded-full border text-label-md transition-colors ${
                    active
                      ? 'bg-primary text-on-primary border-primary'
                      : 'border-outline-variant text-on-surface hover:bg-surface-container-low'
                  }`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2 mt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="px-3 py-1.5 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {template.categories?.length ? (
            template.categories.map((c) => (
              <span key={c} className="px-2 py-0.5 rounded-full bg-secondary-container text-on-secondary-container text-label-sm">
                {templateCategoryLabel(c)}
              </span>
            ))
          ) : (
            <span className="px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant text-label-sm">
              General · all products
            </span>
          )}
        </div>
      )}

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
  const [categories, setCategories] = useState([]);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const effectiveMarketplace = marketplace === '__custom__' ? customMarketplace.trim() : marketplace;
  const canSubmit = effectiveMarketplace && file && !uploading;

  function toggleCategory(value) {
    setCategories((prev) => (prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value]));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setUploading(true);
    setError(null);
    try {
      await uploadTemplate(effectiveMarketplace, file, categories);
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
            accept=".xlsx,.xlsm,.xls,.csv"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-outline-variant bg-surface hover:bg-surface-container-low transition-colors text-body-md text-on-surface-variant"
          >
            <Upload className="w-4 h-4" />
            {file ? file.name : 'Choose .xlsx, .xlsm or .csv file…'}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-label-md text-on-surface-variant">
          Available for categories
        </label>
        <p className="text-body-sm text-on-surface-variant -mt-0.5 mb-1">
          The template only shows on products of the selected categories. Leave all unchecked for a general template (available on every product).
        </p>
        <div className="flex flex-wrap gap-2">
          {TEMPLATE_CATEGORIES.map((c) => {
            const active = categories.includes(c.value);
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => toggleCategory(c.value)}
                className={`px-3 py-1.5 rounded-full border text-label-md transition-colors ${
                  active
                    ? 'bg-primary text-on-primary border-primary'
                    : 'border-outline-variant text-on-surface hover:bg-surface-container-low'
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        {categories.length === 0 && (
          <p className="text-label-md text-on-surface-variant mt-1">General — available on all products.</p>
        )}
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
