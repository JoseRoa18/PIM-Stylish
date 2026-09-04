import { Columns } from './charts';

// Team throughput over 12 weeks as small multiples — one measure per chart,
// so no legend is needed and nothing shares an axis it shouldn't.
export default function TeamTrend({ trend, screenTrend }) {
  if (!trend?.length) return null;
  const series = (k) => trend.map((t) => ({ label: t.label, range: t.range, value: t[k] ?? 0 }));
  const panels = [
    { key: 'edits', label: 'Product edits' },
    { key: 'uploads', label: 'Media uploaded' },
    { key: 'pushes', label: 'Pushes to channels' },
    { key: 'creates', label: 'New products' },
  ];
  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6">
      <h3 className="text-title-md text-on-surface">Team pace, last 12 weeks</h3>
      <p className="text-body-sm text-on-surface-variant mt-0.5">Per week, from the activity log. The current week is the accent column and is still in progress.</p>
      <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-6">
        {panels.map((p) => (
          <div key={p.key}>
            <p className="text-label-md text-on-surface-variant uppercase tracking-wider mb-2">{p.label}</p>
            <Columns points={series(p.key)} ariaLabel={`${p.label} per week`} />
          </div>
        ))}
        {screenTrend && (
          <div>
            <p className="text-label-md text-on-surface-variant uppercase tracking-wider mb-2">Hours on screen</p>
            <Columns points={screenTrend} ariaLabel="Team hours on screen per week" format={(v) => `${v} h`} />
          </div>
        )}
      </div>
    </section>
  );
}
