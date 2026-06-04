import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera, Layers, Settings, X, Plus, Search, Loader2, Check } from 'lucide-react';
import { useVariants } from '../hooks/useVariants';
import { getMediaUrl } from '@/features/media/api/media';
import { formatCAD } from '@/lib/format';
import { searchProducts, updateProduct, getProduct } from '../api/products';
import { supabase } from '@/lib/supabase';

export default function VariantsSection({ product, onProductChanged }) {
  const { variants, loading, reload } = useVariants(product.sku, product.family_number);
  const [managing, setManaging] = useState(false);

  if (!product.family_number) {
    return (
      <section className="rounded-xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
        <header className="px-6 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-on-surface-variant" />
            <h2 className="text-title-lg text-on-surface">Variants</h2>
          </div>
          <button
            type="button"
            onClick={() => setManaging(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
          >
            <Plus className="w-3.5 h-3.5" />
            Link to variants
          </button>
        </header>
        <div className="px-6 pb-6">
          <p className="text-body-sm text-on-surface-variant">
            This product is not in any variant family yet. Click <span className="font-medium text-on-surface">Link to variants</span> to group it with related products (different color, finish, gauge, or accessories).
          </p>
        </div>

        {managing && (
          <LinkToFamilyDialog
            product={product}
            onClose={() => setManaging(false)}
            onChanged={() => onProductChanged?.()}
          />
        )}
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-on-surface-variant" />
            <h2 className="text-title-lg text-on-surface">Variants</h2>
            <span className="text-label-md text-on-surface-variant">
              · Family {product.family_number}
            </span>
          </div>
          <p className="text-body-sm text-on-surface-variant mt-1">
            Other products in the same family — different color, finish, gauge, or accessories.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setManaging(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant text-body-sm text-on-surface hover:bg-surface-container-low transition-colors"
        >
          <Settings className="w-3.5 h-3.5" />
          Manage
        </button>
      </header>

      {loading ? (
        <div className="px-6 py-8 text-center text-body-sm text-on-surface-variant">
          <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
          Loading variants…
        </div>
      ) : variants.length === 0 ? (
        <div className="px-6 py-8 text-center">
          <p className="text-body-md text-on-surface">No other variants yet.</p>
          <p className="text-body-sm text-on-surface-variant mt-1">
            Click "Manage" to add products with different color, gauge, or accessories.
          </p>
        </div>
      ) : (
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {variants.map((v) => (
            <VariantCard key={v.sku} variant={v} current={product} onRemove={async () => {
              if (!window.confirm(`Remove "${v.model_name || v.sku}" from this variant family?`)) return;
              await updateProduct(v.sku, { family_number: null });
              reload();
              onProductChanged?.();
            }} />
          ))}
        </div>
      )}

      {managing && (
        <ManageVariantsDialog
          product={product}
          variants={variants}
          onClose={() => setManaging(false)}
          onChanged={() => {
            reload();
            onProductChanged?.();
          }}
        />
      )}
    </section>
  );
}

function VariantCard({ variant, current, onRemove }) {
  const diffs = computeDiffs(variant, current);

  return (
    <div className="relative group">
      <Link
        to={`/catalog/${variant.sku}`}
        className="flex gap-3 p-3 rounded-xl border border-outline-variant bg-surface hover:border-primary/40 hover:shadow-sm transition-all"
      >
        <Thumb image={variant.primary_image} alt={variant.model_name} />
        <div className="min-w-0 flex-1">
          <div className="text-body-md text-on-surface font-medium truncate pr-6">
            {variant.model_name || variant.sku}
          </div>
          <div className="text-body-sm text-on-surface-variant font-mono">{variant.sku}</div>
          {diffs.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {diffs.map((d) => (
                <span
                  key={d.label}
                  className="inline-flex items-center px-2 py-0.5 rounded text-label-md bg-primary-container/40 text-on-primary-container"
                  title={`${d.label}: ${d.value}`}
                >
                  <span className="text-on-surface-variant mr-1">{d.label}:</span>
                  {d.value}
                </span>
              ))}
            </div>
          )}
          {variant.msrp_cad != null && (
            <div className="text-body-sm text-on-surface-variant mt-1.5">
              {formatCAD(variant.msrp_cad)}
            </div>
          )}
        </div>
      </Link>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
        className="absolute top-2 right-2 p-1 rounded-full bg-surface text-on-surface-variant opacity-0 group-hover:opacity-100 hover:bg-error-container hover:text-on-error-container transition-all"
        title="Remove from variant family"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function ManageVariantsDialog({ product, variants, onClose, onChanged }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(null);

  async function runSearch(q) {
    setQuery(q);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const found = await searchProducts(q, 15);
      const excludedSkus = new Set([product.sku, ...variants.map((v) => v.sku)]);
      setResults(found.filter((r) => !excludedSkus.has(r.sku)));
    } catch (err) {
      console.error(err);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function handleAdd(sku) {
    setBusy(sku);
    try {
      await updateProduct(sku, { family_number: product.family_number });
      setResults((prev) => prev.filter((r) => r.sku !== sku));
      onChanged();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(sku) {
    if (!window.confirm('Remove this product from the variant family?')) return;
    setBusy(sku);
    try {
      await updateProduct(sku, { family_number: null });
      onChanged();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-2xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-4 border-b border-outline-variant flex items-center justify-between">
          <div>
            <h3 className="text-title-lg text-on-surface">Manage Variants</h3>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              Family {product.family_number} · add or remove products from this group
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full text-on-surface-variant hover:bg-surface-container-low transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="overflow-y-auto flex-1 px-6 py-4">
          {/* Current variants */}
          {variants.length > 0 && (
            <div className="mb-5">
              <h4 className="text-label-md text-on-surface-variant mb-2">Currently in this family</h4>
              <ul className="space-y-1.5">
                {variants.map((v) => (
                  <li
                    key={v.sku}
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-outline-variant bg-surface-container-lowest"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-body-md text-on-surface truncate">{v.model_name || v.sku}</div>
                      <div className="text-body-sm text-on-surface-variant font-mono">{v.sku}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemove(v.sku)}
                      disabled={busy === v.sku}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-label-md text-error hover:bg-error-container/40 transition-colors disabled:opacity-50"
                    >
                      {busy === v.sku ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Add new */}
          <div>
            <h4 className="text-label-md text-on-surface-variant mb-2">Add a product to this family</h4>
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
              <input
                type="text"
                value={query}
                onChange={(e) => runSearch(e.target.value)}
                placeholder="Search by SKU or name…"
                autoFocus
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
            </div>

            {searching && (
              <div className="text-body-sm text-on-surface-variant py-3 text-center">
                <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                Searching…
              </div>
            )}

            {!searching && query && results.length === 0 && (
              <p className="text-body-sm text-on-surface-variant py-3 text-center">
                No matching products.
              </p>
            )}

            {results.length > 0 && (
              <ul className="space-y-1.5">
                {results.map((r) => (
                  <li
                    key={r.sku}
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-outline-variant bg-surface hover:border-primary/40 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-body-md text-on-surface truncate">{r.model_name || r.sku}</div>
                      <div className="text-body-sm text-on-surface-variant">
                        <span className="font-mono">{r.sku}</span>
                        {r.brand ? <span> · {r.brand}</span> : null}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleAdd(r.sku)}
                      disabled={busy === r.sku}
                      className="inline-flex items-center gap-1 px-3 py-1 rounded-md text-label-md font-medium text-on-primary bg-primary hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      {busy === r.sku ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                      Add
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <footer className="px-6 py-3 border-t border-outline-variant flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-full text-body-md text-on-surface hover:bg-surface-container-low transition-colors"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

function LinkToFamilyDialog({ product, onClose, onChanged }) {
  const [tab, setTab] = useState('existing'); // 'existing' | 'new'
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [newFamily, setNewFamily] = useState('');

  async function runSearch(q) {
    setQuery(q);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const found = await searchProducts(q, 15);
      setResults(found.filter((r) => r.sku !== product.sku));
    } catch (err) {
      console.error(err);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  // Link to an existing product → take its family_number (or create one if it has none too)
  async function handleLinkToExisting(otherSku) {
    setBusy(true);
    setError(null);
    try {
      const other = await getProduct(otherSku);
      let familyNum = other?.family_number;

      // If the other product doesn't have a family yet, generate one and assign to both
      if (familyNum == null) {
        familyNum = await getNextFamilyNumber();
        await updateProduct(otherSku, { family_number: familyNum });
      }

      await updateProduct(product.sku, { family_number: familyNum });
      onChanged();
      onClose();
    } catch (err) {
      setError(err.message ?? 'Failed to link');
    } finally {
      setBusy(false);
    }
  }

  // Set a specific family number manually
  async function handleSetFamily() {
    const n = parseInt(newFamily, 10);
    if (isNaN(n) || n < 1) {
      setError('Please enter a positive number.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateProduct(product.sku, { family_number: n });
      onChanged();
      onClose();
    } catch (err) {
      setError(err.message ?? 'Failed to set family');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-2xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-4 border-b border-outline-variant flex items-center justify-between">
          <div>
            <h3 className="text-title-lg text-on-surface">Link to variants</h3>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              Group this product with related variants
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full text-on-surface-variant hover:bg-surface-container-low transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="border-b border-outline-variant px-6">
          <nav className="flex gap-1">
            <button
              type="button"
              onClick={() => setTab('existing')}
              className={`px-4 py-3 text-body-sm border-b-2 -mb-px transition-colors ${
                tab === 'existing'
                  ? 'border-primary text-primary font-semibold'
                  : 'border-transparent text-on-surface-variant hover:text-on-surface'
              }`}
            >
              Link to an existing product
            </button>
            <button
              type="button"
              onClick={() => setTab('new')}
              className={`px-4 py-3 text-body-sm border-b-2 -mb-px transition-colors ${
                tab === 'new'
                  ? 'border-primary text-primary font-semibold'
                  : 'border-transparent text-on-surface-variant hover:text-on-surface'
              }`}
            >
              Set family number manually
            </button>
          </nav>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4">
          {tab === 'existing' ? (
            <>
              <p className="text-body-sm text-on-surface-variant mb-3">
                Search for another product. If it already has a family number, this product joins that family. If not, a new family is created and both products are linked.
              </p>
              <div className="relative mb-3">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => runSearch(e.target.value)}
                  placeholder="Search by SKU or name…"
                  autoFocus
                  className="w-full pl-9 pr-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                />
              </div>

              {searching && (
                <div className="text-body-sm text-on-surface-variant py-3 text-center">
                  <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                  Searching…
                </div>
              )}

              {!searching && query && results.length === 0 && (
                <p className="text-body-sm text-on-surface-variant py-3 text-center">
                  No matching products.
                </p>
              )}

              {results.length > 0 && (
                <ul className="space-y-1.5">
                  {results.map((r) => (
                    <li
                      key={r.sku}
                      className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-outline-variant bg-surface hover:border-primary/40 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-body-md text-on-surface truncate">{r.model_name || r.sku}</div>
                        <div className="text-body-sm text-on-surface-variant">
                          <span className="font-mono">{r.sku}</span>
                          {r.brand ? <span> · {r.brand}</span> : null}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleLinkToExisting(r.sku)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 px-3 py-1 rounded-md text-label-md font-medium text-on-primary bg-primary hover:opacity-90 transition-opacity disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                        Link
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <p className="text-body-sm text-on-surface-variant mb-3">
                Enter a family number to assign to this product. Other products with the same number will appear as variants.
              </p>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={newFamily}
                  onChange={(e) => setNewFamily(e.target.value)}
                  placeholder="e.g. 14"
                  min="1"
                  autoFocus
                  className="flex-1 px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                />
                <button
                  type="button"
                  onClick={handleSetFamily}
                  disabled={busy || !newFamily}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-on-primary text-body-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Set
                </button>
              </div>
            </>
          )}

          {error && (
            <p className="text-body-sm text-error mt-3">{error}</p>
          )}
        </div>

        <footer className="px-6 py-3 border-t border-outline-variant flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-full text-body-md text-on-surface hover:bg-surface-container-low transition-colors"
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

async function getNextFamilyNumber() {
  const { data, error } = await supabase
    .from('products')
    .select('family_number')
    .not('family_number', 'is', null)
    .order('family_number', { ascending: false })
    .limit(1);
  if (error) throw error;
  const max = data?.[0]?.family_number ?? 0;
  return max + 1;
}

function Thumb({ image, alt }) {
  if (!image?.storage_path) {
    return (
      <div className="w-24 h-24 rounded-lg bg-surface-container border border-outline-variant flex items-center justify-center flex-shrink-0">
        <Camera className="w-5 h-5 text-on-surface-variant opacity-40" strokeWidth={1.5} />
      </div>
    );
  }
  return (
    <div className="w-24 h-24 rounded-lg overflow-hidden bg-surface-container-low border border-outline-variant flex-shrink-0 flex items-center justify-center">
      <img
        src={getMediaUrl(image.storage_path)}
        alt={alt || ''}
        loading="lazy"
        className="w-full h-full object-contain"
      />
    </div>
  );
}

function computeDiffs(variant, current) {
  const diffs = [];

  const fields = [
    { key: 'finish', label: 'Finish' },
    { key: 'color', label: 'Color' },
    { key: 'material', label: 'Material' },
  ];
  for (const f of fields) {
    if (variant[f.key] && variant[f.key] !== current[f.key]) {
      diffs.push({ label: f.label, value: variant[f.key] });
    }
  }

  const va = variant.attributes ?? {};
  const ca = current.attributes ?? {};
  const attrFields = [
    { key: 'gauge', label: 'Gauge' },
    { key: 'accessories_color', label: 'Accessories' },
    { key: 'number_of_bowls', label: 'Bowls' },
    { key: 'bowl_configuration', label: 'Config' },
  ];
  for (const f of attrFields) {
    if (va[f.key] != null && va[f.key] !== ca[f.key]) {
      diffs.push({ label: f.label, value: String(va[f.key]) });
    }
  }

  return diffs.slice(0, 4);
}
