/**
 * Horizontal bar list — a ranked breakdown with proportional bars.
 * Pure CSS, no chart library. Bars are sized relative to the largest value
 * so the longest bar fills the track.
 *
 * items: [{ key, label, value }]
 */
export default function BarList({ items, barClass = 'bg-primary/70', formatValue }) {
  const max = items.reduce((m, it) => Math.max(m, it.value), 0) || 1;

  if (items.length === 0) {
    return <p className="text-body-sm text-on-surface-variant">—</p>;
  }

  return (
    <ul className="space-y-2.5">
      {items.map((it) => (
        <li key={it.key} className="min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-body-sm text-on-surface truncate">{it.label}</span>
            <span className="text-label-md text-on-surface-variant font-medium tabular-nums">
              {formatValue ? formatValue(it.value) : it.value}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-surface-container overflow-hidden">
            <div
              className={`h-full rounded-full ${barClass} transition-[width] duration-500`}
              style={{ width: `${Math.max(4, (it.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
