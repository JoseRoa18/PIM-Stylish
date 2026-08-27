import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Loader2, AlertCircle, Copy, X, Search } from 'lucide-react';
import { createProduct, cloneProduct, searchProducts } from '../api/products';
import { syncVariantFamilies } from '../api/variantFamilies';
import { autoLinkChannels } from '@/features/syndication/api/autoLink';
import Dialog from '@/components/ui/Dialog';

const CATEGORY_OPTIONS = [
  { value: 'kitchen_sink', label: 'Kitchen Sink' },
  { value: 'bathroom_sink', label: 'Bathroom Sink' },
  { value: 'kitchen_faucet', label: 'Kitchen Faucet' },
  { value: 'bathroom_faucet', label: 'Bathroom Faucet' },
  { value: 'pot_filler', label: 'Pot Filler' },
  { value: 'bar_prep_sink', label: 'Bar/Prep Sink' },
  { value: 'laundry_sink', label: 'Laundry Sink' },
  { value: 'outdoor_sink', label: 'Outdoor Sink & Ice Chest' },
  { value: 'colander_drying_rack', label: 'Colanders & Drying Racks' },
  { value: 'accessory', label: 'Accessory' },
];

const inputClass =
  'w-full px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors';

export default function CreateProductDialog({ onClose, cloneSource = null }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState(cloneSource ? 'clone' : 'new'); // 'new' | 'clone'
  const [form, setForm] = useState({
    sku: '',
    model_name: cloneSource?.model_name ?? '',
    brand: 'Stylish',
    category: 'kitchen_sink',
    series: '',
    msrp_cad: '',
  });
  // Clone mode: source product picked via typeahead (or preset by caller).
  const [source, setSource] = useState(cloneSource);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (mode !== 'clone' || source || !query.trim()) { setResults([]); return; }
    let active = true;
    const t = setTimeout(() => {
      searchProducts(query, 6)
        .then((r) => { if (active) setResults(r); })
        .catch(() => {});
    }, 250);
    return () => { active = false; clearTimeout(t); };
  }, [query, mode, source]);

  const canSubmit = mode === 'clone'
    ? Boolean(source && form.sku.trim()) && !busy
    : Boolean(form.sku.trim() && form.brand.trim() && form.category) && !busy;

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const created = mode === 'clone'
        ? await cloneProduct(source.sku, form.sku, {
            model_name: form.model_name.trim() || undefined,
          })
        : await createProduct(form);
      // Auto-group with siblings that share the SKU base model (S-300XG → S-300).
      try {
        await syncVariantFamilies([created.sku]);
      } catch (syncErr) {
        console.error('Variant family sync failed (non-fatal):', syncErr);
      }
      // Fire-and-forget: link the new product to every API-connected channel
      // where it already exists (Wix by SKU, Wayfair group id). Results land
      // in the Activity Log and on the product's Marketplaces tab.
      autoLinkChannels(created.sku).catch((err) =>
        console.error('Channel auto-link failed (non-fatal):', err),
      );
      // Land on the new product's detail page so the user can fill the rest.
      navigate(`/catalog/${encodeURIComponent(created.sku)}`);
    } catch (err) {
      setError(err.message ?? 'Failed to create product');
      setBusy(false);
    }
  }

  return (
    <Dialog
      as="form"
      onSubmit={handleSubmit}
      onClose={onClose}
      title="New Product"
      subtitle="Start with the basics — you can fill everything else on the product page."
      maxWidth="max-w-lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-full border border-outline-variant text-body-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-primary text-on-primary text-body-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {busy ? 'Creating…' : 'Create Product'}
          </button>
        </>
      }
    >
        <div className="space-y-4">
          <div className="inline-flex w-full rounded-lg bg-surface-container p-1">
            {[['new', 'From scratch'], ['clone', 'Clone existing']].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => { setMode(key); setError(null); }}
                className={`flex-1 px-3 py-1.5 rounded-md text-label-lg font-medium transition-colors ${
                  mode === key ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === 'clone' && (
            <div className="space-y-3">
              {source ? (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary-container/30 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-body-md font-semibold text-on-surface font-mono">{source.sku}</div>
                    <div className="text-body-sm text-on-surface-variant truncate">
                      {[source.model_name, source.brand].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setSource(null); setQuery(''); setForm((f) => ({ ...f, model_name: '' })); }}
                    className="p-1.5 rounded-full hover:bg-surface-container text-on-surface-variant flex-shrink-0"
                    title="Choose another product"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-label-md text-on-surface-variant">
                      Product to clone <span className="text-error">*</span>
                    </span>
                    <div className="relative">
                      <Search className="w-4 h-4 text-on-surface-variant absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search by SKU or name…"
                        autoFocus
                        className={`${inputClass} pl-9`}
                      />
                    </div>
                  </label>
                  {results.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full rounded-xl border border-outline-variant bg-surface shadow-lg overflow-hidden">
                      {results.map((r) => (
                        <button
                          key={r.sku}
                          type="button"
                          onClick={() => { setSource(r); setResults([]); setForm((f) => ({ ...f, model_name: r.model_name ?? '' })); }}
                          className="w-full px-4 py-2.5 text-left hover:bg-surface-container-low transition-colors"
                        >
                          <span className="font-mono text-body-md text-on-surface">{r.sku}</span>
                          <span className="text-body-sm text-on-surface-variant ml-2">{r.model_name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <p className="text-body-sm text-on-surface-variant flex items-start gap-1.5">
                <Copy className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                Copies everything — attributes, descriptions, bullets, pricing, and the family's
                shared videos/documents. Images and marketplace links are not copied.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-label-md text-on-surface-variant">
                {mode === 'clone' ? 'New SKU' : 'SKU'} <span className="text-error">*</span>
              </span>
              <input
                type="text"
                value={form.sku}
                onChange={(e) => setField('sku', e.target.value)}
                placeholder="e.g. S-845W"
                autoFocus={mode === 'new'}
                className={`${inputClass} font-mono`}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-label-md text-on-surface-variant">Model Name</span>
              <input
                type="text"
                value={form.model_name}
                onChange={(e) => setField('model_name', e.target.value)}
                placeholder="e.g. Versa45"
                className={inputClass}
              />
            </label>

            {mode === 'new' && (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-label-md text-on-surface-variant">
                    Brand <span className="text-error">*</span>
                  </span>
                  <input
                    type="text"
                    value={form.brand}
                    onChange={(e) => setField('brand', e.target.value)}
                    className={inputClass}
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-label-md text-on-surface-variant">
                    Category <span className="text-error">*</span>
                  </span>
                  <select
                    value={form.category}
                    onChange={(e) => setField('category', e.target.value)}
                    className={inputClass}
                  >
                    {CATEGORY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-label-md text-on-surface-variant">Series</span>
                  <input
                    type="text"
                    value={form.series}
                    onChange={(e) => setField('series', e.target.value)}
                    placeholder="e.g. Versa"
                    className={inputClass}
                  />
                </label>
              </>
            )}

          </div>

          <p className="text-body-sm text-on-surface-variant">
            Variants are grouped automatically: products sharing the SKU base model
            (e.g. <span className="font-mono">S-300XG</span> and <span className="font-mono">S-300TG</span>) become a family.
          </p>

          {mode === 'new' && (
            <label className="flex flex-col gap-1.5">
              <span className="text-label-md text-on-surface-variant">MSRP (CAD)</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.msrp_cad}
                onChange={(e) => setField('msrp_cad', e.target.value)}
                placeholder="0.00"
                className={inputClass}
              />
            </label>
          )}

          {error && (
            <div className="px-3 py-2.5 rounded-lg bg-error-container text-on-error-container text-body-sm flex items-center gap-2 animate-banner-in">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}
        </div>
    </Dialog>
  );
}
