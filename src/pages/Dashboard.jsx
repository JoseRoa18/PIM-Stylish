import { Loader2, AlertCircle } from 'lucide-react';
import { useDashboardMetrics } from '@/features/dashboard/hooks/useDashboardMetrics';
import CatalogSnapshot from '@/features/dashboard/components/CatalogSnapshot';
import MarketplaceSyncCard from '@/features/dashboard/components/MarketplaceSyncCard';
import RecentActivityCard from '@/features/dashboard/components/RecentActivityCard';
import LaunchPipelineCard from '@/features/dashboard/components/LaunchPipelineCard';

export default function Dashboard() {
  const { data, loading, error } = useDashboardMetrics();

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="mb-6">
        <h1 className="text-display-lg text-on-surface">Dashboard</h1>
        <p className="text-body-md text-on-surface-variant mt-1">
          Welcome back. Here's a snapshot of your catalog.
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
          <CatalogSnapshot data={data} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <MarketplaceSyncCard data={data} />
            <LaunchPipelineCard data={data} />
          </div>

          <RecentActivityCard data={data} />
        </div>
      )}
    </div>
  );
}
