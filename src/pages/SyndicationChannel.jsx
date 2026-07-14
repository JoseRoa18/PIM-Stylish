import { useParams, Link, Navigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import WixConnectorCard from '@/features/syndication/components/WixConnectorCard';
import WayfairConnectorCard from '@/features/syndication/components/WayfairConnectorCard';
import { LIVE_CHANNELS } from '@/features/syndication/lib/channels';

const WORKSPACES = {
  wix: WixConnectorCard,
  wayfair: WayfairConnectorCard,
};

// Full-page workspace for one live channel. New connectors plug in with a
// registry entry (channels.js) plus a component here.
export default function SyndicationChannel() {
  const { channel } = useParams();
  const meta = LIVE_CHANNELS.find((c) => c.id === channel);
  const Workspace = WORKSPACES[channel];
  if (!meta || !Workspace) return <Navigate to="/syndication" replace />;

  return (
    <div className="space-y-6 max-w-4xl">
      <Link
        to="/syndication"
        className="inline-flex items-center gap-1 text-body-sm text-on-surface-variant hover:text-primary transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        All channels
      </Link>

      <header className="flex items-center gap-4">
        <div className={`w-12 h-12 rounded-xl flex items-center justify-center font-bold text-headline-sm ${meta.avatarClass}`}>
          {meta.letter}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-headline-md text-on-surface">{meta.name}</h1>
            <span className={`px-2 py-0.5 rounded-full text-label-sm ${meta.envClass}`}>{meta.env}</span>
          </div>
          <p className="text-body-md text-on-surface-variant">{meta.tagline}</p>
        </div>
      </header>

      <Workspace />
    </div>
  );
}
