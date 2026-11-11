import { Package } from 'lucide-react';
import { STOCK_MARKETS, describeStock, arrivalText } from '@/features/pricing/api/inventory';

/**
 * Stock chip for one product and market: units available for use in that
 * market's Odoo warehouse (Canada CBG, USA ATL), 0 — with the date Odoo
 * expects more ("arrives Nov 27", "was due Oct 17") when units are on
 * order —, or "not tracked" (no row: Odoo does not have the product;
 * unknown, never zero). While `loading` the chip stays out of the way
 * instead of flashing "not tracked".
 */
export default function StockBadge({ stock, market, loading = false }) {
  if (loading) return null;
  const tracked = Boolean(stock);
  const out = tracked && stock.available <= 0;
  const cls = !tracked
    ? 'bg-surface-container text-on-surface-variant'
    : out
      ? 'bg-error-container/40 text-on-error-container'
      : 'bg-success/10 text-success';
  const label = STOCK_MARKETS[market] ?? market;
  const text = !tracked
    ? `${label} stock · not tracked`
    : `${label} stock · ${stock.available}${out && arrivalText(stock) ? ` · ${arrivalText(stock)}` : ''}`;
  return (
    <span title={describeStock(stock, market)} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-body-sm font-medium whitespace-nowrap ${cls}`}>
      <Package className="w-3.5 h-3.5" strokeWidth={2} />
      {text}
    </span>
  );
}
