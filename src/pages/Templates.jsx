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
  // Beyond/Overstock has no Canadian platform — US only.
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

// Files uploaded as a set share a long export prefix ("StylishInternatio-
// Menards-…-") that eats the whole truncation budget and leaves every card
// reading identically. Stripping the common prefix keeps the part that
// actually distinguishes each file; cut back to a separator so no token is
// split mid-word.
function sharedFilePrefix(names) {
  if (names.length < 2) return '';
  let prefix = names[0];
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const cut = Math.max(...['-', '_', ' '].map((sep) => prefix.lastIndexOf(sep)));
  return cut < 7 ? '' : prefix.slice(0, cut + 1);
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
            Upload marketplace templates (XLSX, XLSM or CSV) to generate pre-filled export files.
          </p>
        </div>
        {/* The upload form is the page's primary action while open — showing
            a second live "Upload Template" CTA above it just duplicates it. */}
        {!showUpload && (
          <button
            type="button"
            onClick={() => setShowUpload(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
          >
            <Plus className="w-4 h-4" />
            Upload Template
          </button>
        )}
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
        <div className="px-4 py-3 rounded-xl bg-error-container text-on-error-container text-body-sm flex items-center gap-2 animate-banner-in">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error.message}
        </div>
      )}

      {!loading && !error && templates.length === 0 && !showUpload && (
        <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest py-16 px-6 text-center">
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

  // category set → templates. Labels are sorted before keying so the same set
  // of categories lands in ONE group regardless of the order each file stored
  // them; past 3 categories the joined label stops scanning, so it collapses
  // to a count.
  const byCategory = new Map();
  for (const t of templates) {
    const labels = (t.categories ?? []).map(templateCategoryLabel).sort((a, b) => a.localeCompare(b));
    const key = labels.length ? labels.join('|') : 'General · all products';
    if (!byCategory.has(key)) {
      byCategory.set(key, {
        key,
        labels,
        summaryLabel: labels.length === 0
          ? 'General · all products'
          : labels.length > 3
            ? `${labels.length} categories`
            : labels.join(' + '),
        items: [],
      });
    }
    byCategory.get(key).items.push(t);
  }
  const catGroups = [...byCategory.values()].sort((a, b) => a.summaryLabel.localeCompare(b.summaryLabel));
  const summary = catGroups.map((g) => `${g.summaryLabel} (${g.items.length})`).join(' · ');

  return (
    <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-surface-container transition-colors rounded-2xl"
      >
        <ChevronDown
          className={`w-4 h-4 text-on-surface-variant group-hover:text-primary flex-shrink-0 transition-[transform,color] duration-300 [transition-timing-function:var(--ease-out-quint)] ${open ? '' : '-rotate-90'}`}
        />
        <div className="w-10 h-10 rounded-lg bg-tertiary-container text-on-tertiary-container flex items-center justify-center flex-shrink-0">
          <FileSpreadsheet className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-body-md text-on-surface font-medium">{marketplace}</p>
          <p className="text-body-sm text-on-surface-variant truncate">{summary}</p>
        </div>
      </button>
      {/* Smooth expand/collapse without measuring: transition the grid track
          from 0fr to 1fr and clip the inner row. Enter 300ms ease-out, exit
          200ms ease-in (exits read faster); content fades slightly behind
          the height so it never pops. */}
      <div
        className={`grid transition-[grid-template-rows] ${
          open
            ? 'grid-rows-[1fr] duration-300 [transition-timing-function:var(--ease-out-quint)]'
            : 'grid-rows-[0fr] duration-200 ease-in'
        }`}
      >
        <div className="overflow-hidden min-h-0">
          <div
            className={`px-5 pb-5 pt-4 border-t border-outline-variant space-y-5 transition-opacity ${
              open ? 'opacity-100 duration-300 delay-75' : 'opacity-0 duration-150'
            }`}
          >
            {catGroups.map((group) => {
              const sharedPrefix = sharedFilePrefix(group.items.map((t) => t.file_name));
              return (
                <div key={group.key}>
                  <div className="flex flex-wrap items-center gap-1.5 mb-2">
                    {group.labels.length > 0 ? (
                      group.labels.map((l) => (
                        <span
                          key={l}
                          className="px-2 py-0.5 rounded-lg bg-secondary-container text-on-secondary-container text-label-sm"
                        >
                          {l}
                        </span>
                      ))
                    ) : (
                      <span className="text-label-md font-semibold text-on-surface-variant uppercase tracking-wide">
                        General · all products
                      </span>
                    )}
                    <span className="text-label-md text-on-surface-variant">
                      · {group.items.length} file{group.items.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  {/* auto-fill lets the grid decide how many cards fit (no
                      ~230px cards at 1024px); items-start keeps a neighbor
                      from stretching to match a card in edit mode. */}
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 items-start">
                    {group.items.map((t) => (
                      <TemplateCard key={t.id} template={t} sharedPrefix={sharedPrefix} reload={reload} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function TemplateCard({ template, sharedPrefix = '', reload }) {
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(template.categories ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const baseName = sharedPrefix && template.file_name.startsWith(sharedPrefix)
    ? template.file_name.slice(sharedPrefix.length)
    : template.file_name;
  const displayName = `${baseName === template.file_name ? '' : '…'}${baseName}`;
  // Split for CSS middle-truncation: the head ellipsizes to whatever width
  // the card really has, the distinctive tail ("…2026 (2).xlsx") stays
  // pinned. A space on the boundary moves into the tail so it can't be
  // swallowed as trailing whitespace.
  let tailChars = Math.min(13, Math.floor(displayName.length / 2));
  if (displayName[displayName.length - tailChars - 1] === ' ') tailChars += 1;
  const nameHead = displayName.slice(0, displayName.length - tailChars);
  const nameTail = displayName.slice(displayName.length - tailChars);

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
      title: `Delete "${middleTruncate(template.file_name, 40)}"?`,
      message: `${template.marketplace} exports that rely on this file will stop working until a new template is uploaded.`,
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
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {/* The tertiary tile stays on the group header — repeating it on
              every card is noise and steals width from the name. */}
          <FileSpreadsheet className="w-5 h-5 text-on-surface-variant flex-shrink-0" />
          <div className="min-w-0">
            {/* The group header already names the marketplace — the card's
                identity is the FILE. One truncation mechanism only: strip
                the prefix the whole set shares, then the head span
                ellipsizes to the real column width while the tail keeps
                the distinctive end; full name on hover. */}
            <p className="flex min-w-0 text-body-md text-on-surface font-medium" title={template.file_name}>
              <span className="truncate">{nameHead}</span>
              <span className="flex-shrink-0 whitespace-pre">{nameTail}</span>
            </p>
            <p className="text-body-sm text-on-surface-variant whitespace-nowrap">
              Uploaded {formatTimeAgo(template.uploaded_at)}
            </p>
          </div>
        </div>
        {/* Save/Cancel own the card while editing — a lone disabled trash can
            floating in the corner reads as a glitch, so hide both actions. */}
        {!editing && (
          <div className="flex items-center flex-shrink-0">
            <button
              type="button"
              onClick={startEdit}
              className="p-2 rounded-full text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors"
              title="Edit categories"
            >
              <Pencil className="w-4 h-4" />
            </button>
            <span aria-hidden="true" className="w-px h-4 bg-outline-variant mx-1" />
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="p-2 rounded-full text-on-surface-variant hover:text-error hover:bg-error-container/40 transition-colors disabled:opacity-50"
              title="Delete template"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            </button>
          </div>
        )}
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
      ) : null}
      {/* Category chips only show while editing — in view mode the card sits
          inside a section that already names its category. */}

      {error && <p className="text-body-sm text-error">{error}</p>}
    </div>
  );
}

function UploadCard({ onDone, onCancel }) {
  const [marketplace, setMarketplace] = useState('');
  const [customMarketplace, setCustomMarketplace] = useState('');
  const [categories, setCategories] = useState([]);
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const effectiveMarketplace = marketplace === '__custom__' ? customMarketplace.trim() : marketplace;
  const canSubmit = effectiveMarketplace && files.length > 0 && !uploading;

  function toggleCategory(value) {
    setCategories((prev) => (prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value]));
  }

  // Multi-file: sets like Menards ship 6+ workbooks for one marketplace and
  // category — one pass through the form uploads them all.
  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setUploading(true);
    setError(null);
    try {
      for (let i = 0; i < files.length; i++) {
        setProgress(i + 1);
        await uploadTemplate(effectiveMarketplace, files[i], categories);
      }
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  function handleFileChange(e) {
    const list = [...(e.target.files ?? [])];
    if (list.length) setFiles(list);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6 space-y-4"
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
          <label className="text-label-md text-on-surface-variant">Template file(s)</label>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xlsm,.xls,.csv"
            multiple
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-outline-variant bg-surface hover:bg-surface-container-low transition-colors text-body-md text-on-surface-variant"
          >
            <Upload className="w-4 h-4" />
            {files.length === 0
              ? 'Choose .xlsx, .xlsm or .csv files…'
              : files.length === 1
                ? files[0].name
                : `${files.length} files selected`}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-label-md text-on-surface-variant">
          Available for categories
        </label>
        {/* The general-template rule lives in the dynamic line under the
            chips — stating it here too said the same thing twice. */}
        <p className="text-body-sm text-on-surface-variant -mt-0.5 mb-1">
          The template only shows on products of the selected categories.
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
          {uploading
            ? files.length > 1 ? `Uploading ${progress}/${files.length}…` : 'Uploading…'
            : files.length > 1 ? `Upload ${files.length} files` : 'Upload'}
        </button>
      </div>
    </form>
  );
}
