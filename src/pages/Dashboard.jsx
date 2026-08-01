import { Loader2, AlertCircle } from 'lucide-react';
import { useDashboardData } from '@/features/dashboard/hooks/useDashboardData';
import ActionNeededCard from '@/features/dashboard/components/ActionNeededCard';
import MarketplaceHealthGrid from '@/features/dashboard/components/MarketplaceHealthGrid';
import CatalogStatusCard from '@/features/dashboard/components/CatalogStatusCard';
import ContentGapsCard from '@/features/dashboard/components/ContentGapsCard';
import LaunchPipelineCard from '@/features/dashboard/components/LaunchPipelineCard';
import RecentActivityCard from '@/features/dashboard/components/RecentActivityCard';

export default function Dashboard() {
  const { data, loading, error } = useDashboardData();

  return (
    <div className="max-w-7xl mx-auto">
      <header className="mb-6">
        <h1 className="text-display-lg text-on-surface">Dashboard</h1>
        <p className="text-body-md text-on-surface-variant mt-1">
          Welcome back. Here's what needs your attention today.
        </p>
      </header>

      {loading && (
        <div className="flex items-center justify-center py-24 text-on-surface-variant">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading dashboard…
        </div>
      )}

      {error && (
        <div className="rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error.message}
        </div>
      )}

      {!loading && !error && data && (
        <div className="space-y-6">
          <MarketplaceHealthGrid
            summaries={data.healthSummaries}
            refreshing={data.healthRefreshing}
          />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <CatalogStatusCard data={data} />
            <LaunchPipelineCard data={data} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ContentGapsCard
              gaps={data.contentGaps}
              hasSummaries={Object.keys(data.healthSummaries).length > 0}
            />
            <RecentActivityCard data={data} />
          </div>

          <ActionNeededCard
            actions={data.actions}
            hasChannelSnapshots={data.hasChannelSnapshots}
          />
        </div>
      )}
    </div>
  );
}
