import { useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronDown,
  Camera,
  CheckCircle2,
  ClipboardList,
  Ruler,
  DollarSign,
  ImageIcon,
  Store,
  Pencil,
  Save,
  X,
  Loader2,
  Plus,
  Trash2,
  FileText,
} from 'lucide-react';
import { useProduct } from '@/features/products/hooks/useProduct';
import { useProductMedia } from '@/features/media/hooks/useProductMedia';
import { updateProduct } from '@/features/products/api/products';
import { getThumbnailUrl } from '@/features/media/api/media';
import { formatCAD, formatCategory, formatDate, formatTimeAgo } from '@/lib/format';
import StatusBadge from '@/features/products/components/StatusBadge';
import MediaSection from '@/features/media/components/MediaSection';
import DocumentsSection from '@/features/media/components/DocumentsSection';
import WixSyndicationCard from '@/features/syndication/components/WixSyndicationCard';
import WayfairProductCard from '@/features/syndication/components/WayfairProductCard';
import RichTextEditor from '@/components/ui/RichTextEditor';
import Skeleton from '@/components/ui/Skeleton';
import VariantsSection from '@/features/products/components/VariantsSection';
import { generateBBBFromTemplate } from '@/features/syndication/exports/bbbExport';
import { useTemplates } from '@/features/templates/hooks/useTemplates';
import { useAuth } from '@/features/auth/AuthContext';

// ===================== Constants =====================

const TABS = [
  { key: 'overview', label: 'Overview', icon: ClipboardList },
  { key: 'specs', label: 'Specifications', icon: Ruler },
  { key: 'content', label: 'Content', icon: FileText },
  { key: 'pricing', label: 'Pricing', icon: DollarSign },
  { key: 'media', label: 'Media', icon: ImageIcon },
  { key: 'marketplaces', label: 'Marketplaces', icon: Store },
];

const WORKFLOW_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'in_review', label: 'In Review' },
  { value: 'ready_to_sell', label: 'Ready to Sell' },
  { value: 'archived', label: 'Archived' },
];

const CATEGORY_OPTIONS = [
  { value: 'kitchen_sink', label: 'Kitchen Sink' },
  { value: 'bath_sink', label: 'Bath Sink' },
  { value: 'kitchen_faucet', label: 'Kitchen Faucet' },
  { value: 'bath_faucet', label: 'Bath Faucet' },
  { value: 'accessory', label: 'Accessory' },
];

const MAX_BULLETS = 12;

// Helper to read a value from product.attributes JSONB
function attr(product, key) {
  return product.attributes?.[key] ?? null;
}

// List attributes are edited as "A; B" text and stored as arrays.
const LIST_ATTRS = new Set(['installation_type', 'accessories_included', 'durability_tags']);

function joinList(v) {
  if (Array.isArray(v)) return v.join('; ');
  return v ?? '';
}

// ===================== Form helpers =====================

function buildEditForm(product) {
  const a = product.attributes ?? {};
  return {
    // Direct columns
    model_name: product.model_name ?? '',
    family_number: product.family_number ?? '',
    brand: product.brand ?? '',
    category: product.category ?? '',
    series: product.series ?? '',
    product_type: product.product_type ?? '',
    workflow_status: product.workflow_status ?? '',
    material: product.material ?? '',
    finish: product.finish ?? '',
    color: product.color ?? '',
    factory_code: product.factory_code ?? '',
    msrp_cad: product.msrp_cad ?? '',
    dealer_cost_cad: product.dealer_cost_cad ?? '',
    sale_price_cad: product.sale_price_cad ?? '',
    on_sale: product.on_sale ?? false,
    shipping_weight_lb: product.shipping_weight_lb ?? '',
    description: product.description ?? '',
    quickbooks_description: product.quickbooks_description ?? '',
    notes: product.notes ?? '',
    ribbon: product.ribbon ?? '',
    visible_online: product.visible_online ?? true,
    visible_pos: product.visible_pos ?? true,
    pre_order: product.pre_order ?? false,
    sample_available_date: product.sample_available_date ?? '',
    ready_to_sell_date: product.ready_to_sell_date ?? '',
    launch_lead: product.launch_lead ?? '',
    standards_compliance: product.standards_compliance ?? '',
    spec_sheet_needs_update: product.spec_sheet_needs_update ?? false,
    installation_sheet_needs_update: product.installation_sheet_needs_update ?? false,

    // From attributes JSONB
    _upc: a.upc ?? '',
    _warranty: a.warranty ?? '',
    _manufacturer: a.manufacturer ?? '',
    _country_of_origin: a.country_of_origin ?? '',
    _hs_code: a.hs_code ?? '',
    _installation_type: joinList(a.installation_type),
    _sink_shape: a.sink_shape ?? '',
    _gauge: a.gauge ?? '',
    _number_of_bowls: a.number_of_bowls ?? '',
    _bowl_configuration: a.bowl_configuration ?? '',
    _basin_split: a.basin_split ?? '',
    _low_divider: a.low_divider ?? false,
    _strainer_model: a.strainer_model ?? '',
    _sink_radius_mm: a.sink_radius_mm ?? '',
    _drain_diameter_in: a.drain_diameter_in ?? '',
    _drain_hole_location: a.drain_hole_location ?? '',
    _has_grooves: a.has_grooves ?? false,
    _includes_grids: a.includes_grids ?? false,
    _craftsmanship: a.craftsmanship ?? '',
    _product_weight_lb: a.product_weight_lb ?? '',
    _external_dimensions_in: a.external_dimensions_in ?? { length: '', width: '', depth: '' },
    _internal_dimensions_in: a.internal_dimensions_in ?? { length: '', width: '', depth: '' },
    _cut_out_dimensions_in: a.cut_out_dimensions_in ?? { length: '', width: '', depth: '' },
    _shipping_dimensions_in: a.shipping_dimensions_in ?? { length: '', width: '', height: '' },
    _min_external_cabinet_size_in: a.min_external_cabinet_size_in ?? '',
    _min_internal_cabinet_size_in: a.min_internal_cabinet_size_in ?? '',
    _max_deck_thickness_in: a.max_deck_thickness_in ?? '',
    _bullet_points: a.bullet_points ?? [],
    _accessories_included: joinList(a.accessories_included),
    _durability_tags: joinList(a.durability_tags),
    _number_of_pieces: a.number_of_pieces ?? '',
    _scc_compliant: a.scc_compliant ?? '',
    _safety_listings: a.safety_listings ?? '',
    _upc_certified: a.upc_certified ?? '',
    _vermont_act_193_compliant: a.vermont_act_193_compliant ?? '',
    _general_title_en: a.general_title_en ?? '',
    _general_title_fr: a.general_title_fr ?? '',
    _description_fr: a.description_fr ?? '',
    _bullet_points_fr: a.bullet_points_fr ?? [],
  };
}

