import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Send,
  RotateCcw,
  Plus,
  Trash2,
  ChevronDown,
  Info,
  DollarSign,
  Eye,
  Truck,
  Tag,
  FileText,
  X,
  Search,
  ImageIcon,
} from 'lucide-react';
import { formatTimeAgo } from '@/lib/format';
import { pushProductToWix, readWixProduct } from '../api/wixSync';
import { useWixCollections } from '../hooks/useWixCollections';
import RichTextEditor from '@/components/ui/RichTextEditor';
import ProductHealthBadge from '@/features/dashboard/components/ProductHealthBadge';

// Each group has an icon and a short summary string. Colors stay on the
// brand palette — accents come from interaction state, not per-section hues.
const FIELD_GROUPS = [
  {
    key: 'basic',
    title: 'Basic info',
    icon: Info,
    summary: 'Name, brand, ribbon, description',
    fields: [
      { key: 'model_name', label: 'Name (in Wix)', type: 'text' },
      { key: 'brand', label: 'Brand', type: 'text' },
      { key: 'ribbon', label: 'Ribbon', type: 'text', hint: 'Small label like "New Arrival" shown over the product card.' },
      { key: 'description', label: 'Description', type: 'richtext', rows: 8 },
    ],
  },
  {
    key: 'pricing',
    title: 'Pricing',
    icon: DollarSign,
    summary: 'Price, sale, cost of goods',
    fields: [
      { key: 'msrp_cad', label: 'Price (CAD)', type: 'currency' },
      { key: 'on_sale', label: 'On sale', type: 'boolean', hint: 'Show a discounted price on the Wix store.' },
      { key: 'sale_price_cad', label: 'Sale price (CAD)', type: 'currency', dependsOn: 'on_sale' },
      { key: 'dealer_cost_cad', label: 'Cost of goods (CAD)', type: 'currency', hint: 'Internal — used to compute profit and margin in Wix.' },
    ],
  },
  {
    key: 'visibility',
    title: 'Visibility',
    icon: Eye,
    summary: 'Online store, Point of Sale',
    fields: [
      { key: 'visible_online', label: 'Show in online store', type: 'boolean' },
      { key: 'visible_pos', label: 'Show in Point of Sale', type: 'boolean', notPushed: true },
    ],
  },
  {
    key: 'shipping',
    title: 'Shipping & fulfillment',
    icon: Truck,
    summary: 'Weight, pre-order',
    fields: [
      { key: 'shipping_weight_lb', label: 'Shipping weight (lb)', type: 'number' },
      { key: 'pre_order', label: 'Available for pre-order', type: 'boolean', notPushed: true },
    ],
  },
  {
    key: 'categories',
    title: 'Categories',
    icon: Tag,
    summary: 'Wix collections this product belongs to',
    fields: [
      { key: 'wix_collection_ids', label: 'Wix categories', type: 'collections' },
    ],
  },
  {
    key: 'sections',
    title: 'Additional info sections',
    icon: FileText,
    summary: 'Dimensions, features, documents',
    fields: [
      { key: 'additional_info_sections', label: 'Sections', type: 'sections' },
    ],
  },
];

const ALL_FIELD_KEYS = FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.key));

