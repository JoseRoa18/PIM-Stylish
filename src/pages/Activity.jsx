import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  History,
  Loader2,
  RefreshCw,
  Search,
  Plus,
  Pencil,
  Trash2,
  Upload,
  Download,
  ArrowDownToLine,
  Image as ImageIcon,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useActivity } from '@/features/activity/hooks/useActivity';
import { useUsers } from '@/features/users/hooks/useUsers';
import { formatTimeAgo } from '@/lib/format';
import { humanizeSummary } from '@/lib/humanize';
import Avatar from '@/components/ui/Avatar';

// Action → icon + chip color. Keeps the timeline scannable at a glance.
const ACTION_META = {
  create: { icon: Plus, label: 'Created', className: 'bg-primary-container/50 text-on-surface' },
  update: { icon: Pencil, label: 'Edited', className: 'bg-secondary-container text-on-secondary-container' },
  delete: { icon: Trash2, label: 'Deleted', className: 'bg-error-container/50 text-error' },
  push: { icon: Upload, label: 'Pushed', className: 'bg-tertiary-container/60 text-on-surface' },
  export: { icon: Download, label: 'Exported', className: 'bg-tertiary-container/60 text-on-surface' },
  import: { icon: ArrowDownToLine, label: 'Imported', className: 'bg-tertiary-container/60 text-on-surface' },
  media: { icon: ImageIcon, label: 'Media', className: 'bg-secondary-container text-on-secondary-container' },
};

// Target (the "where" / site). pim = internal edits. Some channels were logged
// under their raw API host, so those alias to the same chip.
const WALMART_TARGET = { label: 'Walmart', className: 'bg-brand-walmart/15 text-brand-walmart' };
const BESTBUY_TARGET = { label: 'Best Buy', className: 'bg-brand-bestbuy/15 text-brand-bestbuy' };
const TARGET_META = {
  pim: { label: 'PIM', className: 'bg-surface-container-high text-on-surface-variant' },
  wix: { label: 'Wix', className: 'bg-brand-wix/15 text-brand-wix' },
  bbb: { label: 'Bed Bath & Beyond', className: 'bg-warning-container/60 text-on-warning-container' },
  wayfair: { label: 'Wayfair', className: 'bg-brand-wayfair/15 text-brand-wayfair' },
  walmart_us: WALMART_TARGET,
  walmart_ca: WALMART_TARGET,
  'marketplace.walmartapis.com': WALMART_TARGET,
  bestbuy: BESTBUY_TARGET,
  'marketplace.bestbuy.ca': BESTBUY_TARGET,
};

const ACTION_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'create', label: 'Created' },
  { value: 'update', label: 'Edited' },
  { value: 'delete', label: 'Deleted' },
  { value: 'push', label: 'Pushed to site' },
  { value: 'export', label: 'Exported' },
  { value: 'import', label: 'Imported' },
  { value: 'media', label: 'Media changes' },
];

// Filter values must match the stored `target` column verbatim.
const TARGET_OPTIONS = [
  { value: '', label: 'All locations' },
  { value: 'pim', label: 'PIM (internal)' },
  { value: 'wix', label: 'Wix' },
  { value: 'wayfair', label: 'Wayfair' },
  { value: 'marketplace.walmartapis.com', label: 'Walmart' },
  { value: 'marketplace.bestbuy.ca', label: 'Best Buy' },
  { value: 'bbb', label: 'Bed Bath & Beyond' },
];

const RANGE_OPTIONS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '', label: 'All time' },
];

// A SKU links back to the product; "3 products" / null do not.
function skuLinkTarget(event) {
  if (event.entity_type !== 'product' && event.entity_type !== 'media') return null;
  const id = event.entity_id;
  if (!id || /\s/.test(id)) return null; // "3 products" etc.
  return id;
}