const NUMBER_COLUMNS = new Set([
  'family_number', 'msrp_cad', 'dealer_cost_cad', 'sale_price_cad', 'shipping_weight_lb',
]);

function cleanDims(dims) {
  if (!dims || typeof dims !== 'object') return null;
  const out = {};
  let hasValue = false;
  for (const [k, v] of Object.entries(dims)) {
    if (v === '' || v == null) { out[k] = null; continue; }
    const n = Number(v);
    out[k] = isNaN(n) ? null : n;
    if (out[k] !== null) hasValue = true;
  }
  return hasValue ? out : null;
}

function buildPatch(form, product) {
  const columnPatch = {};
  const newAttrs = { ...(product.attributes ?? {}) };
  let attrsChanged = false;

  for (const [key, value] of Object.entries(form)) {
    if (key.startsWith('_')) {
      // Attribute field — write into attributes JSONB
      const attrKey = key.slice(1); // remove leading _
      const original = (product.attributes ?? {})[attrKey] ?? null;

      let normalized = value;
      if (typeof value === 'string' && value.trim() === '') normalized = null;
      if (['number_of_bowls', 'sink_radius_mm', 'drain_diameter_in', 'product_weight_lb',
           'min_external_cabinet_size_in', 'min_internal_cabinet_size_in', 'max_deck_thickness_in',
           'number_of_pieces', 'number_of_installation_holes', 'number_of_handles',
           'faucet_height_in', 'spout_reach_in', 'spout_height_in',
           'install_hole_diameter_mm', 'install_hole_diameter_in'].includes(attrKey)) {
        if (normalized !== null && normalized !== '') {
          normalized = Number(normalized);
          if (isNaN(normalized)) normalized = null;
        }
      }

      // Handle dimension objects
      if (attrKey.endsWith('_dimensions_in')) {
        normalized = cleanDims(value);
      }

      // Handle bullet point arrays (EN + FR)
      if (attrKey === 'bullet_points' || attrKey === 'bullet_points_fr') {
        normalized = (value || []).filter((b) => typeof b === 'string' && b.trim() !== '');
        if (normalized.length === 0) normalized = [];
      }

      // List attributes: "A; B" text → ["A", "B"]
      if (LIST_ATTRS.has(attrKey)) {
        const items = typeof value === 'string'
          ? value.split(/[;,]/).map((s) => s.trim()).filter(Boolean)
          : Array.isArray(value) ? value : [];
        normalized = items.length > 0 ? items : null;
      }

      if (JSON.stringify(normalized) !== JSON.stringify(original)) {
        if (normalized === null) delete newAttrs[attrKey];
        else newAttrs[attrKey] = normalized;
        attrsChanged = true;
      }
      continue;
    }

    // Direct column
    let normalized = value;
    if (typeof value === 'string' && value.trim() === '') normalized = null;
    if (NUMBER_COLUMNS.has(key) && normalized !== null) {
      normalized = Number(normalized);
      if (isNaN(normalized)) normalized = null;
    }
    const original = product[key] ?? null;
    if (normalized !== original) {
      columnPatch[key] = normalized;
    }
  }

  if (attrsChanged) columnPatch.attributes = newAttrs;
  return columnPatch;
}

// ===================== Main component =====================

