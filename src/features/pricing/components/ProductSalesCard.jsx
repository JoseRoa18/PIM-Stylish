import { useEffect, useId, useState } from 'react';
import { STOCK_MARKETS, onOrder, stockAge } from '@/features/pricing/api/inventory';
import { getSalesFor, daysOfStock, daysOfStockText, salesChannels } from '@/features/pricing/api/sales';

// Sales and stock of one product, per market (user, 2026-11-11: "unidades de
// 30 y 90 días en la página del producto, y días de inventario"): what Odoo
// sold in the last 30 and 90 days, by marketplace, next to the stock, what is
// on order and how long the stock lasts at that pace. Read-only: Odoo's
// numbers, cached by odoo-sales-pull (sales) and inventory-pull (stock).
const units = (n) => (Number.isInteger(Number(n)) ? String(n) : Number(n).toFixed(1));

function Stat({ label, value, tone }) {
  return (
    <div className="min-w-0">
      <dt className="text-label-md text-on-surface-variant">{label}</dt>
      <dd className={`text-title-md font-semibold tabular-nums ${tone === 'bad' ? 'text-error' : 'text-on-surface'}`}>{value}</dd>
    </div>
  );
}

function Market({ market, stock, sales }) {
  const label = STOCK_MARKETS[market];
  const coming = onOrder(stock);
  const channels = salesChannels(sales);
  const days = daysOfStock(stock, sales);
  const out = stock && stock.available <= 0;
  return (
    <div className="rounded-lg border border-outline-variant/70 p-4 min-w-0">
      <h3 className="text-title-md text-on-surface font-semibold">{label}</h3>
      <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
        <Stat label="In stock" value={stock ? stock.available : 'Not tracked'} tone={out ? 'bad' : undefined} />
        <Stat label="Sold in 30 days" value={sales ? units(sales.units_30) : '0'} />
        <Stat label="Sold in 90 days" value={sales ? units(sales.units_90) : '0'} />
        <Stat label="Stock lasts" value={daysOfStockText(days)} tone={days != null && days < 30 ? 'bad' : undefined} />
      </dl>
      {coming && (
        <p className="mt-3 text-body-sm text-on-surface-variant">
          {coming.qty != null ? `${coming.qty} on order · ` : ''}
          {coming.late
            ? <span className="text-error">was due {coming.day} — late in Odoo</span>
            : <>expected {coming.day}</>}
        </p>
      )}
      {channels.length > 0 ? (
        <div className="relative mt-3 overflow-x-auto">
          <table className="w-full text-body-sm">
            <caption className="sr-only">{label}: units sold by marketplace</caption>
            <thead>
              <tr className="text-label-md text-on-surface-variant">
                <th scope="col" className="text-left font-medium py-1 pr-3">Marketplace</th>
                <th scope="col" className="text-right font-medium py-1 px-2">30 days</th>
                <th scope="col" className="text-right font-medium py-1 pl-2">90 days</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.name} className="border-t border-outline-variant/40">
                  <th scope="row" className="text-left font-normal text-on-surface py-1 pr-3">{c.name}</th>
                  <td className="text-right tabular-nums text-on-surface py-1 px-2">{units(c.u30)}</td>
                  <td className="text-right tabular-nums text-on-surface py-1 pl-2">{units(c.u90)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 text-body-sm text-on-surface-variant">No sales in the last 90 days.</p>
      )}
    </div>
  );
}

/** `stock`: { ca, us } rows of product_inventory (null = not tracked), undefined while loading. */
export default function ProductSalesCard({ sku, stock }) {
  const titleId = useId();
  const [sales, setSales] = useState(undefined); // undefined while loading

  useEffect(() => {
    let active = true;
    getSalesFor([sku])
      .then((map) => { if (active) setSales({ ca: map.ca[sku] ?? null, us: map.us[sku] ?? null, failed: false }); })
      .catch(() => { if (active) setSales({ ca: null, us: null, failed: true }); });
    return () => { active = false; };
  }, [sku]);

  if (sales === undefined || stock === undefined) return null;
  const synced = sales.ca?.synced_at ?? sales.us?.synced_at ?? null;
  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-outline-variant bg-surface-container-lowest px-6 py-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 id={titleId} className="text-title-lg text-on-surface">Sales and stock</h2>
        <p className="text-body-sm text-on-surface-variant">
          {sales.failed ? 'The sales could not be read.' : `From Odoo${synced ? ` · sales read ${stockAge(synced)}` : ''}`}
        </p>
      </div>
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Market market="ca" stock={stock.ca} sales={sales.ca} />
        <Market market="us" stock={stock.us} sales={sales.us} />
      </div>
    </section>
  );
}
