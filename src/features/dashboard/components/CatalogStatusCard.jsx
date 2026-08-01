import { Link } from 'react-router-dom';
import { Package, ArrowRight } from 'lucide-react';
import { statusMeta, STATUS_ORDER } from '@/features/products/lib/workflowStatus';
import { formatCategory } from '@/lib/format';
import DonutChart from './charts/DonutChart';

const TOP_CATEGORIES = 6;

/**
 * Pipeline state of the catalog: the workflow-status donut (legend rows jump
 * to the catalog pre-filtered) plus a top-categories breakdown so the card
 * earns its height next to Launch Pipeline. Deeper composition (brands,
 * price averages) still lives in the Catalog page.
 */
export default function CatalogStatusCard({ data }) {
  const { total, byStatus, byCategory = {} } = data;

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

  const categories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const topCategories = categories.slice(0, TOP_CATEGORIES);
  const restCount = categories.length - topCategories.length;
  const maxCategory = topCategories[0]?.[1] ?? 1;

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

      <div className="px-6 py-5 flex items-center">
        {segments.length > 0 ? (
          <div className="flex items-center gap-6 w-full">
            <DonutChart data={segments} centerValue={total} centerLabel="products" />
            <ul className="space-y-1 min-w-0 w-full max-w-[240px]">
              {segments.map((s) => (
                <li key={s.key}>
                  <Link
                    to={`/catalog?status=${encodeURIComponent(s.key)}`}
                    className="flex items-center gap-2 text-label-md px-1.5 py-1 -mx-1.5 rounded-lg hover:bg-surface-container-low transition-colors"
                    title={`View ${s.label} products in the catalog`}
                  >
                    <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${s.dot}`} />
                    <span className="text-on-surface-variant truncate">{s.label}</span>
                    <span className="text-on-surface font-semibold tabular-nums ml-auto">{s.value}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-body-sm text-on-surface-variant py-6 text-center w-full">No products yet.</p>
        )}
      </div>

      {topCategories.length > 0 && (
        <div className="px-6 pt-4 pb-5 border-t border-outline-variant flex-1">
          <p className="text-label-md text-on-surface-variant mb-3">By category</p>
          <ul className="space-y-2.5">
            {topCategories.map(([key, count]) => (
              <li key={key}>
                <Link
                  to={`/catalog?category=${encodeURIComponent(key)}`}
                  className="block group/cat"
                  title={`View ${formatCategory(key)} in the catalog`}
                >
                  <div className="flex items-center justify-between gap-2 text-label-md mb-1">
                    <span className="text-on-surface-variant group-hover/cat:text-on-surface truncate transition-colors">
                      {formatCategory(key)}
                    </span>
                    <span className="text-on-surface font-semibold tabular-nums">{count}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-surface-container overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary/70 group-hover/cat:bg-primary transition-colors"
                      style={{ width: `${Math.max(3, (count / maxCategory) * 100)}%` }}
                    />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {restCount > 0 && (
            <p className="mt-2.5 text-label-sm text-on-surface-variant">
              +{restCount} more categor{restCount === 1 ? 'y' : 'ies'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