export default function ProductDetail() {
  const { sku } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'overview';

  const { canEdit } = useAuth();
  const { product, loading, error, notFound, mergeProduct, refetch } = useProduct(sku);
  const { primary, media } = useProductMedia(sku);

  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  function setTab(key) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (key === 'overview') next.delete('tab');
      else next.set('tab', key);
      return next;
    }, { replace: true });
  }

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function startEditing() {
    setForm(buildEditForm(product));
    setSaveError(null);
    setIsEditing(true);
  }

  function cancelEditing() {
    setIsEditing(false);
    setForm({});
    setSaveError(null);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const patch = buildPatch(form, product);
      if (Object.keys(patch).length === 0) {
        setIsEditing(false);
        return;
      }
      const updated = await updateProduct(product.sku, patch);
      mergeProduct(updated);
      setIsEditing(false);
      setForm({});
    } catch (err) {
      setSaveError(err.message ?? 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingSkeleton />;
  if (notFound) return <NotFoundState sku={sku} />;
  if (error) return <ErrorState error={error} />;

  const subtitleParts = [
    product.brand,
    product.category && formatCategory(product.category),
    product.series && `${product.series} Series`,
  ].filter(Boolean);

  const editCtx = { isEditing, form, setField };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Link
        to="/catalog"
        className="inline-flex items-center gap-1 text-body-sm text-on-surface-variant hover:text-primary mb-4 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Catalog
      </Link>

      {/* Hero */}
      <div className="flex flex-col sm:flex-row gap-6 mb-6 items-start">
        <ProductHeroImage primary={primary} />
        <div className="flex-1 min-w-0 w-full">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="inline-flex items-center px-2.5 py-1 rounded-md bg-surface-container text-body-sm font-mono text-on-surface-variant">
              {product.sku}
            </span>
            {isEditing ? (
              <select
                value={form.workflow_status}
                onChange={(e) => setField('workflow_status', e.target.value)}
                className="px-2.5 py-1 rounded-md bg-surface-container border border-outline-variant text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {WORKFLOW_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : (
              <StatusBadge status={product.workflow_status} />
            )}
            <WixLinkBadge product={product} />
          </div>
          {isEditing ? (
            <input
              type="text"
              value={form.model_name}
              onChange={(e) => setField('model_name', e.target.value)}
              placeholder="Product name"
              className="w-full text-display-md text-on-surface leading-tight mb-2 bg-transparent border-b-2 border-outline-variant focus:border-primary focus:outline-none transition-colors"
            />
          ) : (
            <h1 className="text-display-md text-on-surface leading-tight mb-2 line-clamp-2">
              {product.model_name || `SKU ${product.sku}`}
            </h1>
          )}
          {!isEditing && subtitleParts.length > 0 && (
            <p className="text-body-lg text-on-surface-variant">{subtitleParts.join(' · ')}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isEditing ? (
            <>
              <button type="button" onClick={cancelEditing} disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors">
                <X className="w-4 h-4" /> Cancel
              </button>
              <button type="button" onClick={handleSave} disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-body-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-60">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : canEdit ? (
            <button type="button" onClick={startEditing}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors">
              <Pencil className="w-4 h-4" /> Edit
            </button>
          ) : null}
        </div>
      </div>

      {saveError && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-error-container text-on-error-container text-body-sm">{saveError}</div>
      )}

      <TabBar tabs={TABS} active={activeTab} onChange={setTab} />

      <div className="mt-6">
        {activeTab === 'overview' && <OverviewTab product={product} edit={editCtx} onProductChanged={refetch} />}
        {activeTab === 'specs' && <SpecsTab product={product} edit={editCtx} />}
        {activeTab === 'content' && <ContentTab product={product} edit={editCtx} />}
        {activeTab === 'pricing' && <PricingTab product={product} edit={editCtx} />}
        {activeTab === 'media' && <MediaTab sku={product.sku} category={product.category} />}
        {activeTab === 'marketplaces' && <MarketplacesTab product={product} media={media} onUpdate={mergeProduct} />}
      </div>
    </div>
  );
}

// ===================== Tab bar =====================

