import { Link } from 'react-router-dom';
import { Package, ArrowRight } from 'lucide-react';
import { statusMeta, STATUS_ORDER } from '@/features/products/lib/workflowStatus';
import DonutChart from './charts/DonutChart';

/**
 * Pipeline state of the catalog — the workflow-status donut. Composition
 * breakdowns (brands, categories, price averages) live in the Catalog page;
 * the Dashboard only keeps the number that changes week to week.
 */
export default function CatalogStatusCard({ data }) {
  const { total, byStatus } = data;

  // Every status present gets a segment so the donut always sums to the
  // total — unknown statuses fall back to a neutral grey with a real label.
  const orderedKeys = [
    ...STATUS_ORDER.filter((k) => byStatus[k] > 0),
    ...Object.keys(byStatus).filter((k) => !STATUS_ORDER.includes(k) && byStatus[k] > 0),
  ];
  const segments = orderedKeys.map((k) => {
    const meta = statusMeta(k);
    return { key: k, label: meta.label, value: byStatus[k], stroke: meta.stroke, dot: meta.dot };
  });

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden flex flex-col">
      <Link
        to="/catalog"
        className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-2 hover:bg-surface-container-low/40 transition-colors group"
      >
        <span className="flex items-center gap-2">
          <Package className="w-4 h-4 text-on-surface-variant" />
          <span className="text-title-md text-on-surface">Catalog</span>
        </span>
        <span className="inline-flex items-center gap-1 text-label-md text-primary">
          Open catalog
          <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </span>
      </Link>

      {/* flex-1 + items-center: the card stretches to its grid neighbor's
          height, so the donut sits in the vertical middle instead of leaving
          the bottom half empty. The legend is capped so each value stays at a
          scannable distance from its label. */}
      <div className="px-6 py-5 flex-1 flex items-center">
        {segments.length > 0 ? (
          <div className="flex items-center gap-6 w-full">
            <DonutChart data={segments} centerValue={total} centerLabel="products" />
            <ul className="space-y-1.5 min-w-0 w-full max-w-[240px]">
              {segments.map((s) => (
                <li key={s.key} className="flex items-center gap-2 text-label-md">
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${s.dot}`} />
                  <span className="text-on-surface-variant truncate">{s.label}</span>
                  <span className="text-on-surface font-semibold tabular-nums ml-auto">{s.value}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-body-sm text-on-surface-variant py-6 text-center w-full">No products yet.</p>
        )}
      </div>
    </section>
  );
}
