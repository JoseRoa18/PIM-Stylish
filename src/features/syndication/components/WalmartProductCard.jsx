import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';

// What Walmart knows about this product, from the latest snapshot of the
// market's channel:
//   ca — feed presence, and the regular + promo price while a promotion exists
//        (Walmart's item APIs do not serve the Canadian catalog).
//   us — the item itself: price (USD), publish status and lifecycle. The US
//        seller account was reopened on 2026-09-22 with an empty catalog.
const MARKETS = {
  ca: { title: 'Walmart Canada', currency: 'C$', mapField: 'map_cad', mapLabel: 'PIM MAP CAD', shield: 'Promos via API' },
  us: { title: 'Walmart USA', currency: 'US$', mapField: 'map_usd', mapLabel: 'PIM MAP USD', shield: 'Read-only' },
};

const money = (cur, v) => (v != null && v !== '' ? `${cur}${Number(v).toFixed(2)}` : '—');

export default function WalmartProductCard({ product, row, loading, market = 'ca' }) {
  const m = MARKETS[market] ?? MARKETS.ca;
  const isCa = market === 'ca';
  const promo = isCa && row?.discount_price != null;

  let subtitle;
  if (loading) subtitle = 'Reading the latest snapshot…';
  else if (!row) subtitle = isCa ? 'Not in the inventory feed' : 'Not on Walmart USA yet';
  else if (isCa) subtitle = `In the inventory feed · ${row.feedStatus === 'SUCCESS' ? 'updating OK' : row.feedStatus}`;
  else subtitle = `Listed · ${row.published || 'status unknown'}${row.lifecycle ? ` · ${row.lifecycle}` : ''}`;

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-8 py-5 border-b border-outline-variant flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-brand-walmart/10 text-brand-walmart flex items-center justify-center text-label-lg font-bold flex-shrink-0">WM</div>
          <div>
            <h2 className="text-title-lg text-on-surface leading-tight">{m.title}</h2>
            <p className="text-body-sm text-on-surface-variant mt-0.5">{subtitle}</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-container-high text-on-surface-variant text-label-sm">
          <ShieldCheck className="w-3.5 h-3.5" /> {m.shield}
        </span>
      </div>
      <div className="px-8 py-5 space-y-2">
        {row && isCa && (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div><dt className="text-label-md text-on-surface-variant">Regular on Walmart</dt><dd className="text-body-md text-on-surface tabular-nums">{row.price != null ? money(m.currency, row.price) : 'unknown until a promo runs'}</dd></div>
            <div><dt className="text-label-md text-on-surface-variant">Promo on Walmart</dt><dd className="text-body-md text-on-surface tabular-nums">{promo ? money(m.currency, row.discount_price) : 'none'}</dd></div>
            <div><dt className="text-label-md text-on-surface-variant">Promo window</dt><dd className="text-body-md text-on-surface">{promo ? `${row.discount_start} to ${row.discount_end}` : '—'}</dd></div>
            <div><dt className="text-label-md text-on-surface-variant">{m.mapLabel}</dt><dd className="text-body-md text-on-surface tabular-nums">{money(m.currency, product[m.mapField])}</dd></div>
          </dl>
        )}
        {row && !isCa && (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div><dt className="text-label-md text-on-surface-variant">Price on Walmart</dt><dd className="text-body-md text-on-surface tabular-nums">{money(m.currency, row.price)}</dd></div>
            <div><dt className="text-label-md text-on-surface-variant">{m.mapLabel}</dt><dd className="text-body-md text-on-surface tabular-nums">{money(m.currency, product[m.mapField])}</dd></div>
            <div><dt className="text-label-md text-on-surface-variant">Published</dt><dd className="text-body-md text-on-surface">{row.published || '—'}</dd></div>
            <div><dt className="text-label-md text-on-surface-variant">Lifecycle</dt><dd className="text-body-md text-on-surface">{row.lifecycle || '—'}</dd></div>
          </dl>
        )}
        {!row && !loading && !isCa && (
          <p className="text-body-sm text-on-surface-variant">
            The US seller account is new and its catalog is being rebuilt. Listing from the PIM by API is in preparation; until then, items are set up in Seller Center.
          </p>
        )}
        <p className="text-body-sm text-on-surface-variant">
          {isCa
            ? <>Regular price and promotions are compared in <Link to="/pricing" className="text-primary hover:underline">Pricing</Link>. Promotions are scheduled there, per promotion.</>
            : <>Prices are compared in <Link to="/pricing" className="text-primary hover:underline">Pricing</Link>. Promotions go out as the Walmart USA promo file from the Promotions panel.</>}
        </p>
      </div>
    </section>
  );
}