function TabBar({ tabs, active, onChange }) {
  return (
    <div className="border-b border-outline-variant overflow-x-auto scrollbar-hide -mx-6 px-6">
      <nav className="flex min-w-max gap-1" role="tablist">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.key;
          return (
            <button key={tab.key} type="button" role="tab" aria-selected={isActive}
              onClick={() => onChange(tab.key)}
              className={`inline-flex items-center gap-2 px-4 py-3 text-body-md whitespace-nowrap border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-primary text-primary font-semibold'
                  : 'border-transparent text-on-surface-variant hover:text-on-surface hover:border-outline-variant'
              }`}>
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

// ===================== Overview Tab =====================

function OverviewTab({ product, edit, onProductChanged }) {
  return (
    <div className="space-y-6">
      <Section title="Identification">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
          <Field label="SKU" value={product.sku} mono />
          <AttrField label="UPC" attrKey="upc" product={product} edit={edit} mono />
          <EditableField label="Brand" fieldKey="brand" product={product} edit={edit} />
          <AttrField label="Manufacturer" attrKey="manufacturer" product={product} edit={edit} />
          <EditableField label="Category" fieldKey="category" type="select" options={CATEGORY_OPTIONS} product={product} edit={edit} />
          <EditableField label="Series" fieldKey="series" product={product} edit={edit} />
          <EditableField label="Family Number" fieldKey="family_number" type="number" product={product} edit={edit} />
          <EditableField label="Product Type" fieldKey="product_type" product={product} edit={edit} />
        </div>
      </Section>

      <VariantsSection product={product} onProductChanged={onProductChanged} />

      <Section title="Trade & Compliance">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
          <AttrField label="Country of Origin" attrKey="country_of_origin" product={product} edit={edit} />
          <AttrField label="HS Code" attrKey="hs_code" product={product} edit={edit} mono />
          <AttrField label="Warranty" attrKey="warranty" product={product} edit={edit} />
          <EditableField label="Standards" fieldKey="standards_compliance" product={product} edit={edit} />
          <AttrField label="Safety Listing(s)" attrKey="safety_listings" product={product} edit={edit} />
          <AttrField label="SCC Compliant" attrKey="scc_compliant" product={product} edit={edit} />
          <AttrField label="UPC Certified" attrKey="upc_certified" product={product} edit={edit} />
          <AttrField label="Vermont Act 193 Compliant" attrKey="vermont_act_193_compliant" product={product} edit={edit} />
        </div>
      </Section>

      <Section title="Important Dates">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
          <EditableField label="Sample Available" fieldKey="sample_available_date" type="date" product={product} edit={edit} />
          <EditableField label="Ready to Sell" fieldKey="ready_to_sell_date" type="date" product={product} edit={edit} />
          <EditableField label="Launch Lead" fieldKey="launch_lead" type="date" product={product} edit={edit} />
          <Field label="Created" value={formatDate(product.created_at)} />
        </div>
      </Section>

      <Section title="Documentation" defaultOpen={false}>
        <div className="space-y-3">
          <EditableDocFlag label="Spec Sheet" fieldKey="spec_sheet_needs_update" product={product} edit={edit} />
          <EditableDocFlag label="Installation Sheet" fieldKey="installation_sheet_needs_update" product={product} edit={edit} />
        </div>
      </Section>
    </div>
  );
}

// ===================== Specifications Tab =====================

function SpecsTab({ product, edit }) {
  const cat = edit.isEditing ? edit.form.category : product.category;
  const isSink = cat?.includes('sink');
  // Category-aware: faucet products show faucet sections, sinks show sink ones.
  // Falls back to a data signal (spout_type) so mis-categorized faucets still work.
  const isFaucet = Boolean(cat?.includes('faucet')) || attr(product, 'spout_type') != null;

  return (
    <div className="space-y-6">
      <Section title="Physical Properties">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
          <EditableField label="Material" fieldKey="material" product={product} edit={edit} />
          <EditableField label="Finish" fieldKey="finish" product={product} edit={edit} />
          <AttrField label="Craftsmanship" attrKey="craftsmanship" product={product} edit={edit} />
          {!isFaucet && <AttrField label="Sink Shape" attrKey="sink_shape" product={product} edit={edit} />}
          {!isFaucet && <AttrListField label="Installation Type" attrKey="installation_type" product={product} edit={edit} hint="Separate multiple options with ; (e.g. Undermount; Drop-In)" />}
          {!isFaucet && <AttrField label="Gauge" attrKey="gauge" product={product} edit={edit} />}
          {isFaucet && <AttrField label="Application" attrKey="application" product={product} edit={edit} />}
          {isFaucet && <AttrField label="Lead Free" attrKey="lead_free" type="boolean" product={product} edit={edit} />}
        </div>
      </Section>

      {(isSink || attr(product, 'number_of_bowls')) && (
        <Section title="Bowl Configuration">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
            <AttrField label="Number of Bowls" attrKey="number_of_bowls" type="number" product={product} edit={edit} />
            <AttrField label="Bowl Configuration" attrKey="bowl_configuration" product={product} edit={edit} />
            <AttrField label="Basin Split" attrKey="basin_split" product={product} edit={edit} />
            <AttrField label="Low Divider" attrKey="low_divider" type="boolean" product={product} edit={edit} />
            <AttrField label="Strainer Model" attrKey="strainer_model" product={product} edit={edit} />
            <AttrField label="Sink Radius (mm)" attrKey="sink_radius_mm" type="number" product={product} edit={edit} />
            <AttrField label="Drain Diameter (in)" attrKey="drain_diameter_in" type="number" product={product} edit={edit} />
            <AttrField label="Drain Location" attrKey="drain_hole_location" product={product} edit={edit} />
            <AttrField label="Has Grooves" attrKey="has_grooves" type="boolean" product={product} edit={edit} />
            <AttrField label="Includes Grids" attrKey="includes_grids" type="boolean" product={product} edit={edit} />
          </div>
        </Section>
      )}

      {isFaucet && (
        <>
          <Section title="Faucet Configuration">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
              <AttrField label="Spout Type" attrKey="spout_type" product={product} edit={edit} />
              <AttrField label="Swivel Spout" attrKey="swivel_spout" product={product} edit={edit} />
              <AttrField label="Max Flow Rate" attrKey="max_flow_rate" product={product} edit={edit} />
              <AttrField label="Installation Holes" attrKey="number_of_installation_holes" type="number" product={product} edit={edit} />
              <AttrField label="Mounting / Installation Type" attrKey="mounting_type" product={product} edit={edit} />
              <AttrField label="Connection Size" attrKey="connection_size" product={product} edit={edit} />
              <AttrField label="Lock Type" attrKey="lock_type" product={product} edit={edit} />
              <AttrField label="Hot & Cold Dispenser" attrKey="hot_cold_dispenser" type="boolean" product={product} edit={edit} />
            </div>
          </Section>

          <Section title="Handles, Spray & Cartridge" defaultOpen={false}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
              <AttrField label="Number of Handles" attrKey="number_of_handles" type="number" product={product} edit={edit} />
              <AttrField label="Handle(s) Included" attrKey="handles_included" type="boolean" product={product} edit={edit} />
              <AttrField label="Handle Style" attrKey="handle_style" product={product} edit={edit} />
              <AttrField label="Cold Start Handle" attrKey="cold_start_handle" type="boolean" product={product} edit={edit} />
              <AttrField label="Spray Included" attrKey="spray_included" type="boolean" product={product} edit={edit} />
              <AttrField label="Spray Type" attrKey="spray_type" product={product} edit={edit} />
              <AttrField label="Spray Activation" attrKey="spray_function_activation" product={product} edit={edit} />
              <AttrField label="Spray Head Functions" attrKey="spray_head_functions" product={product} edit={edit} />
              <AttrField label="Pull-Down Hose Model" attrKey="pull_down_hose_model" product={product} edit={edit} />
              <AttrField label="Cartridge Type" attrKey="cartridge_type" product={product} edit={edit} />
              <AttrField label="Cartridge Size" attrKey="cartridge_size" product={product} edit={edit} />
            </div>
          </Section>

          <Section title="Included Components" defaultOpen={false}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
              <AttrField label="Deck Plate Included" attrKey="deck_plate_included" type="boolean" product={product} edit={edit} />
              <AttrField label="Compatible Deck Plate #" attrKey="compatible_deck_plate" product={product} edit={edit} />
              <AttrField label="Supply Line Included" attrKey="supply_line_included" type="boolean" product={product} edit={edit} />
              <AttrField label="Aerator Included" attrKey="aerator_included" type="boolean" product={product} edit={edit} />
              <AttrField label="Hose Included" attrKey="hose_included" type="boolean" product={product} edit={edit} />
            </div>
          </Section>

          <Section title="Faucet Dimensions" defaultOpen={false}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
              <AttrField label="Faucet Height (in)" attrKey="faucet_height_in" type="number" product={product} edit={edit} />
              <AttrField label="Spout Reach (in)" attrKey="spout_reach_in" type="number" product={product} edit={edit} />
              <AttrField label="Spout Height (in)" attrKey="spout_height_in" type="number" product={product} edit={edit} />
              <AttrField label="Install Hole Ø (mm)" attrKey="install_hole_diameter_mm" type="number" product={product} edit={edit} />
              <AttrField label="Install Hole Ø (in)" attrKey="install_hole_diameter_in" type="number" product={product} edit={edit} />
              <AttrField label="Max Deck Thickness (in)" attrKey="max_deck_thickness_in" type="number" product={product} edit={edit} />
            </div>
          </Section>

          <Section title="Certifications & Compliance" defaultOpen={false}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
              <AttrField label="ADA Compliant" attrKey="ada_compliant" product={product} edit={edit} />
              <AttrField label="cUPC Certified" attrKey="cupc_certified" product={product} edit={edit} />
              <AttrField label="ASSE 1001" attrKey="asse_1001_certified" product={product} edit={edit} />
              <AttrField label="UL 1951 Listed" attrKey="ul_1951_listed" product={product} edit={edit} />
              <AttrField label="ASME/CSA B125.1" attrKey="asme_csa_certified" product={product} edit={edit} />
              <AttrField label="ISTA 1A" attrKey="ista_1a_certified" product={product} edit={edit} />
              <AttrField label="ISTA 3A/6A" attrKey="ista_3a_6a_certified" product={product} edit={edit} />
              <AttrField label="CALGreen" attrKey="calgreen_compliant" product={product} edit={edit} />
              <AttrField label="Title 20" attrKey="title_20_compliant" product={product} edit={edit} />
              <AttrField label="Title 24" attrKey="title_24_compliant" product={product} edit={edit} />
              <AttrField label="UPLR Compliant" attrKey="uplr_compliant" product={product} edit={edit} />
              <AttrField label="Energy Efficiency" attrKey="energy_efficiency_compliant" product={product} edit={edit} />
              <AttrField label="California AB-100" attrKey="ab_100_compliant" product={product} edit={edit} />
              <AttrField label="Canada Restriction" attrKey="canada_product_restriction" product={product} edit={edit} />
            </div>
          </Section>
        </>
      )}

      <Section title="Dimensions & Weight">
        <div className="space-y-5">
          {!isFaucet && (
            <AttrDimensionsField label="External Dimensions (in)" attrKey="external_dimensions_in"
              keys={['length', 'width', 'depth']} labels={['Length', 'Width', 'Depth']} product={product} edit={edit} />
          )}
          {!isFaucet && (
            <AttrDimensionsField label="Internal Dimensions (in)" attrKey="internal_dimensions_in"
              keys={['length', 'width', 'depth']} labels={['Length', 'Width', 'Depth']} product={product} edit={edit} />
          )}
          <AttrField label="Product Weight (lb)" attrKey="product_weight_lb" type="number" product={product} edit={edit} />
          {!isFaucet && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
              <AttrField label="Min External Cabinet (in)" attrKey="min_external_cabinet_size_in" type="number" product={product} edit={edit} />
              <AttrField label="Min Internal Cabinet (in)" attrKey="min_internal_cabinet_size_in" type="number" product={product} edit={edit} />
              <AttrField label="Max Deck Thickness (in)" attrKey="max_deck_thickness_in" type="number" product={product} edit={edit} />
            </div>
          )}
          {!isFaucet && (
            <AttrDimensionsField label="Cut-out Dimensions (in)" attrKey="cut_out_dimensions_in"
              keys={['length', 'width', 'depth']} labels={['Length', 'Width', 'Depth']} product={product} edit={edit} />
          )}
        </div>
      </Section>

      <Section title="Shipping">
        <div className="space-y-5">
          <EditableField label="Shipping Weight (lb)" fieldKey="shipping_weight_lb" type="number" product={product} edit={edit} />
          <AttrDimensionsField label="Shipping Dimensions (in)" attrKey="shipping_dimensions_in"
            keys={['length', 'width', 'height']} labels={['Length', 'Width', 'Height']} product={product} edit={edit} />
        </div>
      </Section>

      {!isFaucet && (
        <Section title="Accessories" defaultOpen={false}>
          <AttrListField label="Included Accessories" attrKey="accessories_included" product={product} edit={edit} hint="Separate items with ;" />
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
            <AttrField label="Number of Pieces Included" attrKey="number_of_pieces" type="number" product={product} edit={edit} />
            <AttrField label="Grids Model Code" attrKey="grids_model_code" product={product} edit={edit} />
          </div>
        </Section>
      )}
    </div>
  );
}

// ===================== Content Tab =====================

function ContentTab({ product, edit }) {
  return (
    <div className="space-y-6">
      <Section title="English Content">
        <div className="space-y-4">
          <AttrField label="General Title (EN)" attrKey="general_title_en" product={product} edit={edit} />
          <EditableField label="Product Description" fieldKey="description" type="richtext" product={product} edit={edit} />
          <EditableField label="QuickBooks Description" fieldKey="quickbooks_description" product={product} edit={edit} />
          <EditableField label="Ribbon" fieldKey="ribbon" product={product} edit={edit} />
        </div>
      </Section>

      <Section title="Bullet Points / Features (EN)">
        <BulletPointsEditor product={product} edit={edit} />
      </Section>

      <Section title="French Content" defaultOpen={false}>
        <div className="space-y-4">
          <AttrField label="General Title (FR)" attrKey="general_title_fr" product={product} edit={edit} />
          <AttrField label="Description (FR)" attrKey="description_fr" type="textarea" product={product} edit={edit} />
        </div>
      </Section>

      <Section title="Bullet Points / Features (FR)" defaultOpen={false}>
        <BulletPointsEditor product={product} edit={edit} attrKey="bullet_points_fr" />
      </Section>

      <Section title="Notes" defaultOpen={false}>
        <EditableField label="Internal Notes" fieldKey="notes" type="textarea" product={product} edit={edit} />
      </Section>
    </div>
  );
}

// ===================== Pricing Tab =====================

function PricingTab({ product, edit }) {
  return (
    <div className="space-y-6">
      <Section title="Standard Pricing">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
          <EditableField label="MSRP (CAD)" fieldKey="msrp_cad" type="currency" product={product} edit={edit} />
          <EditableField label="Dealer Cost (CAD)" fieldKey="dealer_cost_cad" type="currency" product={product} edit={edit} />
        </div>
      </Section>
      <Section title="Sale Pricing">
        <div className="space-y-4">
          <EditableField label="On Sale" fieldKey="on_sale" type="boolean" product={product} edit={edit} />
          {(edit.isEditing ? edit.form.on_sale : product.on_sale) && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
              <EditableField label="Sale Price (CAD)" fieldKey="sale_price_cad" type="currency" product={product} edit={edit} />
            </div>
          )}
        </div>
      </Section>
      <Section title="Visibility" defaultOpen={false}>
        <div className="space-y-3">
          <EditableField label="Show in online store" fieldKey="visible_online" type="boolean" product={product} edit={edit} />
          <EditableField label="Show in Point of Sale" fieldKey="visible_pos" type="boolean" product={product} edit={edit} />
          <EditableField label="Available for pre-order" fieldKey="pre_order" type="boolean" product={product} edit={edit} />
        </div>
      </Section>
    </div>
  );
}

// ===================== Media & Marketplaces =====================

function MediaTab({ sku, category }) {
  return (
    <div className="space-y-6">
      <MediaSection sku={sku} />
      <DocumentsSection sku={sku} category={category} />
    </div>
  );
}

function MarketplacesTab({ product, media, onUpdate }) {
  return (
    <div className="space-y-6">
      <p className="text-body-md text-on-surface-variant">Manage per-channel fields below, then push the changes to each marketplace.</p>
      <WixSyndicationCard product={product} media={media} onUpdate={onUpdate} />
      <WayfairProductCard product={product} onUpdate={onUpdate} />
      <ExportTemplatesCard product={product} media={media} />
    </div>
  );
}

function ExportTemplatesCard({ product, media }) {
  const { templates, loading } = useTemplates();
  const [exporting, setExporting] = useState(null);
  const [error, setError] = useState(null);

  async function handleExport(template) {
    setExporting(template.id);
    setError(null);
    try {
      await generateBBBFromTemplate(template.storage_path, product, media);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(null);
    }
  }

  if (loading || templates.length === 0) return null;

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-8 pt-6 pb-4">
        <h3 className="text-title-lg text-on-surface">Export Templates</h3>
        <p className="text-body-sm text-on-surface-variant mt-1">
          Generate pre-filled XLSX files for manual upload to marketplaces.
        </p>
      </header>
      <div className="px-8 pb-6 space-y-3">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => handleExport(t)}
            disabled={exporting === t.id}
            className="w-full flex items-center justify-between px-5 py-4 rounded-xl border border-outline-variant bg-surface hover:bg-surface-container-low transition-colors text-left disabled:opacity-60"
          >
            <div>
              <span className="text-body-md text-on-surface font-medium">{t.marketplace}</span>
              <p className="text-body-sm text-on-surface-variant mt-0.5">{t.file_name}</p>
            </div>
            <span className="text-label-md text-primary font-semibold">
              {exporting === t.id ? 'Generating…' : 'Export'}
            </span>
          </button>
        ))}
        {error && (
          <p className="text-body-sm text-error mt-2">{error}</p>
        )}
      </div>
    </section>
  );
}