export default function WixSyndicationCard({ product, media, onUpdate }) {
  const [form, setForm] = useState(() => buildForm(product));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [openGroups, setOpenGroups] = useState(() => new Set());
  // Card expansion — collapsed by default; user expands to see/edit fields.
  const [cardExpanded, setCardExpanded] = useState(false);

  // Live Wix data — the form shows what's in Wix right now.
  // wixBaseline = the unedited Wix values (for detecting user edits).
  const [wixBaseline, setWixBaseline] = useState(null);
  const [wixMedia, setWixMedia] = useState(null);
  const [wixLoading, setWixLoading] = useState(false);

  const linked = Boolean(product?.wix_product_id);

  useEffect(() => {
    if (!linked) return;
    let active = true;
    setWixLoading(true);
    readWixProduct(product.sku)
      .then((snap) => {
        if (!active) return;
        if (snap) {
          const built = buildForm(snap);
          setWixBaseline(built);
          setForm(built);
          if (Array.isArray(snap._wix_media)) setWixMedia(snap._wix_media);
        }
      })
      .catch(() => { /* silent — fall back to PIM values */ })
      .finally(() => { if (active) setWixLoading(false); });
    return () => { active = false; };
  }, [product.sku, linked]);

  // "Edited" = user changed something vs what Wix currently has
  const baseline = wixBaseline ?? buildForm(product);
  const dirtyByGroup = useMemo(() => {
    const out = {};
    for (const g of FIELD_GROUPS) {
      out[g.key] = g.fields.filter(
        (f) => !valuesEqual(form[f.key], baseline[f.key]),
      ).length;
    }
    return out;
  }, [form, baseline]);
  const totalDirty = Object.values(dirtyByGroup).reduce((a, b) => a + b, 0);
  const dirty = totalDirty > 0;

  // "Differs from PIM" = Wix value ≠ PIM value (informational)
  const pimDiffsByGroup = useMemo(() => {
    const out = {};
    for (const g of FIELD_GROUPS) {
      out[g.key] = g.fields.filter(
        (f) => !valuesEqual(form[f.key], product?.[f.key]),
      ).length;
    }
    return out;
  }, [form, product]);
  const totalPimDiffs = Object.values(pimDiffsByGroup).reduce((a, b) => a + b, 0);

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggleGroup(key) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function expandAll() {
    setOpenGroups(new Set(FIELD_GROUPS.map((g) => g.key)));
  }

  function collapseAll() {
    setOpenGroups(new Set());
  }

  async function handlePush() {
    setBusy(true);
    setError(null);
    setSuccess(false);
    try {
      // Send form values directly to Wix — do NOT write to PIM.
      const result = await pushProductToWix(product.sku, form);

      // Update the baseline so the form no longer shows as "edited"
      setWixBaseline({ ...form });

      // Only update the sync timestamp on the PIM side
      onUpdate({
        wix_synced_at: result?.wix_synced_at ?? new Date().toISOString(),
      });

      if (result?.collections_error) {
        setError(`Pushed, but categories sync failed: ${result.collections_error}`);
      } else {
        setSuccess(true);
        setTimeout(() => setSuccess(false), 2500);
      }
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleReset() {
    setForm(buildForm(product));
    setError(null);
    setSuccess(false);
  }

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface overflow-hidden">
      {/* Header */}
      <header className="flex items-start justify-between gap-6 px-8 pt-7 pb-6 flex-wrap">
        <div className="flex items-center gap-4 min-w-0">
          <WixLogo />
          <div className="min-w-0">
            <h3 className="text-title-lg text-on-surface leading-tight">Sinks Direct Canada</h3>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              Wix Stores · edit the fields below, then push to update.
            </p>
          </div>
        </div>
        <StatusBadge linked={linked} syncedAt={product?.wix_synced_at} />
      </header>

      {linked && (
        <div className="px-8 pb-5">
          <ProductHealthBadge
            product={product}
            media={wixMedia ?? media}
            overrides={form}
          />
        </div>
      )}

      {linked && (
        <button
          type="button"
          onClick={() => setCardExpanded(!cardExpanded)}
          className="w-full px-8 py-3 flex items-center justify-between gap-3 border-t border-outline-variant hover:bg-surface-container-low/40 transition-colors text-left"
          aria-expanded={cardExpanded}
        >
          <div className="text-body-sm">
            {cardExpanded ? (
              <span className="text-on-surface-variant">Hide marketplace fields</span>
            ) : (
              <>
                <span className="text-on-surface font-medium">Edit & push to Wix</span>
                {totalDirty > 0 && (
                  <span className="text-primary ml-2">· {totalDirty} edit{totalDirty === 1 ? '' : 's'} pending</span>
                )}
                {totalDirty === 0 && totalPimDiffs > 0 && (
                  <span className="text-on-surface-variant ml-2">· {totalPimDiffs} differ{totalPimDiffs === 1 ? 's' : ''} from PIM</span>
                )}
              </>
            )}
          </div>
          <ChevronDown
            className={`w-4 h-4 text-on-surface-variant transition-transform ${cardExpanded ? 'rotate-180' : ''}`}
          />
        </button>
      )}

      {!linked ? (
        <div className="px-8 pb-8">
          <NotLinkedNotice />
        </div>
      ) : cardExpanded ? (
        <>
          {/* Toolbar */}
          <div className="px-8 py-3 flex items-center justify-between gap-3 flex-wrap border-y border-outline-variant bg-surface-container-low/50">
            <div className="text-body-sm flex items-center gap-2">
              {wixLoading ? (
                <span className="text-on-surface-variant">Loading live Wix data…</span>
              ) : totalDirty > 0 ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                  <span className="text-primary font-medium">
                    {totalDirty} edit{totalDirty === 1 ? '' : 's'} pending
                  </span>
                </>
              ) : totalPimDiffs > 0 ? (
                <span className="text-on-surface-variant">
                  {totalPimDiffs} field{totalPimDiffs === 1 ? '' : 's'} differ{totalPimDiffs === 1 ? 's' : ''} from PIM
                </span>
              ) : (
                <span className="text-on-surface-variant">Wix matches PIM</span>
              )}
            </div>
            <div className="flex items-center gap-1 text-on-surface-variant">
              <button
                type="button"
                onClick={expandAll}
                className="px-3 py-1.5 rounded-lg text-label-md font-medium hover:bg-surface-container-high hover:text-on-surface transition-colors"
              >
                Expand all
              </button>
              <button
                type="button"
                onClick={collapseAll}
                className="px-3 py-1.5 rounded-lg text-label-md font-medium hover:bg-surface-container-high hover:text-on-surface transition-colors"
              >
                Collapse all
              </button>
            </div>
          </div>

          {wixMedia && wixMedia.length > 0 && (
            <div className="px-6 pt-5">
              <WixImagesPreview images={wixMedia} />
            </div>
          )}

          {/* Groups */}
          <div className="px-6 py-5 space-y-2 bg-surface-container-low/30">
            {FIELD_GROUPS.map((group) => (
              <FieldGroup
                key={group.key}
                group={group}
                form={form}
                product={product}
                baseline={baseline}
                onChange={setField}
                disabled={busy}
                isOpen={openGroups.has(group.key)}
                onToggle={() => toggleGroup(group.key)}
                dirtyCount={dirtyByGroup[group.key]}
                pimDiffCount={pimDiffsByGroup[group.key]}
              />
            ))}
          </div>

          {/* Feedback */}
          {(error || success) && (
            <div className="px-8 pt-2">
              {error && (
                <FeedbackBanner tone="error" icon={AlertCircle}>
                  {error}
                </FeedbackBanner>
              )}
              {success && (
                <FeedbackBanner tone="success" icon={CheckCircle2}>
                  Pushed to Wix successfully.
                </FeedbackBanner>
              )}
            </div>
          )}

          {/* Action footer */}
          <footer className="sticky bottom-0 px-8 py-4 bg-surface/95 backdrop-blur-sm border-t border-outline-variant flex items-center justify-between gap-3 flex-wrap">
            <div className="text-body-sm text-on-surface-variant">
              {!dirty
                ? 'No edits to push.'
                : `${totalDirty} edit${totalDirty === 1 ? '' : 's'} ready to push.`}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleReset}
                disabled={busy || !dirty}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-on-surface-variant text-label-md font-medium hover:bg-surface-container-high hover:text-on-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
              <button
                type="button"
                onClick={handlePush}
                disabled={busy || !dirty}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-on-primary text-label-md font-semibold hover:bg-primary/95 hover:shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                {busy ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Pushing…
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Push to Wix
                  </>
                )}
              </button>
            </div>
          </footer>
        </>
      ) : null}
    </section>
  );
}

