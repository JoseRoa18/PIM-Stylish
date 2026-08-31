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
  ExternalLink,
  Sparkles,
  Loader2,
} from 'lucide-react';
import { formatTimeAgo } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { pushProductToWix, readWixProduct, createProductOnWix, pushMediaToWix } from '../api/wixSync';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { useWixCollections } from '../hooks/useWixCollections';
import RichTextEditor from '@/components/ui/RichTextEditor';
import ProductHealthBadge from '@/features/dashboard/components/ProductHealthBadge';
import { useAuth } from '@/features/auth/AuthContext';
import { deriveWixSectionsFromPim } from '../lib/wixInfoSections';
import { WIX_SITES, DEFAULT_WIX_SITE } from '../lib/wixSites';

// Each group has an icon and a short summary string. Colors stay on the
// brand palette — accents come from interaction state, not per-section hues.
// Built per site: the pricing group carries the site's own selling-price
// column (SinksDirect → MAP, Stylish → MSRP, market currency), sale fields
// only where the PIM's CAD sale columns apply, and the categories picker
// only where the PIM stores that site's collection ids (SinksDirect CA).
function makeFieldGroups(cfg) {
  return [
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
      summary: cfg.hasSale ? 'Price, sale' : 'Price',
      fields: [
        { key: cfg.priceField, label: cfg.priceLabel, type: 'currency', symbol: cfg.symbol, hint: cfg.priceHint },
        ...(cfg.hasSale
          ? [
              { key: 'on_sale', label: 'On sale', type: 'boolean', hint: 'Show a discounted price on the Wix store.' },
              { key: 'sale_price_cad', label: 'Sale price (CAD)', type: 'currency', symbol: cfg.symbol, dependsOn: 'on_sale' },
            ]
          : []),
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
    ...(cfg.hasCollections
      ? [{
          key: 'categories',
          title: 'Categories',
          icon: Tag,
          summary: 'Wix collections this product belongs to',
          fields: [
            { key: 'wix_collection_ids', label: 'Wix categories', type: 'collections' },
          ],
        }]
      : []),
    {
      key: 'sections',
      title: 'Additional info sections',
      icon: FileText,
      summary: 'Dimensions, features, documents',
      fields: [
        {
          key: 'additional_info_sections',
          label: 'Sections',
          type: 'sections',
          hint: 'Dimensions and Features are rebuilt from the PIM (measurements and bullets); document links are repointed to PIM files when a matching one exists — unmatched links keep their old URL.',
        },
      ],
    },
  ];
}

export default function WixSyndicationCard({ product, media, onUpdate, site = DEFAULT_WIX_SITE }) {
  const cfg = WIX_SITES[site] ?? WIX_SITES[DEFAULT_WIX_SITE];
  const fieldGroups = useMemo(() => makeFieldGroups(cfg), [cfg]);
  // Viewers see the link status and health, never the edit-&-push surface.
  const { canEdit } = useAuth();
  const confirm = useConfirm();
  const [form, setForm] = useState(() => buildForm(product, fieldGroups));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaMsg, setMediaMsg] = useState(null);
  const [success, setSuccess] = useState(false);
  const [openGroups, setOpenGroups] = useState(() => new Set());
  // Card expansion — collapsed by default; user expands to see/edit fields.
  const [cardExpanded, setCardExpanded] = useState(false);

  // Per-site link (wix_links table). The legacy products.wix_product_id
  // column doubles as the SinksDirect CA link, so that site renders linked
  // instantly; other sites resolve after the fetch. undefined = loading.
  const legacyLink = cfg.key === DEFAULT_WIX_SITE && product?.wix_product_id
    ? { wix_product_id: product.wix_product_id, synced_at: product.wix_synced_at }
    : null;
  const [link, setLink] = useState(undefined);
  useEffect(() => {
    let active = true;
    supabase
      .from('wix_links')
      .select('wix_product_id, synced_at')
      .eq('site', cfg.key)
      .eq('sku', product.sku)
      .maybeSingle()
      .then(({ data, error: linkErr }) => {
        if (!active) return;
        if (linkErr) { setLink(null); return; }
        setLink(data ?? null);
      });
    return () => { active = false; };
  }, [product.sku, cfg.key]);

  // Live Wix data — the form shows what's in Wix right now.
  // wixBaseline = the unedited Wix values (for detecting user edits).
  const [wixBaseline, setWixBaseline] = useState(null);
  const [wixMedia, setWixMedia] = useState(null);
  const [wixUrl, setWixUrl] = useState(null);
  const [wixLoading, setWixLoading] = useState(false);
  // Live-read outcome: 'missing' = product no longer exists in Wix (broken
  // link); 'error' = couldn't reach Wix (transient). null = OK / not read yet.
  const [wixStatus, setWixStatus] = useState(null);

  const effectiveLink = link === undefined ? legacyLink : (link ?? legacyLink);
  const linked = Boolean(effectiveLink);
  const linkLoading = link === undefined && !legacyLink;

  useEffect(() => {
    if (!linked) return;
    let active = true;
    setWixLoading(true);
    setWixStatus(null);
    readWixProduct(product.sku, cfg.key)
      .then((res) => {
        if (!active) return;
        if (!res || res.exists === false) {
          setWixStatus('missing');
          return;
        }
        const snap = res.snapshot;
        if (snap) {
          const built = buildForm(snap, fieldGroups);
          setWixBaseline(built);
          setForm(built);
          if (Array.isArray(snap._wix_media)) setWixMedia(snap._wix_media);
          if (snap.product_url) setWixUrl(snap.product_url);
        }
      })
      .catch(() => { if (active) setWixStatus('error'); })
      .finally(() => { if (active) setWixLoading(false); });
    return () => { active = false; };
  }, [product.sku, linked, cfg.key]);

  const wixMissing = wixStatus === 'missing';

  // "Edited" = user changed something vs what Wix currently has
  const baseline = wixBaseline ?? buildForm(product, fieldGroups);

  // What the listing's sections SHOULD say per the PIM: Dimensions from the
  // measurement attributes, Features from bullet_points, document links
  // repointed at the PIM's files (old URL kept when there's no match).
  const derivedSections = useMemo(
    () =>
      deriveWixSectionsFromPim(
        product,
        media,
        (wixBaseline ?? buildForm(product, fieldGroups)).additional_info_sections,
      ),
    [product, media, wixBaseline, fieldGroups],
  );
  // The sections field's "differs from PIM" comparison runs against the
  // derived value — the raw PIM column just mirrors the last push.
  const pimView = useMemo(
    () => ({ ...product, additional_info_sections: derivedSections.sections }),
    [product, derivedSections],
  );
  const [sectionsMsg, setSectionsMsg] = useState(null);

  function rebuildSections() {
    const { sections, changes } = derivedSections;
    setField('additional_info_sections', sections);
    const parts = [];
    if (changes.dimensions) parts.push('Dimensions rebuilt');
    if (changes.features) parts.push('Features rebuilt from bullets');
    if (changes.docsReplaced || changes.docsKept) {
      parts.push(
        `Documents: ${changes.docsReplaced} link${changes.docsReplaced === 1 ? '' : 's'} repointed to PIM files, ${changes.docsKept} kept`,
      );
    }
    setSectionsMsg(
      parts.length
        ? `${parts.join(' · ')} — review below, then Push.`
        : 'Nothing to rebuild — this product has no PIM measurements, bullets, or matching documents.',
    );
  }
  const dirtyByGroup = useMemo(() => {
    const out = {};
    for (const g of fieldGroups) {
      out[g.key] = g.fields.filter(
        (f) => !valuesEqual(form[f.key], baseline[f.key]),
      ).length;
    }
    return out;
  }, [form, baseline, fieldGroups]);
  const totalDirty = Object.values(dirtyByGroup).reduce((a, b) => a + b, 0);
  const dirty = totalDirty > 0;

  // "Differs from PIM" = Wix value ≠ PIM value (informational)
  const pimDiffsByGroup = useMemo(() => {
    const out = {};
    for (const g of fieldGroups) {
      out[g.key] = g.fields.filter(
        (f) => !valuesEqual(form[f.key], pimView?.[f.key]),
      ).length;
    }
    return out;
  }, [form, pimView, fieldGroups]);
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
    setOpenGroups(new Set(fieldGroups.map((g) => g.key)));
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
      const result = await pushProductToWix(product.sku, form, undefined, cfg.key);

      // Update the baseline so the form no longer shows as "edited"
      setWixBaseline({ ...form });

      const syncedAt = result?.wix_synced_at ?? new Date().toISOString();
      setLink((prev) => (prev ? { ...prev, synced_at: syncedAt } : prev));
      // The legacy PIM timestamp only mirrors the SinksDirect CA site.
      if (cfg.key === DEFAULT_WIX_SITE) {
        onUpdate({ wix_synced_at: syncedAt });
      }

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
    setForm(wixBaseline ?? buildForm(product, fieldGroups));
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
            <h3 className="text-title-lg text-on-surface leading-tight">{cfg.label}</h3>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              Wix Stores · sells at {cfg.priceShort} · edit the fields below, then push to update.
            </p>
            {wixUrl && !wixMissing && (
              <a
                href={wixUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 mt-2 text-body-sm font-medium text-primary hover:underline"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                View product in store
              </a>
            )}
          </div>
        </div>
        <StatusBadge linked={linked} loading={linkLoading} missing={wixMissing} syncedAt={effectiveLink?.synced_at} />
      </header>

      {linked && wixMissing ? (
        <div className="px-8 pb-5">
          <BrokenLinkNotice />
        </div>
      ) : linked ? (
        <div className="px-8 pb-5 space-y-3">
          {wixStatus === 'error' && (
            <p className="text-body-sm text-on-surface-variant flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 text-warning flex-shrink-0" />
              No se pudo leer el estado en Wix — mostrando datos del PIM.
            </p>
          )}
          <ProductHealthBadge
            product={product}
            media={wixMedia ?? media}
            overrides={form}
          />
        </div>
      ) : null}

      {canEdit && linked && !wixMissing && (
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

      {linkLoading ? (
        <div className="px-8 pb-8 text-body-sm text-on-surface-variant">Checking link…</div>
      ) : !linked ? (
        <div className="px-8 pb-8">
          <NotLinkedNotice
            product={product}
            site={cfg}
            canEdit={canEdit}
            onLinked={(patch, wixId) => {
              setLink({ wix_product_id: wixId, synced_at: new Date().toISOString() });
              if (cfg.key === DEFAULT_WIX_SITE) onUpdate?.(patch);
            }}
          />
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

          {/* Wix gallery + push-from-PIM. The button REPLACES the Wix gallery
              with the PIM's images (primary first; Wix caps ~16 per product
              and ingests asynchronously, so new images take ~30s to show). */}
          <div className="px-6 pt-5">
            <div className="flex items-center gap-3 flex-wrap mb-2">
              <span className="text-label-md text-on-surface-variant">
                Images on Wix{wixMedia ? ` (${wixMedia.length})` : ''}
              </span>
              {canEdit && (
                <button
                  type="button"
                  onClick={async () => {
                    const count = (media ?? []).filter((m) => m.media_type === 'image').length;
                    if (!count) { setMediaMsg({ tone: 'error', text: 'No images in the PIM to push.' }); return; }
                    const ok = await confirm({
                      title: `Push ${product.sku}'s images to Wix?`,
                      message: `Replaces the product's Wix gallery with the PIM's ${count} image${count === 1 ? '' : 's'} (primary first — Wix keeps at most ~16). Wix takes ~30 seconds to ingest them.`,
                      confirmLabel: 'Push images',
                    });
                    if (!ok) return;
                    setMediaBusy(true);
                    setMediaMsg(null);
                    try {
                      const res = await pushMediaToWix(product.sku, cfg.key);
                      const setLabel = { en_fr: 'EN/FR', en: 'EN', en_es_universal: 'EN/ES + universal' }[res.language_set] ?? '';
                      const parts = [`Sent ${res.added} ${setLabel} image${res.added === 1 ? '' : 's'}`];
                      if (res.skipped_other_language) parts.push(`${res.skipped_other_language} other-language skipped`);
                      if (res.over_wix_cap) parts.push(`${res.over_wix_cap} may be dropped by Wix's ~16 cap`);
                      setMediaMsg({
                        tone: 'success',
                        text: `${parts.join(' · ')} — Wix ingests them in ~30s; reload to see them here.`,
                      });
                    } catch (err) {
                      setMediaMsg({ tone: 'error', text: err.message ?? 'Image push failed' });
                    } finally {
                      setMediaBusy(false);
                    }
                  }}
                  disabled={mediaBusy || busy}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-md font-medium text-primary hover:bg-primary-container/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {mediaBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
                  {mediaBusy ? 'Pushing…' : 'Push images from PIM'}
                </button>
              )}
              {mediaMsg && (
                <span className={`text-body-sm ${mediaMsg.tone === 'error' ? 'text-error' : 'text-on-surface-variant'}`}>
                  {mediaMsg.text}
                </span>
              )}
            </div>
            {wixMedia && wixMedia.length > 0 && <WixImagesPreview images={wixMedia} />}
          </div>

          {/* Groups */}
          <div className="px-6 py-5 space-y-2 bg-surface-container-low/30">
            {fieldGroups.map((group) => (
              <FieldGroup
                key={group.key}
                group={group}
                form={form}
                product={pimView}
                baseline={baseline}
                onChange={setField}
                disabled={busy}
                sectionsRebuild={{ onRebuild: rebuildSections, msg: sectionsMsg }}
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

function FieldGroup({ group, form, product, baseline, onChange, disabled, isOpen, onToggle, dirtyCount, pimDiffCount, sectionsRebuild }) {
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
                sectionsRebuild={field.type === 'sections' ? sectionsRebuild : null}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================== Field renderers ==============================

function FieldInput({ field, value, baselineValue, pimValue, onChange, disabled, sectionsRebuild }) {
  const isEdited = !valuesEqual(value, baselineValue);
  const pimDiffers = field.type === 'richtext'
    ? textOfHtml(value) !== textOfHtml(pimValue)
    : !valuesEqual(value, pimValue);

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
        {pimDiffers && <PimHint value={pimValue} type="boolean" symbol={field.symbol} />}
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
        <div className="space-y-2">
          <RichTextEditor
            value={value ?? ''}
            onChange={onChange}
            disabled={disabled}
            placeholder="Type here…"
            minRows={field.rows ?? 5}
          />
          <AiFormatButton value={value} onChange={onChange} disabled={disabled} />
        </div>
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
            {field.symbol ?? 'C$'}
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
        <div className="space-y-3">
          {sectionsRebuild && (
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={sectionsRebuild.onRebuild}
                disabled={disabled}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline-variant bg-surface text-label-lg font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                <RefreshCw className="w-3.5 h-3.5" strokeWidth={2} />
                Rebuild from PIM
              </button>
              {sectionsRebuild.msg && (
                <span className="text-body-sm text-on-surface-variant">
                  {sectionsRebuild.msg}
                </span>
              )}
            </div>
          )}
          <SectionsEditor
            value={Array.isArray(value) ? value : []}
            onChange={onChange}
            disabled={disabled}
            pimSections={pimValue}
          />
        </div>
      )}
      {field.hint && (
        <p className="text-body-sm text-on-surface-variant mt-2 max-w-prose">
          {field.hint}
        </p>
      )}
      {pimDiffers && field.type === 'richtext' && textOfHtml(pimValue) !== '' && (
        <div className="mt-2 rounded-xl border border-outline-variant/60 overflow-hidden">
          <SectionPimHint
            html={pimValue}
            actionLabel="Use PIM value"
            onApply={disabled ? null : () => onChange(pimValue)}
          />
        </div>
      )}
      {pimDiffers && field.type !== 'richtext' && <PimHint value={pimValue} type={field.type} symbol={field.symbol} />}
    </div>
  );
}

// AI formatting: paragraphs + bolds only. The edge function guarantees the
// wording is untouched (tag-stripped output must equal the input).
function AiFormatButton({ value, onChange, disabled }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const hasText = String(value ?? '').replace(/<[^>]*>/g, ' ').trim().length > 0;
  if (!hasText) return null;

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke('ai-format-html', {
        body: { text: value },
      });
      if (error) {
        // Surface the function's own message, not the generic non-2xx one.
        let message = error.message;
        try { message = (await error.context.json())?.error ?? message; } catch { /* keep generic */ }
        throw new Error(message);
      }
      if (data?.error) throw new Error(data.error);
      onChange(data.html);
      setMsg('Formatted — same words, new layout.');
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <button
        type="button"
        onClick={run}
        disabled={disabled || busy}
        title="Bolds and paragraphs only — never changes the words."
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40 disabled:pointer-events-none"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />}
        Auto-format
      </button>
      {msg && <span className="text-body-sm text-on-surface-variant">{msg}</span>}
    </div>
  );
}

function PimHint({ value, type, symbol }) {
  let display;
  if (type === 'boolean') {
    display = value ? 'Yes' : 'No';
  } else if (type === 'currency') {
    display = value != null ? `${symbol ?? 'C$'} ${Number(value).toFixed(2)}` : '—';
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
          <div className="max-h-64 overflow-y-auto" data-lenis-prevent>
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

function SectionsEditor({ value, onChange, disabled, pimSections }) {
  function update(idx, key, v) {
    onChange(value.map((s, i) => (i === idx ? { ...s, [key]: v } : s)));
  }
  function add() {
    onChange([...value, { title: '', description: '' }]);
  }
  function remove(idx) {
    onChange(value.filter((_, i) => i !== idx));
  }

  const normTitle = (t) => String(t ?? '').trim().toUpperCase();
  const pimByTitle = new Map(
    (Array.isArray(pimSections) ? pimSections : []).map((s) => [normTitle(s.title), s]),
  );
  // PIM-derivable sections the listing doesn't have yet.
  const missingFromListing = (Array.isArray(pimSections) ? pimSections : []).filter(
    (s) => !value.some((v) => normTitle(v.title) === normTitle(s.title)),
  );

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
          {(() => {
            const pim = pimByTitle.get(normTitle(section.title));
            if (!pim || valuesEqual(section.description, pim.description)) return null;
            return (
              <SectionPimHint
                html={pim.description}
                actionLabel="Use PIM value"
                onApply={disabled ? null : () => update(i, 'description', pim.description)}
              />
            );
          })()}
        </div>
      ))}
      {missingFromListing.map((pim) => (
        <div
          key={`missing-${pim.title}`}
          className="rounded-xl border border-dashed border-outline-variant bg-surface overflow-hidden"
        >
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-outline-variant/60 bg-surface-container-low/40">
            <span className="flex-1 px-2 py-1 text-body-md text-on-surface-variant font-medium">
              {pim.title}
            </span>
            <span className="text-label-md text-on-surface-variant/70">Not on Wix yet</span>
          </div>
          <SectionPimHint
            html={pim.description}
            actionLabel="Add from PIM"
            onApply={disabled ? null : () => onChange([...value, { ...pim }])}
          />
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

// The sections counterpart of PimHint: shown under a section whose content
// differs from what the PIM derives — current value stays in the editor
// above, the PIM's version renders here with a one-click apply.
function SectionPimHint({ html, actionLabel, onApply }) {
  return (
    <div className="border-t border-outline-variant/60 bg-primary-container/15 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-label-md text-on-surface-variant flex items-center gap-1.5">
          <span className="w-1 h-1 rounded-full bg-primary inline-block flex-shrink-0" />
          PIM
        </p>
        {onApply && (
          <button
            type="button"
            onClick={onApply}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-label-md font-medium text-primary hover:bg-primary-container/60 transition-colors"
          >
            <RotateCcw className="w-3 h-3" strokeWidth={2} />
            {actionLabel}
          </button>
        )}
      </div>
      <div
        className="mt-2 max-h-56 overflow-y-auto text-body-sm text-on-surface-variant [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_li]:my-0.5 [&_a]:text-primary [&_a]:underline [&_strong]:text-on-surface"
        dangerouslySetInnerHTML={{ __html: html ?? '' }}
      />
    </div>
  );
}

// ============================== Status / notices ==============================

function StatusBadge({ linked, loading, missing, syncedAt }) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-container text-body-sm text-on-surface-variant">
        <RefreshCw className="w-3 h-3 animate-spin" />
        Checking…
      </span>
    );
  }
  if (!linked) {
    return (
      <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-container text-body-sm text-on-surface-variant">
        <span className="w-1.5 h-1.5 rounded-full bg-on-surface-variant/50" />
        Not linked
      </span>
    );
  }
  if (missing) {
    return (
      <span
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-error-container/50 text-body-sm text-on-error-container"
        title="El producto ya no existe en Wix — el enlace está roto"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-error" />
        Enlace roto
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

function BrokenLinkNotice() {
  return (
    <div className="rounded-xl border border-error/30 bg-error-container/30 overflow-hidden">
      <div className="px-4 py-3 flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-error flex-shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-body-md font-semibold text-on-surface">
            Listing Health — no verificable
          </p>
          <p className="text-body-sm text-on-surface-variant mt-1">
            Este producto tiene un ID de Wix guardado, pero ya no existe en la tienda
            (Wix respondió 404). El enlace está roto, así que no se puede evaluar el
            estado real del listado. Vuelve a enlazarlo desde{' '}
            <Link to="/syndication" className="font-semibold underline hover:no-underline">
              Syndication
            </Link>{' '}
            o quita el enlace obsoleto.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The unlinked state doubles as the CREATE surface: the PIM comes first, and
 * whoever owns the Wix channel publishes each new product deliberately from
 * here. Created hidden — a later push flips visibility when it's ready. If
 * Wix already has the SKU (never linked), the function links instead of
 * duplicating, and this card flips straight into the update/diff view.
 */
function NotLinkedNotice({ product, site, canEdit, onLinked }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleCreate() {
    setError(null);
    const ok = await confirm({
      title: `Create ${product.sku} on ${site.label}?`,
      message: `The product is created HIDDEN on the site with the PIM's name, description, price (${site.priceLabel}), weight and brand — customers won't see it until you push it visible. If the site already has this SKU, it links to it instead of creating a duplicate.`,
      confirmLabel: 'Create on Wix',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await createProductOnWix(product.sku, site.key);
      // The parent flips this card straight into the linked update/diff view.
      onLinked?.({ wix_product_id: res.id, wix_synced_at: new Date().toISOString() }, res.id);
    } catch (err) {
      setError(err.message ?? 'Create failed');
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-secondary-container bg-secondary-container/40 p-5">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-secondary flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-body-md text-on-secondary-container font-semibold">
            Not on {site.label} yet
          </p>
          <p className="text-body-sm text-on-secondary-container mt-1">
            Create it from here (it starts hidden), or go to{' '}
            <Link to="/syndication" className="font-semibold underline hover:no-underline">
              Syndication
            </Link>{' '}
            and run <em>Preview Link with Wix</em> if it already exists on the site.
          </p>
          {error && <p className="text-body-sm text-error mt-2">{error}</p>}
          {canEdit && (
            <button
              type="button"
              onClick={handleCreate}
              disabled={busy}
              className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-on-primary text-label-md font-semibold hover:bg-primary/90 transition-colors disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed"
            >
              {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {busy ? 'Creating…' : 'Create on Wix'}
            </button>
          )}
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

function buildForm(product, fieldGroups) {
  const out = {};
  for (const group of fieldGroups) {
    for (const field of group.fields) {
      const key = field.key;
      const v = product?.[key];
      if (key === 'wix_collection_ids') {
        out[key] = Array.isArray(v) ? [...v] : [];
      } else if (key === 'additional_info_sections') {
        out[key] = Array.isArray(v) ? v.map((s) => ({ ...s })) : [];
      } else {
        out[key] = v ?? (typeof v === 'boolean' ? v : null);
      }
      if (field.type === 'boolean' && out[key] == null) {
        out[key] = false;
      }
    }
  }
  return out;
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

// Semantic fingerprint of an HTML snippet: visible text plus link targets.
// TipTap restructures markup it merely passes through (wraps <li> content in
// <p>, appends trailing-break paragraphs), so two snippets can differ as
// strings while being the same content — this is the tiebreaker.
function htmlSignature(value) {
  if (typeof value !== 'string') return String(value ?? '');
  if (typeof document === 'undefined' || !value.includes('<')) {
    return String(value).replace(/\s+/g, ' ').trim();
  }
  const tmp = document.createElement('div');
  // A space before every tag keeps words apart across <br>/<li>/<p>
  // boundaries once tags are stripped ("A<br>B" → "A B", not "AB").
  tmp.innerHTML = String(value).replace(/</g, ' <');
  const links = [...tmp.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href'))
    .join('|');
  const text = (tmp.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${text}::${links}`;
}

// Rich text compares CONTENT, not markup — Wix and the PIM disagree on
// wrapper tags and whitespace even when the words match.
const textOfHtml = (html) =>
  String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

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
  // Strings that look like HTML — normalized comparison first, semantic
  // (text + links) fallback for editor-canonicalization differences.
  if (typeof a === 'string' && typeof b === 'string') {
    if (a.includes('<') || b.includes('<')) {
      return normalizeHtml(a) === normalizeHtml(b) || htmlSignature(a) === htmlSignature(b);
    }
    return a === b;
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return String(a) === String(b);
}
