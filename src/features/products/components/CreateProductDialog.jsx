import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Loader2, AlertCircle } from 'lucide-react';
import { createProduct } from '../api/products';
import { syncVariantFamilies } from '../api/variantFamilies';
import Dialog from '@/components/ui/Dialog';

const CATEGORY_OPTIONS = [
  { value: 'kitchen_sink', label: 'Kitchen Sink' },
  { value: 'bathroom_sink', label: 'Bathroom Sink' },
  { value: 'kitchen_faucet', label: 'Kitchen Faucet' },
  { value: 'bathroom_faucet', label: 'Bathroom Faucet' },
  { value: 'pot_filler', label: 'Pot Filler' },
  { value: 'bar_prep_sink', label: 'Bar/Prep Sink' },
  { value: 'outdoor_sink', label: 'Outdoor Sink & Ice Chest' },
  { value: 'accessory', label: 'Accessory' },
];

const inputClass =
  'w-full px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors';

export default function CreateProductDialog({ onClose }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    sku: '',
    model_name: '',
    brand: 'Stylish',
    category: 'kitchen_sink',
    series: '',
    msrp_cad: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const canSubmit = form.sku.trim() && form.brand.trim() && form.category && !busy;

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createProduct(form);
      // Auto-group with siblings that share the SKU base model (S-300XG → S-300).
      try {
        await syncVariantFamilies([created.sku]);
      } catch (syncErr) {
        console.error('Variant family sync failed (non-fatal):', syncErr);
      }
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-label-md text-on-surface-variant">
                SKU <span className="text-error">*</span>
              </span>
              <input
                type="text"
                value={form.sku}
                onChange={(e) => setField('sku', e.target.value)}
                placeholder="e.g. S-845W"
                autoFocus
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

          </div>

          <p className="text-body-sm text-on-surface-variant">
            Variants are grouped automatically: products sharing the SKU base model
            (e.g. <span className="font-mono">S-300XG</span> and <span className="font-mono">S-300TG</span>) become a family.
          </p>

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