// ============================== Field group ==============================

function FieldGroup({ group, form, product, baseline, onChange, disabled, isOpen, onToggle, dirtyCount, pimDiffCount }) {
  const Icon = group.icon;
  return (
    <div
      className={`rounded-xl bg-surface overflow-hidden border transition-colors ${
        isOpen ? 'border-outline-variant' : 'border-transparent hover:border-outline-variant'
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-5 py-4 flex items-center justify-between gap-4 text-left group hover:bg-surface-container-low/60 transition-colors"
      >
        <div className="flex items-center gap-4 min-w-0">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors ${
              isOpen
                ? 'bg-primary-container text-on-primary-container'
                : 'bg-surface-container text-on-surface-variant group-hover:bg-surface-container-high'
            }`}
          >
            <Icon className="w-4 h-4" strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-body-md text-on-surface font-medium">
                {group.title}
              </span>
              {dirtyCount > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-container text-on-primary-container text-label-md font-semibold">
                  {dirtyCount} edited
                </span>
              )}
              {dirtyCount === 0 && pimDiffCount > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-container text-on-surface-variant text-label-md">
                  {pimDiffCount} differ{pimDiffCount === 1 ? 's' : ''} from PIM
                </span>
              )}
            </div>
            {group.summary && !isOpen && (
              <p className="text-body-sm text-on-surface-variant mt-0.5 truncate">
                {group.summary}
              </p>
            )}
          </div>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-on-surface-variant transition-transform flex-shrink-0 ${
            isOpen ? 'rotate-180' : ''
          }`}
          strokeWidth={2.5}
        />
      </button>
      <div
        className={`grid transition-all duration-200 ease-out ${
          isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          <div className="mx-5 border-t border-outline-variant/60" />
          <div className="px-5 pt-5 pb-5 space-y-5">
            {group.fields.map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                value={form[field.key]}
                baselineValue={baseline[field.key]}
                pimValue={product?.[field.key]}
                onChange={(v) => onChange(field.key, v)}
                disabled={disabled || Boolean(field.dependsOn && !form[field.dependsOn])}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================== Field renderers ==============================

function FieldInput({ field, value, baselineValue, pimValue, onChange, disabled }) {
  const isEdited = !valuesEqual(value, baselineValue);
  const pimDiffers = !valuesEqual(value, pimValue);

  if (field.type === 'boolean') {
    return (
      <div className="py-1.5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-body-md text-on-surface">{field.label}</span>
              {field.notPushed && <LocalOnlyTag />}
              {isEdited && <DirtyDot />}
            </div>
            {field.hint && (
              <p className="text-body-sm text-on-surface-variant mt-1 max-w-prose">
                {field.hint}
              </p>
            )}
          </div>
          <ToggleSwitch
            checked={Boolean(value)}
            onChange={onChange}
            disabled={disabled}
          />
        </div>
        {pimDiffers && <PimHint value={pimValue} type="boolean" />}
      </div>
    );
  }

  return (
    <div>
      <FieldLabel
        label={field.label}
        notPushed={field.notPushed}
        isDirty={isEdited}
      />
      {field.type === 'text' && (
        <input
          type="text"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={inputClass}
        />
      )}
      {field.type === 'textarea' && (
        <textarea
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          rows={field.rows ?? 4}
          disabled={disabled}
          className={`${inputClass} resize-y leading-relaxed`}
        />
      )}
      {field.type === 'richtext' && (
        <RichTextEditor
          value={value ?? ''}
          onChange={onChange}
          disabled={disabled}
          placeholder="Type here…"
          minRows={field.rows ?? 5}
        />
      )}
      {field.type === 'number' && (
        <input
          type="number"
          step="0.001"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          disabled={disabled}
          className={inputClass}
        />
      )}
      {field.type === 'currency' && (
        <div className="relative">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-body-md text-on-surface-variant pointer-events-none">
            C$
          </span>
          <input
            type="number"
            step="0.01"
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
            disabled={disabled}
            className={`${inputClass} pl-11`}
          />
        </div>
      )}
      {field.type === 'collections' && (
        <CollectionsPicker
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          disabled={disabled}
        />
      )}
      {field.type === 'sections' && (
        <SectionsEditor
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          disabled={disabled}
        />
      )}
      {field.hint && (
        <p className="text-body-sm text-on-surface-variant mt-2 max-w-prose">
          {field.hint}
        </p>
      )}
      {pimDiffers && <PimHint value={pimValue} type={field.type} />}
    </div>
  );
}

function PimHint({ value, type }) {
  let display;
  if (type === 'boolean') {
    display = value ? 'Yes' : 'No';
  } else if (type === 'currency') {
    display = value != null ? `C$ ${Number(value).toFixed(2)}` : '—';
  } else if (type === 'richtext' || type === 'sections' || type === 'collections') {
    return null;
  } else if (value == null || value === '') {
    display = '(empty)';
  } else {
    display = String(value);
  }

  return (
    <p className="text-label-md text-on-surface-variant/70 mt-1.5 flex items-center gap-1.5">
      <span className="w-1 h-1 rounded-full bg-primary inline-block flex-shrink-0" />
      <span>PIM: <span className="text-on-surface-variant font-medium">{display}</span></span>
    </p>
  );
}

function FieldLabel({ label, notPushed, isDirty }) {
  return (
    <div className="flex items-baseline justify-between mb-2 gap-2">
      <label className="block text-body-sm text-on-surface font-medium">
        {label}
        {notPushed && (
          <span className="ml-1.5">
            <LocalOnlyTag />
          </span>
        )}
      </label>
      {isDirty && <DirtyDot />}
    </div>
  );
}

function LocalOnlyTag() {
  return (
    <span
      className="inline-flex items-center px-1.5 py-px rounded text-label-md text-on-surface-variant bg-surface-container italic font-normal"
      title="Stored in PIM but not pushed to Wix (Wix API limitation)"
    >
      local only
    </span>
  );
}

function DirtyDot() {
  return (
    <span className="inline-flex items-center gap-1 text-label-md text-primary font-medium">
      <span className="w-1.5 h-1.5 rounded-full bg-primary" />
      Modified
    </span>
  );
}

const inputClass =
  'w-full px-3.5 py-2.5 rounded-xl border border-outline-variant bg-surface text-body-md text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed';

// ============================== Toggle ==============================

function ToggleSwitch({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:ring-offset-2 focus:ring-offset-surface ${
        checked ? 'bg-primary' : 'bg-surface-container-highest'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-[1.375rem]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

// ============================== Collections picker ==============================

function CollectionsPicker({ value, onChange, disabled }) {
  const { collections, loading, error } = useWixCollections();
  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedSet = useMemo(() => new Set(value), [value]);
  const byId = useMemo(() => {
    const m = new Map();
    for (const c of collections) m.set(c.id, c);
    return m;
  }, [collections]);

  const filtered = useMemo(() => {
    if (!search) return collections;
    const q = search.toLowerCase();
    return collections.filter((c) => c.name.toLowerCase().includes(q));
  }, [collections, search]);

  function toggle(id) {
    if (disabled) return;
    if (selectedSet.has(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      onChange([...value, id]);
    }
  }

  if (loading) {
    return <p className="text-body-sm text-on-surface-variant">Loading Wix categories…</p>;
  }
  if (error) {
    return (
      <p className="text-body-sm text-error">
        Failed to load Wix categories: {error.message}
      </p>
    );
  }
  if (collections.length === 0) {
    return (
      <p className="text-body-sm text-on-surface-variant italic">
        No categories defined in Wix yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* Selected chips */}
      <div className="flex flex-wrap gap-1.5 items-start">
        {value.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant py-1">
            No categories selected yet.
          </p>
        ) : (
          value.map((id) => {
            const c = byId.get(id);
            const label = c?.name ?? '(unknown)';
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 pl-3 pr-1.5 py-1 rounded-full bg-primary-container text-on-primary-container text-body-sm font-medium"
              >
                {label}
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  disabled={disabled}
                  className="ml-0.5 p-0.5 rounded-full hover:bg-on-primary-container/10 transition-colors disabled:opacity-50"
                  aria-label={`Remove ${label}`}
                >
                  <X className="w-3 h-3" strokeWidth={2.5} />
                </button>
              </span>
            );
          })
        )}
      </div>

      {/* Toggle + browse picker */}
      <button
        type="button"
        onClick={() => setPickerOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors disabled:opacity-50"
      >
        <Plus className={`w-3.5 h-3.5 transition-transform ${pickerOpen ? 'rotate-45' : ''}`} />
        {pickerOpen ? 'Done' : 'Browse categories'}
        <span className="text-on-surface-variant/70 ml-0.5">· {collections.length}</span>
      </button>

      {pickerOpen && (
        <div className="rounded-xl border border-outline-variant bg-surface overflow-hidden">
          <div className="relative border-b border-outline-variant">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
            <input
              type="text"
              placeholder="Search categories…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-3 py-2.5 bg-transparent text-body-md text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none"
              disabled={disabled}
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-4 py-3 text-body-sm text-on-surface-variant">
                No matches.
              </p>
            ) : (
              filtered.map((c) => (
                <label
                  key={c.id}
                  className="flex items-center gap-2.5 px-4 py-2 hover:bg-surface-container-low cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedSet.has(c.id)}
                    onChange={() => toggle(c.id)}
                    disabled={disabled}
                    className="w-4 h-4 accent-primary"
                  />
                  <span className="text-body-md text-on-surface">{c.name}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================== Additional info sections editor ==============================

function SectionsEditor({ value, onChange, disabled }) {
  function update(idx, key, v) {
    onChange(value.map((s, i) => (i === idx ? { ...s, [key]: v } : s)));
  }
  function add() {
    onChange([...value, { title: '', description: '' }]);
  }
  function remove(idx) {
    onChange(value.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-4">
      {value.length === 0 && (
        <div className="rounded-xl border border-dashed border-outline-variant bg-surface-container-low/40 px-6 py-8 text-center">
          <div className="inline-flex w-10 h-10 items-center justify-center rounded-xl bg-surface-container mb-3">
            <FileText className="w-5 h-5 text-on-surface-variant" strokeWidth={1.5} />
          </div>
          <p className="text-body-md text-on-surface font-medium">No sections yet</p>
          <p className="text-body-sm text-on-surface-variant mt-1 max-w-xs mx-auto">
            Use these for content blocks like Dimensions, Features, or Documents to Download.
          </p>
        </div>
      )}
      {value.map((section, i) => (
        <div
          key={i}
          className="rounded-xl border border-outline-variant bg-surface overflow-hidden"
        >
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-outline-variant bg-surface-container-low/40">
            <input
              type="text"
              placeholder="Section title (e.g. Dimensions)"
              value={section.title ?? ''}
              onChange={(e) => update(i, 'title', e.target.value)}
              disabled={disabled}
              className="flex-1 px-2 py-1 bg-transparent text-body-md text-on-surface font-medium placeholder:text-on-surface-variant/60 focus:outline-none focus:bg-surface focus:ring-2 focus:ring-primary/20 rounded-md transition-all"
            />
            <button
              type="button"
              onClick={() => remove(i)}
              disabled={disabled}
              className="p-1.5 rounded-lg text-on-surface-variant hover:bg-error-container/40 hover:text-error transition-colors disabled:opacity-50"
              title="Remove section"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          <div className="p-3">
            <RichTextEditor
              value={section.description ?? ''}
              onChange={(html) => update(i, 'description', html)}
              disabled={disabled}
              placeholder="Section content…"
              minRows={4}
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors disabled:opacity-50"
      >
        <Plus className="w-3.5 h-3.5" />
        Add section
      </button>
    </div>
  );
}

// ============================== Status / notices ==============================

function StatusBadge({ linked, syncedAt }) {
  if (!linked) {
    return (
      <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-container text-body-sm text-on-surface-variant">
        <span className="w-1.5 h-1.5 rounded-full bg-on-surface-variant/50" />
        Not linked
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-tertiary-container/50 text-body-sm text-on-tertiary-container"
      title={syncedAt ? `Last push to Wix: ${formatTimeAgo(syncedAt)}` : 'Never pushed to Wix'}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-on-tertiary-container" />
      <span>
        Linked · <span className="text-on-tertiary-container/70">last push {syncedAt ? formatTimeAgo(syncedAt) : 'never'}</span>
      </span>
    </span>
  );
}

function WixImagesPreview({ images }) {
  const [expanded, setExpanded] = useState(false);
  const imageItems = images.filter((m) => m.media_type === 'image');
  if (imageItems.length === 0) return null;

  const visibleCount = expanded ? imageItems.length : Math.min(imageItems.length, 8);
  const visible = imageItems.slice(0, visibleCount);
  const remaining = imageItems.length - visibleCount;

  return (
    <div className="rounded-xl border border-outline-variant bg-surface overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-outline-variant bg-surface-container-low/40">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-4 h-4 text-on-surface-variant" />
          <span className="text-body-md text-on-surface font-medium">Images on Wix</span>
          <span className="text-label-md text-on-surface-variant">· {imageItems.length}</span>
        </div>
      </div>
      <div className="p-4 grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-3">
        {visible.map((img, i) => (
          <div
            key={i}
            className="relative aspect-square rounded-lg overflow-hidden bg-surface-container-low border border-outline-variant"
          >
            <img
              src={img.storage_path}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
            />
            {img.is_primary && (
              <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-primary text-on-primary text-label-md font-semibold">
                Main
              </span>
            )}
          </div>
        ))}
        {!expanded && remaining > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="aspect-square rounded-lg border-2 border-dashed border-outline-variant bg-surface-container-low/50 hover:bg-surface-container-low transition-colors text-body-sm text-on-surface-variant flex flex-col items-center justify-center gap-1"
          >
            <span className="text-title-md text-on-surface font-semibold">+{remaining}</span>
            <span className="text-label-md">more</span>
          </button>
        )}
      </div>
    </div>
  );
}

function NotLinkedNotice() {
  return (
    <div className="rounded-xl border border-secondary-container bg-secondary-container/40 p-5">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-secondary flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-body-md text-on-secondary-container font-semibold">
            Not linked to Wix yet
          </p>
          <p className="text-body-sm text-on-secondary-container mt-1">
            Go to{' '}
            <Link to="/syndication" className="font-semibold underline hover:no-underline">
              Syndication
            </Link>{' '}
            and run <em>Preview Link with Wix</em> to enable push.
          </p>
        </div>
      </div>
    </div>
  );
}

function FeedbackBanner({ tone, icon: Icon, children }) {
  const tones = {
    error: 'border-error/40 bg-error-container/30 text-on-error-container',
    success: 'border-tertiary/40 bg-tertiary-container/40 text-on-tertiary-container',
  };
  const iconTones = {
    error: 'text-error',
    success: 'text-on-tertiary-container',
  };
  return (
    <div className={`rounded-lg border p-3 text-body-sm mb-3 ${tones[tone]}`}>
      <div className="flex items-start gap-2">
        <Icon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${iconTones[tone]}`} />
        <span>{children}</span>
      </div>
    </div>
  );
}

function WixLogo() {
  return (
    <div
      className="w-10 h-10 rounded-2xl bg-on-surface text-surface flex items-center justify-center text-headline-sm font-medium flex-shrink-0"
      style={{ fontFamily: 'var(--font-display)' }}
      aria-hidden
    >
      W
    </div>
  );
}

// ============================== Helpers ==============================

function pickSyncable(product) {
  if (!product) return null;
  const out = {};
  for (const key of ALL_FIELD_KEYS) out[key] = product[key];
  return out;
}

function buildForm(product) {
  const out = {};
  for (const key of ALL_FIELD_KEYS) {
    const v = product?.[key];
    if (key === 'wix_collection_ids') {
      out[key] = Array.isArray(v) ? [...v] : [];
    } else if (key === 'additional_info_sections') {
      out[key] = Array.isArray(v) ? v.map((s) => ({ ...s })) : [];
    } else {
      out[key] = v ?? (typeof v === 'boolean' ? v : null);
    }
  }
  for (const group of FIELD_GROUPS) {
    for (const field of group.fields) {
      if (field.type === 'boolean' && out[field.key] == null) {
        out[field.key] = false;
      }
    }
  }
  return out;
}

function buildPatch(form) {
  const patch = {};
  for (const key of ALL_FIELD_KEYS) {
    let v = form[key];
    if (typeof v === 'string') {
      const trimmed = v.trim();
      v = trimmed.length === 0 ? null : trimmed;
    }
    if (key === 'additional_info_sections' && Array.isArray(v)) {
      v = v.filter((s) => (s.title && s.title.trim()) || (s.description && s.description.trim()));
    }
    patch[key] = v;
  }
  return patch;
}

// Normalize an HTML snippet by parsing it through the browser, which
// canonicalizes things like <br> vs <br/>, attribute quoting, &nbsp; vs space,
// and whitespace between tags — exactly the things that make TipTap-canonical
// HTML differ from Wix-raw HTML without any semantic change.
function normalizeHtml(value) {
  if (typeof value !== 'string') return value;
  if (typeof document === 'undefined') return value;
  if (!value.includes('<')) return value;
  const tmp = document.createElement('div');
  tmp.innerHTML = value;
  return tmp.innerHTML;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  // null / undefined / empty-string / empty-array all mean "no value".
  if (a == null && b == null) return true;
  if (a == null) {
    if (b === '') return true;
    if (Array.isArray(b) && b.length === 0) return true;
    return false;
  }
  if (b == null) {
    if (a === '') return true;
    if (Array.isArray(a) && a.length === 0) return true;
    return false;
  }
  // Arrays — recurse element-by-element. For arrays of string IDs (e.g.
  // wix_collection_ids), order doesn't matter.
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    if (a.every((x) => typeof x === 'string')) {
      return [...a].sort().join('|') === [...b].sort().join('|');
    }
    return a.every((v, i) => valuesEqual(v, b[i]));
  }
  // Plain objects — compare by key set, then per-value recursion. Order-
  // insensitive so Postgres JSONB key-ordering doesn't trip the comparison.
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!valuesEqual(a[k], b[k])) return false;
    }
    return true;
  }
  // Strings that look like HTML — try a normalized comparison.
  if (typeof a === 'string' && typeof b === 'string') {
    if (a.includes('<') || b.includes('<')) {
      return normalizeHtml(a) === normalizeHtml(b);
    }
    return a === b;
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return String(a) === String(b);
}
