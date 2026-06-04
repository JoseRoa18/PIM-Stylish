import { Share2, Link as LinkIcon, Send } from 'lucide-react';
import { formatTimeAgo } from '@/lib/format';

export default function MarketplaceSyncCard({ data }) {
  const { linkedCount, unlinkedCount, lastPush, pushesThisWeek, total } = data;
  const linkedPct = total > 0 ? Math.round((linkedCount / total) * 100) : 0;

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6">
      <div className="flex items-center gap-2 mb-5">
        <Share2 className="w-4 h-4 text-on-surface-variant" />
        <h2 className="text-title-lg text-on-surface">Marketplace Sync</h2>
      </div>

      <div className="mb-5">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-label-md text-on-surface-variant">Wix Stores</span>
          <span className="text-body-sm text-on-surface-variant">
            {linkedCount} of {total} linked
          </span>
        </div>
        <div className="flex h-2.5 rounded-full overflow-hidden bg-surface-container">
          <div className="bg-primary" style={{ width: `${linkedPct}%` }} />
        </div>
        <div className="text-label-md text-on-surface-variant mt-2">
          {unlinkedCount > 0
            ? `${unlinkedCount} product${unlinkedCount === 1 ? '' : 's'} not linked yet`
            : 'All products linked'}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Tile
          icon={LinkIcon}
          label="Linked"
          value={linkedCount}
          subtitle={`${linkedPct}% of catalog`}
        />
        <Tile
          icon={Send}
          label="Last push"
          value={lastPush ? formatTimeAgo(lastPush) : 'Never'}
          subtitle={pushesThisWeek > 0 ? `${pushesThisWeek} this week` : 'No pushes this week'}
        />
      </div>
    </section>
  );
}

function Tile({ icon: Icon, label, value, subtitle }) {
  return (
    <div className="rounded-xl border border-outline-variant bg-surface px-4 py-3">
      <div className="flex items-center gap-2 text-on-surface-variant text-label-md mb-1">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div className="text-title-md text-on-surface font-semibold leading-tight">{value}</div>
      {subtitle && <div className="text-label-md text-on-surface-variant mt-1">{subtitle}</div>}
    </div>
  );
}