// Accounts without a full name would otherwise show a raw email while other
// actors show a name — derive a readable one from the email instead.
function nameFromEmail(email) {
  const local = email?.split('@')[0];
  if (!local) return null;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// The action chip already announces the verb; drop it from the summary so a
// row doesn't read "Edited · Edited product …".
function dedupeLeadingVerb(summary, label) {
  const lead = new RegExp(`^${label}\\s+`, 'i');
  if (!lead.test(summary)) return summary;
  const rest = summary.replace(lead, '');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

const PAGE_SIZE = 25;

export default function Activity() {
  const { users } = useUsers();
  // Actor id → profile photo (listUsers already merges avatar_url in).
  const avatarByActor = useMemo(
    () => new Map((users ?? []).map((u) => [u.id, u.avatar_url])),
    [users],
  );
  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');
  const [target, setTarget] = useState('');
  const [rangeDays, setRangeDays] = useState('7');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  // Wrap each filter setter so changing a filter resets to page 1 in the same
  // update — avoids a wasted fetch on the old page before an effect corrects it.
  const resetTo = (setter) => (value) => {
    setter(value);
    setPage(1);
  };

  // Translate the range preset into an ISO lower bound. Recomputed per render
  // (cheap) — `new Date()` here is in component code, not a workflow script.
  const since = useMemo(() => {
    if (!rangeDays) return undefined;
    const d = new Date();
    d.setDate(d.getDate() - Number(rangeDays));
    return d.toISOString();
  }, [rangeDays]);

  const { events, count, loading, error, reload } = useActivity(
    {
      actorId: actorId || undefined,
      action: action || undefined,
      target: target || undefined,
      search: search || undefined,
      since,
    },
    page,
    PAGE_SIZE,
  );

  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const rangeStart = count === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, count);

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-container/50 flex items-center justify-center flex-shrink-0">
            <History className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-headline-sm text-on-surface">Activity Log</h1>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              Who did what, when and where — product edits and pushes to your sites.
            </p>
          </div>
        </div>
        <button
          onClick={reload}
          title="Refresh"
          className="p-2.5 rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors flex-shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
          <input
            value={search}
            onChange={(e) => resetTo(setSearch)(e.target.value)}
            placeholder="Search SKU or description…"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <FilterSelect value={actorId} onChange={resetTo(setActorId)}>
          <option value="">All users</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.full_name || u.email}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect value={action} onChange={resetTo(setAction)} options={ACTION_OPTIONS} />
        <FilterSelect value={target} onChange={resetTo(setTarget)} options={TARGET_OPTIONS} />
        <FilterSelect value={rangeDays} onChange={resetTo(setRangeDays)} options={RANGE_OPTIONS} />
      </div>

      {/* Timeline */}
      <div className="bg-surface border border-outline-variant rounded-2xl overflow-hidden">
        {loading ? (
          <div className="py-16 flex items-center justify-center text-on-surface-variant text-body-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading activity…
          </div>
        ) : error ? (
          <div className="py-16 text-center">
            <p className="text-body-md text-error font-semibold">Couldn’t load activity</p>
            <p className="text-body-sm text-on-surface-variant mt-1">{error.message}</p>
            <button
              onClick={reload}
              className="mt-3 px-4 py-1.5 rounded-full border border-outline-variant text-body-sm hover:bg-surface-container-low"
            >
              Retry
            </button>
          </div>
        ) : events.length === 0 ? (
          <div className="py-16 text-center">
            <History className="w-8 h-8 text-on-surface-variant/50 mx-auto mb-2" />
            <p className="text-body-md text-on-surface">No activity for these filters</p>
            <p className="text-body-sm text-on-surface-variant mt-1">
              Try widening the date range or clearing filters.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-outline-variant">
            {events.map((e) => (
              <ActivityRow key={e.id} event={e} avatarUrl={avatarByActor.get(e.actor_id) ?? null} />
            ))}
          </ul>
        )}
      </div>

      {!error && count > 0 && (
        <div className="flex items-center justify-between gap-4 mt-3">
          <p className="text-label-sm text-on-surface-variant">
            Showing <span className="text-on-surface font-medium">{rangeStart}–{rangeEnd}</span> of{' '}
            <span className="text-on-surface font-medium">{count}</span>
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
                className="p-2 rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                title="Previous page"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-label-sm text-on-surface-variant px-2 tabular-nums">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || loading}
                className="p-2 rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                title="Next page"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FilterSelect({ value, onChange, options, children }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
    >
      {options
        ? options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))
        : children}
    </select>
  );
}

function ActivityRow({ event, avatarUrl }) {
  const meta = ACTION_META[event.action] ?? {
    icon: Pencil,
    label: event.action,
    className: 'bg-surface-container-high text-on-surface-variant',
  };
  const targetMeta = TARGET_META[event.target] ?? {
    // Unknown channel: show the raw target capitalized rather than mislabeling it "PIM".
    label: event.target ? event.target.charAt(0).toUpperCase() + event.target.slice(1) : 'PIM',
    className: 'bg-surface-container-high text-on-surface-variant',
  };
  const Icon = meta.icon;
  const who = event.actor_name || nameFromEmail(event.actor_email) || 'Unknown user';
  const sku = skuLinkTarget(event);
  const when = new Date(event.occurred_at);

  // Summaries are stored verbatim, so rows written before the copy fixes are
  // sanitized at render: storage-vendor mentions, "(? matched)" from counts
  // that never arrived, "(s)" pseudo-plurals, raw snake_case field names, and
  // the leading verb the action chip already communicates.
  const summary = dedupeLeadingVerb(
    humanizeSummary(
      (event.summary || '—')
        .replace(/\s*\(supabase\)/gi, '')
        .replace(/\s*\(\? matched\)/g, '')
        .replace(/\b(\d+)\s+((?:[a-z]+ )?[a-z]+)\(s\)/gi, (_, n, noun) =>
          `${n} ${noun}${Number(n) === 1 ? '' : 's'}`),
    ),
    meta.label,
  );

  return (
    <li className="flex items-start gap-3 px-5 py-3.5 hover:bg-surface-container-low/50 transition-colors">
      {/* Actor avatar */}
      <Avatar name={event.actor_name} email={event.actor_email} src={avatarUrl} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-label-sm font-medium ${meta.className}`}
          >
            <Icon className="w-3 h-3" />
            {meta.label}
          </span>
          {event.target && event.target !== 'pim' && (
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-label-sm font-medium ${targetMeta.className}`}
            >
              {targetMeta.label}
            </span>
          )}
        </div>

        <p className="text-body-md text-on-surface mt-1">{summary}</p>

        <div className="flex items-center gap-2 text-label-sm text-on-surface-variant mt-1 flex-wrap">
          <span className="font-medium text-on-surface-variant">{who}</span>
          <span aria-hidden>·</span>
          <time dateTime={event.occurred_at} title={when.toLocaleString()}>
            {formatTimeAgo(event.occurred_at)}
          </time>
          {sku && (
            <>
              <span aria-hidden>·</span>
              {event.action === 'delete' ? (
                // The product no longer exists — don't link to a dead page.
                <span className="font-mono text-on-surface-variant">{sku}</span>
              ) : (
                <Link
                  to={`/catalog/${encodeURIComponent(sku)}`}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {sku}
                  <ExternalLink className="w-3 h-3" />
                </Link>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}
