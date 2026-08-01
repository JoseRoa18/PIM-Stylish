import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, AlertCircle, OctagonX, ArrowRight, ScanSearch } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatTimeAgo } from '@/lib/format';

// Latest channel-sync audit snapshot (written by the Wayfair audit in
// Syndication). Listing Health shows it instantly; the live ~1 min audit
// itself runs from the channel workspace.
export default function ChannelSyncCard() {
  const [snap, setSnap] = useState(undefined); // undefined = loading, null = none yet

  useEffect(() => {
    let mounted = true;
    supabase
      .from('channel_health')
      .select('*')
      .eq('channel', 'wayfair')
      .order('run_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => { if (mounted) setSnap(data ?? null); })
      .catch(() => { if (mounted) setSnap(null); });
    return () => { mounted = false; };
  }, []);

  if (snap === undefined) return null;

  return (
    <div className="mb-6 rounded-2xl border border-outline-variant bg-surface-container-lowest px-5 py-4 flex items-center gap-4 flex-wrap">
      <div className="w-9 h-9 rounded-lg bg-brand-wayfair/15 text-brand-wayfair flex items-center justify-center font-bold">
        W
      </div>
      <div className="min-w-0">
        <p className="text-body-md text-on-surface font-medium">Wayfair · spec attributes sync</p>
        {snap ? (
          <p className="text-body-sm text-on-surface-variant">
            Last audit {formatTimeAgo(snap.run_at)}{snap.partial ? ' (partial)' : ''} · {snap.target}
          </p>
        ) : (
          <p className="text-body-sm text-on-surface-variant">No audit run yet.</p>
        )}
      </div>
      {snap && (
        <div className="flex items-center gap-4 text-body-sm flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-on-surface">
            <CheckCircle2 className="w-4 h-4 text-success" /> {snap.in_sync} in sync
          </span>
          <span className="inline-flex items-center gap-1.5 text-on-surface">
            <AlertCircle className="w-4 h-4 text-warning" /> {snap.with_diffs} with differences
          </span>
          {snap.errors > 0 && (
            <span className="inline-flex items-center gap-1.5 text-on-surface">
              <OctagonX className="w-4 h-4 text-error" /> {snap.errors} not audited
            </span>
          )}
        </div>
      )}
      <Link
        to="/syndication/wayfair"
        className="ml-auto inline-flex items-center gap-1.5 text-body-sm text-primary font-semibold hover:underline whitespace-nowrap"
      >
        {snap ? 'Open audit' : 'Run the first audit'}
        {snap ? <ArrowRight className="w-4 h-4" /> : <ScanSearch className="w-4 h-4" />}
      </Link>
    </div>
  );
}
