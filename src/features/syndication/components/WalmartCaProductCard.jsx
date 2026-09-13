import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';

// What Walmart Canada knows about this product, from the latest snapshot:
// feed presence, and the regular + promo price while a promotion exists.
export default function WalmartCaProductCard({ product, row, loading }) {
  const promo = row?.discount_price != null;
  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-8 py-5 border-b border-outline-variant flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-brand-walmart/10 text-brand-walmart flex items-center justify-center text-label-lg font-bold flex-shrink-0">WM</div>
          <div>
            <h2 className="text-title-lg text-on-surface leading-tight">Walmart Canada</h2>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              {loading ? 'Reading the latest snapshot…' : row ? `In the inventory feed · ${row.feedStatus === 'SUCCESS' ? 'updating OK' : row.feedStatus}` : 'Not in the inventory feed'}
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-container-high text-on-surface-variant text-label-sm">
          <ShieldCheck className="w-3.5 h-3.5" /> Promos via API
        </span>
      </div>
      <div className="px-8 py-5 space-y-2">
        {row && (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div><dt className="text-label-md text-on-surface-variant">Regular on Walmart</dt><dd className="text-body-md text-on-surface tabular-nums">{row.price != null ? `C$${Number(row.price).toFixed(2)}` : 'unknown until a promo runs'}</dd></div>
            <div><dt className="text-label-md text-on-surface-variant">Promo on Walmart</dt><dd className="text-body-md text-on-surface tabular-nums">{promo ? `C$${Number(row.discount_price).toFixed(2)}` : 'none'}</dd></div>
            <div><dt className="text-label-md text-on-surface-variant">Promo window</dt><dd className="text-body-md text-on-surface">{promo ? `${row.discount_start} to ${row.discount_end}` : '—'}</dd></div>
            <div><dt className="text-label-md text-on-surface-variant">PIM MAP CAD</dt><dd className="text-body-md text-on-surface tabular-nums">{product.map_cad != null ? `C$${Number(product.map_cad).toFixed(2)}` : '—'}</dd></div>
          </dl>
        )}
        <p className="text-body-sm text-on-surface-variant">
          Regular price and promotions are compared in <Link to="/pricing" className="text-primary hover:underline">Pricing</Link>. Promotions are scheduled there, per promotion.
        </p>
      </div>
    </section>
  );
}