// ===================== AttrField — reads/writes from attributes JSONB =====================

function AttrField({ label, attrKey, type = 'text', product, edit, mono }) {
  const { isEditing, form, setField } = edit;
  const formKey = '_' + attrKey;

  if (!isEditing) {
    const val = attr(product, attrKey);
    if (type === 'boolean') {
      return (
        <div className="flex items-center justify-between">
          <span className="text-body-md text-on-surface">{label}</span>
          <span className={`text-body-sm font-medium ${val ? 'text-success' : 'text-on-surface-variant'}`}>{val ? 'Yes' : 'No'}</span>
        </div>
      );
    }
    if (type === 'number') return <Field label={label} value={val != null ? String(val) : null} mono={mono} />;
    if (type === 'textarea') {
      if (!val) return <Field label={label} value={null} />;
      return (
        <div className="flex flex-col gap-1">
          <span className="text-label-md text-on-surface-variant">{label}</span>
          <p className="text-body-md text-on-surface whitespace-pre-wrap">{val}</p>
        </div>
      );
    }
    return <Field label={label} value={val} mono={mono} />;
  }

  const value = form[formKey];
  const inputBase = 'w-full px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors';

  if (type === 'textarea') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-label-md text-on-surface-variant">{label}</span>
        <textarea
          value={value ?? ''}
          onChange={(e) => setField(formKey, e.target.value)}
          rows={6}
          className={inputBase + ' resize-y'}
          placeholder={`Enter ${label.toLowerCase()}…`}
        />
      </div>
    );
  }

  if (type === 'boolean') {
    return (
      <div className="flex items-center justify-between">
        <span className="text-body-md text-on-surface">{label}</span>
        <button type="button" role="switch" aria-checked={!!value} onClick={() => setField(formKey, !value)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${value ? 'bg-primary' : 'bg-outline-variant'}`}>
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
    );
  }

  if (type === 'number') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-label-md text-on-surface-variant">{label}</span>
        <input type="number" step="any" value={value} onChange={(e) => setField(formKey, e.target.value)} placeholder="0" className={inputBase} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-label-md text-on-surface-variant">{label}</span>
      <input type="text" value={value} onChange={(e) => setField(formKey, e.target.value)}
        placeholder={`Enter ${label.toLowerCase()}…`} className={`${inputBase} ${mono ? 'font-mono' : ''}`} />
    </div>
  );
}

// ===================== AttrDimensionsField =====================

function AttrDimensionsField({ label, attrKey, keys, labels, product, edit }) {
  const { isEditing, form, setField } = edit;
  const formKey = '_' + attrKey;
  const dims = isEditing ? (form[formKey] ?? {}) : (attr(product, attrKey) ?? {});

  if (!isEditing) {
    const parts = keys.map((k, i) => dims[k] != null ? `${labels[i]} ${dims[k]}` : null).filter(Boolean);
    return <Field label={label} value={parts.length > 0 ? parts.join(' × ') : null} />;
  }

  function updateDim(key, value) {
    setField(formKey, { ...dims, [key]: value });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-label-md text-on-surface-variant">{label}</span>
      <div className="flex items-center gap-2">
        {keys.map((k, i) => (
          <div key={k} className="flex-1">
            <input type="number" step="any" value={dims[k] ?? ''} onChange={(e) => updateDim(k, e.target.value)}
              placeholder={labels[i]}
              className="w-full px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors" />
            <span className="text-label-md text-on-surface-variant mt-0.5 block text-center">{labels[i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===================== AttrListField — for arrays of strings in attributes =====================

function AttrListField({ label, attrKey, product, edit, hint }) {
  const { isEditing, form, setField } = edit;

  if (!isEditing) {
    const raw = attr(product, attrKey);
    const items = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    if (items.length === 0) return <Field label={label} value={null} />;
    return (
      <div className="flex flex-col gap-1">
        <span className="text-label-md text-on-surface-variant">{label}</span>
        <div className="flex flex-wrap gap-2">
          {items.map((item, i) => (
            <span key={i} className="px-3 py-1 rounded-full bg-surface-container text-body-sm text-on-surface">{String(item)}</span>
          ))}
        </div>
      </div>
    );
  }

  // Edit as "A; B" text — buildPatch splits it back into an array.
  const formKey = '_' + attrKey;
  const value = form[formKey] ?? '';
  return (
    <div className="flex flex-col gap-1">
      <span className="text-label-md text-on-surface-variant">{label}</span>
      <input
        type="text"
        value={typeof value === 'string' ? value : joinList(value)}
        onChange={(e) => setField(formKey, e.target.value)}
        placeholder={`Enter ${label.toLowerCase()}…`}
        className="w-full px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
      />
      {hint && <span className="text-label-md text-on-surface-variant/70 mt-0.5">{hint}</span>}
    </div>
  );
}

// ===================== BulletPointsEditor — reads from attributes JSONB =====================

function BulletPointsEditor({ product, edit, attrKey = 'bullet_points' }) {
  const { isEditing, form, setField } = edit;
  const formKey = '_' + attrKey;
  const bullets = isEditing ? (form[formKey] ?? []) : (attr(product, attrKey) ?? []);

  if (!isEditing) {
    if (bullets.length === 0) return <p className="text-body-md text-on-surface-variant">No bullet points yet.</p>;
    return (
      <ol className="space-y-2">
        {bullets.map((b, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="text-label-md text-on-surface-variant mt-0.5 w-5 text-right flex-shrink-0">{i + 1}.</span>
            <span className="text-body-md text-on-surface">{b}</span>
          </li>
        ))}
      </ol>
    );
  }

  function updateBullet(index, value) {
    const next = [...bullets];
    next[index] = value;
    setField(formKey, next);
  }
  function addBullet() {
    if (bullets.length >= MAX_BULLETS) return;
    setField(formKey, [...bullets, '']);
  }
  function removeBullet(index) {
    setField(formKey, bullets.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-2">
      {bullets.map((b, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-label-md text-on-surface-variant w-5 text-right flex-shrink-0">{i + 1}.</span>
          <input type="text" value={b} onChange={(e) => updateBullet(i, e.target.value)} placeholder={`Feature ${i + 1}`}
            className="flex-1 px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors" />
          <button type="button" onClick={() => removeBullet(i)}
            className="p-1.5 rounded-full text-on-surface-variant hover:text-error hover:bg-error-container/40 transition-colors" title="Remove">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      {bullets.length < MAX_BULLETS && (
        <button type="button" onClick={addBullet}
          className="inline-flex items-center gap-1.5 text-body-sm text-primary hover:text-primary/80 transition-colors mt-1">
          <Plus className="w-4 h-4" /> Add bullet point
        </button>
      )}
    </div>
  );
}

// ===================== EditableField — for direct columns =====================

function EditableField({ label, fieldKey, type = 'text', product, edit, mono, options }) {
  const { isEditing, form, setField } = edit;

  if (!isEditing) {
    let displayValue = product[fieldKey];
    if (type === 'currency') return <Field label={label} value={formatCAD(displayValue)} />;
    if (type === 'date') return <Field label={label} value={formatDate(displayValue)} />;
    if (type === 'select' && options) {
      const opt = options.find((o) => o.value === displayValue);
      return <Field label={label} value={opt?.label ?? formatCategory(displayValue)} />;
    }
    if (type === 'boolean') {
      return (
        <div className="flex items-center justify-between">
          <span className="text-body-md text-on-surface">{label}</span>
          <span className={`text-body-sm font-medium ${displayValue ? 'text-success' : 'text-on-surface-variant'}`}>{displayValue ? 'Yes' : 'No'}</span>
        </div>
      );
    }
    if (type === 'richtext') {
      if (!displayValue) return <Field label={label} value={null} />;
      return (
        <div className="flex flex-col gap-1">
          <span className="text-label-md text-on-surface-variant">{label}</span>
          <div className="text-body-md text-on-surface prose-content" dangerouslySetInnerHTML={{ __html: displayValue }} />
        </div>
      );
    }
    if (type === 'textarea') {
      if (!displayValue) return <Field label={label} value={null} />;
      return (
        <div className="flex flex-col gap-1">
          <span className="text-label-md text-on-surface-variant">{label}</span>
          <p className="text-body-md text-on-surface whitespace-pre-wrap">{displayValue}</p>
        </div>
      );
    }
    return <Field label={label} value={displayValue} mono={mono} />;
  }

  const value = form[fieldKey];
  const inputBase = 'w-full px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors';

  if (type === 'richtext') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-label-md text-on-surface-variant">{label}</span>
        <RichTextEditor value={value} onChange={(html) => setField(fieldKey, html)} placeholder={`Enter ${label.toLowerCase()}…`} minRows={4} />
      </div>
    );
  }
  if (type === 'textarea') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-label-md text-on-surface-variant">{label}</span>
        <textarea value={value} onChange={(e) => setField(fieldKey, e.target.value)} rows={3} className={inputBase + ' resize-y'} placeholder={`Enter ${label.toLowerCase()}…`} />
      </div>
    );
  }
  if (type === 'boolean') {
    return (
      <div className="flex items-center justify-between">
        <span className="text-body-md text-on-surface">{label}</span>
        <button type="button" role="switch" aria-checked={!!value} onClick={() => setField(fieldKey, !value)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${value ? 'bg-primary' : 'bg-outline-variant'}`}>
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
    );
  }
  if (type === 'select' && options) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-label-md text-on-surface-variant">{label}</span>
        <select value={value} onChange={(e) => setField(fieldKey, e.target.value)} className={inputBase}>
          <option value="">—</option>
          {options.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
        </select>
      </div>
    );
  }
  if (type === 'date') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-label-md text-on-surface-variant">{label}</span>
        <input type="date" value={value ? value.slice(0, 10) : ''} onChange={(e) => setField(fieldKey, e.target.value || null)} className={inputBase} />
      </div>
    );
  }
  if (type === 'number' || type === 'currency') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-label-md text-on-surface-variant">{label}</span>
        <input type="number" step={type === 'currency' ? '0.01' : 'any'} value={value} onChange={(e) => setField(fieldKey, e.target.value)} placeholder="0" className={inputBase} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-label-md text-on-surface-variant">{label}</span>
      <input type="text" value={value} onChange={(e) => setField(fieldKey, e.target.value)}
        placeholder={`Enter ${label.toLowerCase()}…`} className={`${inputBase} ${mono ? 'font-mono' : ''}`} />
    </div>
  );
}

