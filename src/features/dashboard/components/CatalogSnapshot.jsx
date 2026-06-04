import { Package } from 'lucide-react';
import { formatCAD, formatCategory } from '@/lib/format';

const STATUS_LABELS = {
  new: 'New',
  in_review: 'In Review',
  ready_to_sell: 'Ready to Sell',
  archived: 'Archived',
  unknown: 'No status',
};

const STATUS_COLORS = {
  new: 'bg-primary-container',
  in_review: 'bg-tertiary-container',
  ready_to_sell: 'bg-emerald-200',
  archived: 'bg-surface-container',
  unknown: 'bg-surface-container-high',
};

export default function CatalogSnapshot({ data }) {
  const { total, byStatus, byCategory, topBrands, avgPrice, totalValue } = data;
  const statusEntries = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
  const categoryEntries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 6);

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

      {statusEntries.length > 0 && (
        <div className="mb-5">
          <h3 className="text-label-md text-on-surface-variant mb-2">By Workflow Status</h3>
          <div className="flex h-2.5 rounded-full overflow-hidden bg-surface-container">
            {statusEntries.map(([status, count]) => (
              <div
                key={status}
                className={STATUS_COLORS[status] ?? 'bg-surface-container-high'}
                style={{ width: `${(count / total) * 100}%` }}
                title={`${STATUS_LABELS[status] ?? status}: ${count}`}
              />
            ))}
          </div>
          <div className="flex gap-3 mt-2 flex-wrap">
            {statusEntries.map(([status, count]) => (
              <div key={status} className="flex items-center gap-1.5 text-label-md text-on-surface-variant">
                <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[status] ?? 'bg-surface-container-high'}`} />
                {STATUS_LABELS[status] ?? status} · <span className="text-on-surface font-medium">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div>
          <h3 className="text-label-md text-on-surface-variant mb-2">Top Categories</h3>
          <ul className="space-y-1.5">
            {categoryEntries.map(([cat, count]) => (
              <li key={cat} className="flex items-center justify-between text-body-sm">
                <span className="text-on-surface truncate">{formatCategory(cat)}</span>
                <span className="text-on-surface-variant font-medium ml-2">{count}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="text-label-md text-on-surface-variant mb-2">Top Brands</h3>
          <ul className="space-y-1.5">
            {topBrands.length === 0 ? (
              <li className="text-body-sm text-on-surface-variant">—</li>
            ) : (
              topBrands.map((b) => (
                <li key={b.name} className="flex items-center justify-between text-body-sm">
                  <span className="text-on-surface truncate">{b.name}</span>
                  <span className="text-on-surface-variant font-medium ml-2">{b.count}</span>
                </li>
              ))
            )}
          </ul>
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
