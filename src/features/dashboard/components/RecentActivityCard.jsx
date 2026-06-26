import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  History, Plus, Send, Pencil, Trash2, Download, ArrowDownToLine, Image as ImageIcon, ArrowRight,
} from 'lucide-react';
import { formatTimeAgo } from '@/lib/format';
import { listActivity } from '@/features/activity/api/activityLog';

// action → icon + tint for the audit feed.
const ACTION_META = {
  create: { Icon: Plus, cls: 'bg-primary-container text-on-primary-container' },
  update: { Icon: Pencil, cls: 'bg-secondary-container text-on-secondary-container' },
  delete: { Icon: Trash2, cls: 'bg-error-container/60 text-error' },
  push: { Icon: Send, cls: 'bg-tertiary-container/50 text-on-tertiary-container' },
  export: { Icon: Download, cls: 'bg-tertiary-container/50 text-on-tertiary-container' },
  import: { Icon: ArrowDownToLine, cls: 'bg-tertiary-container/50 text-on-tertiary-container' },
  media: { Icon: ImageIcon, cls: 'bg-secondary-container text-on-secondary-container' },
};

// A clean SKU (no spaces) links back to the product.
function skuOf(e) {
  if (e.entity_type !== 'product' && e.entity_type !== 'media') return null;
  return e.entity_id && !/\s/.test(e.entity_id) ? e.entity_id : null;
}

export default function RecentActivityCard({ data }) {
  const [audit, setAudit] = useState(null); // null = loading, [] = none/blocked

  useEffect(() => {
    let active = true;
    listActivity({ pageSize: 5 })
      .then((r) => active && setAudit(r.events))
      .catch(() => active && setAudit([]));
    return () => { active = false; };
  }, []);

  // Prefer the real, attributed audit feed; fall back to product-derived events
  // (also covers non-admins, whose RLS returns no audit rows).
  const useAudit = Array.isArray(audit) && audit.length > 0;

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      {useAudit ? (
        <Link
          to="/activity"
          className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-2 hover:bg-surface-container-low/40 transition-colors group"
        >
          <span className="flex items-center gap-2">
            <History className="w-4 h-4 text-on-surface-variant" />
            <span className="text-title-md text-on-surface">Recent Activity</span>
          </span>
          <span className="inline-flex items-center gap-1 text-label-md text-primary">
            View all
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
          </span>
        </Link>
      ) : (
        <header className="px-6 py-4 border-b border-outline-variant flex items-center gap-2">
          <History className="w-4 h-4 text-on-surface-variant" />
          <h2 className="text-title-md text-on-surface">Recent Activity</h2>
        </header>
      )}

      {useAudit ? (
        <ul className="divide-y divide-outline-variant">
          {audit.map((e) => {
            const meta = ACTION_META[e.action] ?? { Icon: History, cls: 'bg-surface-container-high text-on-surface-variant' };
            const sku = skuOf(e);
            const who = e.actor_name || e.actor_email || 'Someone';
            const row = (
              <div className="flex items-center gap-3 px-6 py-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${meta.cls}`}>
                  <meta.Icon className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-body-md text-on-surface truncate">{e.summary || e.action}</p>
                  <p className="text-body-sm text-on-surface-variant mt-0.5 truncate">
                    {who} · {formatTimeAgo(e.occurred_at)}
                  </p>
                </div>
              </div>
            );
            return (
              <li key={e.id}>
                {sku ? (
                  <Link to={`/catalog/${encodeURIComponent(sku)}`} className="block hover:bg-surface-container-low/40 transition-colors">
                    {row}
                  </Link>
                ) : (
                  row
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <ProductFeed data={data} />
      )}
    </section>
  );
}

// Fallback: latest created + pushed products (no actor), used until there are
// audit events or for users who can't read the audit log.
function ProductFeed({ data }) {
  const { recentCreated, recentPushed } = data;
  const events = [
    ...recentCreated.map((p) => ({ type: 'created', sku: p.sku, name: p.model_name, at: p.created_at })),
    ...recentPushed.map((p) => ({ type: 'pushed', sku: p.sku, name: p.model_name, at: p.wix_synced_at })),
  ]
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 5);

  if (events.length === 0) {
    return <div className="px-6 py-12 text-center text-body-sm text-on-surface-variant">No recent activity yet.</div>;
  }

  return (
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
                <span className="text-body-md text-on-surface font-medium truncate">{e.name || e.sku}</span>
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
