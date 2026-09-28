import { Package } from 'lucide-react';
import { STOCK_MARKETS, describeStock } from '@/features/pricing/api/inventory';

/**
 * Stock chip for one product and market: units available in that market's
 * source (ShipStation for the USA, the Canada inventory file for Canada), 0
 * — with the file's ETA when it has one —, or "not tracked" (no row:
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
    : `${label} stock · ${stock.available}${out && stock.eta ? ` · ETA ${stock.eta}` : ''}`;
  return (
    <span title={describeStock(stock, market)} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-body-sm font-medium whitespace-nowrap ${cls}`}>
      <Package className="w-3.5 h-3.5" strokeWidth={2} />
      {text}
    </span>
  );
}
