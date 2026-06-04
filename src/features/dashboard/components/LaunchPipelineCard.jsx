import { Link } from 'react-router-dom';
import { Rocket, Clock, AlertOctagon } from 'lucide-react';
import { formatDate } from '@/lib/format';

export default function LaunchPipelineCard({ data }) {
  const { upcomingLaunches, overdueLaunches, stalled } = data;

  const sections = [
    {
      key: 'upcoming',
      label: 'Launching soon',
      sublabel: 'Ready-to-sell date within 30 days',
      items: upcomingLaunches.slice(0, 4),
      total: upcomingLaunches.length,
      icon: Rocket,
      tone: 'tertiary',
      dateField: 'ready_to_sell_date',
    },
    {
      key: 'overdue',
      label: 'Overdue',
      sublabel: 'Past their ready-to-sell date',
      items: overdueLaunches.slice(0, 4),
      total: overdueLaunches.length,
      icon: AlertOctagon,
      tone: 'error',
      dateField: 'ready_to_sell_date',
    },
    {
      key: 'stalled',
      label: 'Stalled',
      sublabel: 'Created 30+ days ago, still "New"',
      items: stalled.slice(0, 4),
      total: stalled.length,
      icon: Clock,
      tone: 'amber',
      dateField: 'created_at',
    },
  ];

  const allEmpty = sections.every((s) => s.total === 0);

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant flex items-center gap-2">
        <Rocket className="w-4 h-4 text-on-surface-variant" />
        <h2 className="text-title-md text-on-surface">Launch Pipeline</h2>
      </header>

      {allEmpty ? (
        <div className="px-6 py-12 text-center text-body-sm text-on-surface-variant">
          Everything on track — no overdue or stalled launches.
        </div>
      ) : (
        <div className="divide-y divide-outline-variant">
          {sections.map((s) => (
            <PipelineSection key={s.key} section={s} />
          ))}
        </div>
      )}
    </section>
  );
}

const TONE_STYLES = {
  tertiary: { bg: 'bg-tertiary-container/40', text: 'text-on-tertiary-container' },
  error: { bg: 'bg-error-container', text: 'text-on-error-container' },
  amber: { bg: 'bg-amber-100', text: 'text-amber-800' },
};

function PipelineSection({ section }) {
  const { items, total, label, sublabel, icon: Icon, tone, dateField } = section;
  const t = TONE_STYLES[tone];

  return (
    <div className="px-6 py-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-lg ${t.bg} ${t.text} flex items-center justify-center`}>
            <Icon className="w-3.5 h-3.5" />
          </div>
          <div>
            <div className="text-body-md text-on-surface font-medium">{label}</div>
            <div className="text-label-md text-on-surface-variant">{sublabel}</div>
          </div>
        </div>
        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-label-md font-semibold ${t.bg} ${t.text}`}>
          {total}
        </span>
      </div>

      {items.length > 0 && (
        <ul className="mt-2 space-y-1 pl-9">
          {items.map((p) => (
            <li key={p.sku} className="flex items-center justify-between gap-2 text-body-sm">
              <Link
                to={`/catalog/${p.sku}`}
                className="text-on-surface hover:text-primary transition-colors truncate"
              >
                {p.model_name || p.sku}
              </Link>
              <span className="text-on-surface-variant text-label-md whitespace-nowrap">
                {formatDate(p[dateField])}
              </span>
            </li>
          ))}
          {total > items.length && (
            <li className="text-label-md text-on-surface-variant">
              + {total - items.length} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
