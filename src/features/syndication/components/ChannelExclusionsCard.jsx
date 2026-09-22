import { useState } from 'react';
import { Ban } from 'lucide-react';
import { MARKETPLACES } from '../lib/marketplaces';
import { updateProduct } from '@/features/products/api/products';
import { useAuth } from '@/features/auth/AuthContext';

// Per-product marketplace exclusions (rule 2026-09-22): a product switched
// off for a marketplace gets nothing there — no content or media pushes,
// no new listing, no template export, no promotion file or promo push.
export default function ChannelExclusionsCard({ product, onUpdate }) {
  const { canEdit } = useAuth();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const excluded = new Set(product.channel_exclusions ?? []);

  async function toggle(key) {
    const next = new Set(excluded);
    if (next.has(key)) next.delete(key); else next.add(key);
    setBusy(key);
    setError(null);
    try {
      const keys = [...next].sort();
      await updateProduct(product.sku, { channel_exclusions: keys });
      // The tab merges patches into the in-memory product (no refetch).
      onUpdate?.({ channel_exclusions: keys });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  const byMarket = (m) => MARKETPLACES.filter((c) => c.market === m);

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-8 py-5 border-b border-outline-variant flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-surface-container-highest text-on-surface-variant flex items-center justify-center flex-shrink-0">
          <Ban className="w-4 h-4" />
        </div>
        <div>
          <h2 className="text-title-lg text-on-surface leading-tight">Excluded marketplaces</h2>
          <p className="text-body-sm text-on-surface-variant mt-0.5">
            A switched-on marketplace gets nothing for this product: no pushes, listings, files or promotions.
            {excluded.size ? ` Excluded on ${excluded.size}.` : ' Not excluded anywhere.'}
          </p>
        </div>
      </div>
      <div className="px-8 py-5 grid sm:grid-cols-2 gap-x-10 gap-y-1">
        {[['ca', 'Canada'], ['us', 'USA']].map(([m, label]) => (
          <div key={m}>
            <div className="text-label-sm text-on-surface-variant mb-1">{label}</div>
            <ul className="divide-y divide-outline-variant/60">
              {byMarket(m).map((c) => {
                const on = excluded.has(c.key);
                return (
                  <li key={c.key} className="flex items-center justify-between gap-3 py-2">
                    <span className="flex items-center gap-2.5 min-w-0">
                      <span className="w-7 h-7 rounded-lg bg-surface-container-high text-on-surface-variant flex items-center justify-center text-label-sm font-bold flex-shrink-0">{c.monogram}</span>
                      <span className={`text-body-md truncate ${on ? 'text-on-surface' : 'text-on-surface-variant'}`}>{c.label}</span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={`Exclude from ${c.label}`}
                      disabled={!canEdit || busy != null}
                      onClick={() => toggle(c.key)}
                      title={on ? `Excluded from ${c.label}` : `Active on ${c.label}`}
                      className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${on ? 'bg-error' : 'bg-outline-variant'}`}
                    >
                      <span className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-surface shadow transition-transform" style={{ transform: on ? 'translateX(16px)' : 'translateX(0)' }} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      {error && <p className="px-8 pb-4 text-body-sm text-error">{error}</p>}
    </section>
  );
}
