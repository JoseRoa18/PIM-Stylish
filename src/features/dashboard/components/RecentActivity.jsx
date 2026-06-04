import { useRecentActivity } from '../hooks/useRecentActivity';
import { formatTimeAgo } from '@/lib/format';
import { getColorForInitials } from '@/lib/avatar';
import Skeleton from '@/components/ui/Skeleton';

// Map activity verbs (from the `verb` enum in activity_log) to human phrases.
// If a verb isn't here, we fall back to the raw verb with underscores replaced.
const VERB_PHRASES = {
  created: 'created',
  updated: 'updated',
  updated_specs: 'updated specifications for',
  updated_pricing: 'updated pricing for',
  uploaded_image: 'uploaded image to',
  uploaded_media: 'uploaded media to',
  uploaded_spec_sheet: 'uploaded spec sheet to',
  approved: 'approved listing on',
  rejected: 'rejected listing on',
  flagged: 'flagged update needed on',
  archived: 'archived',
  deleted: 'deleted',
  synced: 'synced',
  sync_failed: 'sync failed for',
};

const WARNING_VERBS = new Set(['flagged', 'rejected']);
const ERROR_VERBS = new Set(['sync_failed']);

const STATUS_CONFIG = {
  success: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Success' },
  warning: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Warning' },
  error: { bg: 'bg-rose-100', text: 'text-rose-700', label: 'Failed' },
};

function getActionPhrase(verb) {
  return VERB_PHRASES[verb] || verb.replace(/_/g, ' ');
}

function getStatusFromVerb(verb) {
  if (ERROR_VERBS.has(verb)) return 'error';
  if (WARNING_VERBS.has(verb)) return 'warning';
  return 'success';
}

export default function RecentActivity() {
  const { activity, loading, error } = useRecentActivity({ limit: 5 });

  return (
    <section className="p-6 rounded-xl border border-outline-variant bg-surface-container-lowest">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-title-lg text-on-surface">Recent Activity</h2>
        <button className="text-label-md text-primary font-semibold hover:underline">
          View all history →
        </button>
      </div>

      {error && (
        <div className="py-8 text-center">
          <p className="text-body-md text-error">Failed to load activity</p>
          <p className="text-body-sm text-on-surface-variant mt-1">{error.message}</p>
        </div>
      )}

      {!error && loading && (
        <div>
          {[0, 1, 2].map((i) => (
            <ActivityRowSkeleton key={i} />
          ))}
        </div>
      )}

      {!error && !loading && activity.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-body-md text-on-surface-variant">No activity yet</p>
          <p className="text-body-sm text-on-surface-variant mt-1">
            Updates to products will show up here.
          </p>
        </div>
      )}

      {!error && !loading && activity.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-on-surface-variant border-b border-outline-variant">
                <th className="py-2 px-3 text-left text-label-md uppercase tracking-wider">User</th>
                <th className="py-2 px-3 text-left text-label-md uppercase tracking-wider">Activity</th>
                <th className="py-2 px-3 text-left text-label-md uppercase tracking-wider">Status</th>
                <th className="py-2 px-3 text-left text-label-md uppercase tracking-wider">When</th>
              </tr>
            </thead>
            <tbody>
              {activity.map((item) => (
                <ActivityRow key={item.id} item={item} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ActivityRow({ item }) {
  const status = getStatusFromVerb(item.verb);
  const action = getActionPhrase(item.verb);
  const initials = item.actor?.initials || '?';
  const actorName = item.actor?.full_name || 'Unknown user';
  const actorColor = getColorForInitials(initials);

  return (
    <tr className="border-b border-outline-variant last:border-0 hover:bg-surface-container-low transition-colors">
      <td className="py-3 px-3">
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-label-md font-semibold"
            style={{ backgroundColor: actorColor }}
          >
            {initials}
          </div>
          <span className="text-body-md text-on-surface">{actorName}</span>
        </div>
      </td>
      <td className="py-3 px-3">
        <div className="text-body-md">
          <span className="text-on-surface-variant">{action}</span>{' '}
          {item.target_label && (
            <span className="font-semibold text-on-surface">{item.target_label}</span>
          )}
          {item.context && (
            <>
              <span className="text-on-surface-variant"> on </span>
              <span className="font-semibold text-on-surface">{item.context}</span>
            </>
          )}
        </div>
      </td>
      <td className="py-3 px-3">
        <StatusPill status={status} />
      </td>
      <td className="py-3 px-3 text-body-sm text-on-surface-variant whitespace-nowrap">
        {formatTimeAgo(item.created_at)}
      </td>
    </tr>
  );
}

function ActivityRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-outline-variant last:border-0">
      <Skeleton className="w-8 h-8 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-6 w-16 rounded-full" />
      <Skeleton className="h-4 w-20" />
    </div>
  );
}

function StatusPill({ status }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.success;
  return (
    <span
      className={`inline-block px-2 py-1 rounded-full text-label-md font-semibold ${config.bg} ${config.text}`}
    >
      {config.label}
    </span>
  );
}