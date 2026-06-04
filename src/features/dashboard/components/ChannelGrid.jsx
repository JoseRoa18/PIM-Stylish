import { Hourglass } from 'lucide-react';

const PLANNED_CHANNELS = [
  'Amazon CA',
  'Amazon US',
  'Walmart US',
  'Wayfair',
  'Lowes US',
  'Home Depot US',
  'Best Buy',
  '+5 more',
];

export default function ChannelGrid() {
  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-title-lg text-on-surface-variant">Channels</h2>
        <span className="text-label-md text-on-surface-variant uppercase tracking-wider px-3 py-1 bg-surface-container rounded-full">
          Coming Soon
        </span>
      </div>

      <div className="p-12 rounded-xl border-2 border-dashed border-outline-variant bg-surface-container-low flex flex-col items-center text-center">
        <div className="w-16 h-16 rounded-2xl bg-surface-container-high flex items-center justify-center mb-4">
          <Hourglass className="w-8 h-8 text-on-surface-variant" />
        </div>
        <h3 className="text-headline-sm text-on-surface mb-2">
          Channel sync infrastructure in progress
        </h3>
        <p className="text-body-md text-on-surface-variant max-w-md mb-6">
          Direct integrations with marketplaces will appear here once the API connections are built. Until then, syndication runs through the existing file-export workflow.
        </p>
        <div className="flex flex-wrap gap-2 justify-center">
          {PLANNED_CHANNELS.map((channel) => (
            <span
              key={channel}
              className="px-3 py-1 rounded-full bg-surface-container text-label-md text-on-surface-variant"
            >
              {channel}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}