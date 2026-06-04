import { BadgeCheck, Package, ClipboardList, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DASHBOARD_STATS } from '../data/mockData';
import { useProductStats } from '../hooks/useProductStats';
import Skeleton from '@/components/ui/Skeleton';

export default function StatCards() {
  const { stats: products, loading, error } = useProductStats();
  // These stay mocked until we have channel sync infrastructure
  const { globalReadiness, lastSyncAt, weekTrend } = DASHBOARD_STATS;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      {/* Global Readiness — still mocked */}
      <div className="relative overflow-hidden p-6 rounded-xl bg-primary-container text-on-primary-container min-h-[160px] flex flex-col justify-between">
        <BadgeCheck className="absolute -right-6 -bottom-6 w-36 h-36 opacity-10" />
        <div className="relative">
          <h3 className="text-label-md uppercase tracking-wider opacity-80">
            Global Readiness
          </h3>
          <p className="text-display-lg mt-1">{globalReadiness}%</p>
        </div>
        <div className="relative flex items-center gap-1 text-body-sm">
          <TrendingUp className="w-4 h-4" />
          <span>+{weekTrend.value}% from last week</span>
        </div>
      </div>

      {/* Active SKUs — REAL DATA */}
      <Link
        to="/catalog"
        className="p-6 rounded-xl border border-outline-variant bg-surface-container-lowest min-h-[160px] flex flex-col justify-between"
      >
        <div>
          <div className="flex items-center justify-between">
            <h3 className="text-label-md text-on-surface-variant uppercase tracking-wider">
              Active SKUs
            </h3>
            <Package className="w-5 h-5 text-on-surface-variant" />
          </div>
          {loading ? (
            <Skeleton className="h-9 w-20 mt-1" />
          ) : error ? (
            <p className="text-display-lg mt-1 text-error">—</p>
          ) : (
            <p className="text-display-lg mt-1 text-on-surface">{products.total}</p>
          )}
        </div>
        <p className="text-body-sm text-on-surface-variant">
          {loading ? (
            <Skeleton className="h-4 w-40" />
          ) : error ? (
            <span className="text-error">Failed to load</span>
          ) : (
            <>
              {products.ready} ready · {products.pending} pending review
            </>
          )}
        </p>
      </Link>

      {/* Pending Updates — REAL DATA */}
      <div className="p-6 rounded-xl border border-outline-variant bg-surface-container-lowest min-h-[160px] flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between">
            <h3 className="text-label-md text-on-surface-variant uppercase tracking-wider">
              Pending Updates
            </h3>
            <ClipboardList className="w-5 h-5 text-error" />
          </div>
          {loading ? (
            <Skeleton className="h-9 w-12 mt-1" />
          ) : error ? (
            <p className="text-display-lg mt-1 text-error">—</p>
          ) : (
            <p className="text-display-lg mt-1 text-error">{products.pending}</p>
          )}
        </div>
        <p className="text-body-sm text-on-surface-variant">
          Last sync: {lastSyncAt}
        </p>
      </div>
    </div>
  );
}