function EditableDocFlag({ label, fieldKey, product, edit }) {
  const { isEditing, form, setField } = edit;
  const needsUpdate = isEditing ? form[fieldKey] : product[fieldKey];
  if (isEditing) {
    return (
      <div className="flex items-center justify-between">
        <span className="text-body-md text-on-surface">{label}</span>
        <button type="button" role="switch" aria-checked={!!needsUpdate} onClick={() => setField(fieldKey, !needsUpdate)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${needsUpdate ? 'bg-warning' : 'bg-success'}`}>
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${needsUpdate ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between">
      <span className="text-body-md text-on-surface">{label}</span>
      <span className={`flex items-center gap-1.5 text-body-sm ${needsUpdate ? 'text-on-warning-container' : 'text-success'}`}>
        <span className={`w-2 h-2 rounded-full ${needsUpdate ? 'bg-warning' : 'bg-success'}`} />
        {needsUpdate ? 'Needs update' : 'Up to date'}
      </span>
    </div>
  );
}

// ===================== Read-only field =====================

function Field({ label, value, mono = false }) {
  const display = value && value !== '—' ? value : <span className="text-on-surface-variant">—</span>;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-label-md text-on-surface-variant">{label}</span>
      <span className={`text-body-md text-on-surface ${mono ? 'font-mono' : ''}`}>{display}</span>
    </div>
  );
}

// ===================== Section =====================

function Section({ title, children, defaultOpen = true }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <button type="button" onClick={() => setIsOpen(!isOpen)} aria-expanded={isOpen}
        className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-surface-container-low transition-colors">
        <h2 className="text-title-lg text-on-surface">{title}</h2>
        <ChevronDown className={`w-5 h-5 text-on-surface-variant transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      <div className={`grid transition-all duration-200 ease-in-out ${isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="px-6 pb-6 pt-1 space-y-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

function WixLinkBadge({ product }) {
  if (!product.wix_product_id) {
    return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-surface-container text-body-sm text-on-surface-variant">Not linked to Wix</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-tertiary-container/40 text-body-sm text-on-surface"
      title={`Wix product id: ${product.wix_product_id}`}>
      <CheckCircle2 className="w-3.5 h-3.5 text-tertiary" />
      Wix · synced {product.wix_synced_at ? formatTimeAgo(product.wix_synced_at) : 'never'}
    </span>
  );
}

function ProductHeroImage({ primary }) {
  if (primary) {
    return (
      <div className="w-full sm:w-60 max-w-[240px] aspect-square rounded-xl overflow-hidden bg-surface-container flex-shrink-0 mx-auto sm:mx-0 border border-outline-variant">
        <img src={getThumbnailUrl(primary.storage_path, 480)} alt={primary.alt_text || ''} className="w-full h-full object-cover" />
      </div>
    );
  }
  return (
    <div className="w-full sm:w-60 max-w-[240px] aspect-square rounded-xl bg-surface-container-low border-2 border-dashed border-outline-variant flex items-center justify-center flex-shrink-0 mx-auto sm:mx-0">
      <div className="text-center text-on-surface-variant px-4">
        <Camera className="w-10 h-10 mx-auto mb-2 opacity-40" strokeWidth={1.5} />
        <span className="text-body-sm block">No image yet</span>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Skeleton className="h-6 w-32 mb-4" />
      <div className="flex gap-6 mb-6">
        <Skeleton className="w-60 h-60 rounded-xl" />
        <div className="flex-1"><Skeleton className="h-6 w-32 mb-3" /><Skeleton className="h-12 w-96 mb-2" /><Skeleton className="h-6 w-64" /></div>
      </div>
      <Skeleton className="h-10 w-full rounded-lg mb-6" />
      <div className="space-y-4"><Skeleton className="h-32 w-full rounded-xl" /><Skeleton className="h-32 w-full rounded-xl" /></div>
    </div>
  );
}

function NotFoundState({ sku }) {
  return (
    <div className="p-6 max-w-6xl mx-auto text-center py-24">
      <h1 className="text-display-lg text-on-surface mb-2">Product not found</h1>
      <p className="text-body-md text-on-surface-variant mb-6">The SKU "{sku}" doesn't exist in the catalog.</p>
      <Link to="/catalog" className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold">
        <ArrowLeft className="w-4 h-4" /> Back to Catalog
      </Link>
    </div>
  );
}

function ErrorState({ error }) {
  return (
    <div className="p-6 max-w-6xl mx-auto text-center py-24">
      <h1 className="text-display-lg text-on-surface mb-2">Failed to load product</h1>
      <p className="text-body-md text-error mb-6">{error.message}</p>
      <Link to="/catalog" className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold">
        <ArrowLeft className="w-4 h-4" /> Back to Catalog
      </Link>
    </div>
  );
}
