import { Link } from 'react-router-dom';
import { History, Plus, Send } from 'lucide-react';
import { formatTimeAgo } from '@/lib/format';

export default function RecentActivityCard({ data }) {
  const { recentCreated, recentPushed } = data;

  // Merge into one chronological feed
  const events = [
    ...recentCreated.map((p) => ({
      type: 'created',
      sku: p.sku,
      name: p.model_name,
      at: p.created_at,
    })),
    ...recentPushed.map((p) => ({
      type: 'pushed',
      sku: p.sku,
      name: p.model_name,
      at: p.wix_synced_at,
    })),
  ]
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 8);

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant flex items-center gap-2">
        <History className="w-4 h-4 text-on-surface-variant" />
        <h2 className="text-title-md text-on-surface">Recent Activity</h2>
      </header>

      {events.length === 0 ? (
        <div className="px-6 py-12 text-center text-body-sm text-on-surface-variant">
          No recent activity yet.
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {events.map((e, i) => (
            <li key={i}>
              <Link
                to={`/catalog/${e.sku}`}
                className="flex items-center gap-3 px-6 py-3 hover:bg-surface-container-low/40 transition-colors"
              >
                <EventIcon type={e.type} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-body-md text-on-surface font-medium truncate">
                      {e.name || e.sku}
                    </span>
                    <span className="text-label-md text-on-surface-variant">
                      {e.type === 'created' ? 'created' : 'pushed to Wix'}
                    </span>
                  </div>
                  <p className="text-body-sm text-on-surface-variant mt-0.5">
                    <span className="font-mono">{e.sku}</span>
                    <span> · {formatTimeAgo(e.at)}</span>
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EventIcon({ type }) {
  if (type === 'pushed') {
    return (
      <div className="w-8 h-8 rounded-lg bg-tertiary-container/40 text-on-tertiary-container flex items-center justify-center flex-shrink-0">
        <Send className="w-4 h-4" />
      </div>
    );
  }
  return (
    <div className="w-8 h-8 rounded-lg bg-primary-container text-on-primary-container flex items-center justify-center flex-shrink-0">
      <Plus className="w-4 h-4" />
    </div>
  );
}
