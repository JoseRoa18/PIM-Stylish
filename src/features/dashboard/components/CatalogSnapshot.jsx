import { Package } from 'lucide-react';
import { formatCAD, formatCategory } from '@/lib/format';
import { statusMeta, STATUS_ORDER } from '@/features/products/lib/workflowStatus';
import DonutChart from './charts/DonutChart';
import BarList from './charts/BarList';

export default function CatalogSnapshot({ data }) {
  const { total, byStatus, byCategory, topBrands, avgPrice, totalValue } = data;

  // Build segments from EVERY status present so the donut always sums to the
  // total — known statuses get their palette, any unexpected one falls back
  // to a neutral grey with its real label (never silently dropped).
  const orderedKeys = [
    ...STATUS_ORDER.filter((k) => byStatus[k] > 0),
    ...Object.keys(byStatus).filter((k) => !STATUS_ORDER.includes(k) && byStatus[k] > 0),
  ];
  const statusSegments = orderedKeys.map((k) => {
    const meta = statusMeta(k);
    return { key: k, label: meta.label, value: byStatus[k], stroke: meta.stroke, dot: meta.dot };
  });

  const categoryItems = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([cat, count]) => ({ key: cat, label: formatCategory(cat), value: count }));

  const brandItems = topBrands.map((b) => ({ key: b.name, label: b.name, value: b.count }));

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6">
      <div className="flex items-center gap-2 mb-5">
        <Package className="w-4 h-4 text-on-surface-variant" />
        <h2 className="text-title-lg text-on-surface">Catalog Snapshot</h2>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <Stat label="Total Products" value={total} />
        <Stat label="Avg MSRP" value={formatCAD(avgPrice)} />
        <Stat label="Total Value" value={formatCAD(totalValue)} />
        <Stat label="Categories" value={Object.keys(byCategory).length} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Status donut */}
        <div>
          <h3 className="text-label-md text-on-surface-variant mb-3">By Workflow Status</h3>
          {statusSegments.length > 0 ? (
            <div className="flex items-center gap-5">
              <DonutChart data={statusSegments} centerValue={total} centerLabel="products" />
              <ul className="space-y-1.5 min-w-0">
                {statusSegments.map((s) => (
                  <li key={s.key} className="flex items-center gap-2 text-label-md">
                    <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${s.dot}`} />
                    <span className="text-on-surface-variant truncate">{s.label}</span>
                    <span className="text-on-surface font-semibold tabular-nums ml-auto">
                      {s.value}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-body-sm text-on-surface-variant">—</p>
          )}
        </div>

        {/* Top categories */}
        <div>
          <h3 className="text-label-md text-on-surface-variant mb-3">Top Categories</h3>
          <BarList items={categoryItems} barClass="bg-secondary/60" />
        </div>

        {/* Top brands */}
        <div>
          <h3 className="text-label-md text-on-surface-variant mb-3">Top Brands</h3>
          <BarList items={brandItems} barClass="bg-primary/60" />
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-outline-variant bg-surface px-4 py-3">
      <div className="text-display-sm text-on-surface font-semibold leading-tight">{value}</div>
      <div className="text-label-md text-on-surface-variant mt-1">{label}</div>
    </div>
  );
}
