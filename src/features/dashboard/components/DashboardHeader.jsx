import { RefreshCw, Filter } from 'lucide-react';

export default function DashboardHeader() {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="flex items-end justify-between mb-6">
      <div>
        <p className="text-label-md text-on-surface-variant uppercase tracking-wider mb-1">
          {today}
        </p>
        <h1 className="text-headline-md text-on-background">
          Syndication Overview
        </h1>
        <p className="text-body-md text-secondary mt-1">
          Monitor and sync product data across all retail channels.
        </p>
      </div>
      <div className="flex gap-2">
        <button className="px-4 py-2 border border-outline rounded-lg text-label-md flex items-center gap-2 text-secondary hover:bg-surface-container-low transition-colors">
          <Filter className="w-4 h-4" />
          Filter Channels
        </button>
        <button className="px-4 py-2 bg-primary text-on-primary rounded-lg text-label-md flex items-center gap-2 hover:opacity-90 transition-opacity">
          <RefreshCw className="w-4 h-4" />
          Sync All Channels
        </button>
      </div>
    </div>
  );
}