import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ArrowRight, CheckCircle2, AlertCircle, OctagonX, ShieldCheck } from 'lucide-react';
import { formatTimeAgo } from '@/lib/format';
import { latestSnapshot } from '../lib/channels';
import { refreshBestBuyOffers } from '../api/bestbuySync';
import { refreshWalmartItems } from '../api/walmartSync';

// Shared workspace for read-only channels (Best Buy, Walmart US/CA…).
// Channel-level view only: connection facts, last-pull numbers, refresh.
// Per-product detail lives in Listing Health — deep-linked, not duplicated.
const CHANNELS = {
  bestbuy: {
    healthTab: 'bestbuy',
    refresh: refreshBestBuyOffers,
    counters: (s) => [
      { icon: CheckCircle2, tone: 'text-success', label: `${s.in_sync} active offers` },
      { icon: AlertCircle, tone: 'text-warning', label: `${s.with_diffs} price differences vs PIM MSRP` },
      { icon: OctagonX, tone: 'text-error', label: `${s.errors} out of stock` },
    ],
    note: 'Offers, stock and prices are pulled from the Mirakl API. Nothing is ever written to Best Buy.',
  },
  walmart_us: {
    healthTab: 'walmart_us',
    refresh: () => refreshWalmartItems('us'),
    counters: (s) => [
      { icon: CheckCircle2, tone: 'text-success', label: `${s.in_sync} published` },
      { icon: AlertCircle, tone: 'text-warning', label: `${s.with_diffs} unpublished` },
    ],
    note: 'Items and publish status are pulled from the Marketplace API. Prices are USD (not compared to CAD MSRPs). Nothing is ever written to Walmart.',
  },
  walmart_ca: {
    healthTab: 'walmart_ca',
    refresh: () => refreshWalmartItems('ca'),
    counters: (s) => [
      { icon: CheckCircle2, tone: 'text-success', label: `${s.in_sync} SKUs updating OK in the daily inventory feed` },
      { icon: AlertCircle, tone: 'text-warning', label: `${s.with_diffs} feed rejections` },
    ],
    note: "Walmart CA exposes no item API — presence comes from the latest MP_INVENTORY feed detail. Nothing is ever written to Walmart.",
  },
};

export default function ReadOnlyChannelCard({ channel }) {
  const def = CHANNELS[channel];
  const [snap, setSnap] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    setSnap(await latestSnapshot(channel));
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      await def.refresh();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!def) return null;

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-6 py-5 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 text-body-sm text-on-surface-variant">
            <ShieldCheck className="w-4 h-4 text-success" />
            Read-only connection — the PIM never writes to this channel.
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
            {busy ? 'Pulling…' : 'Refresh now'}
          </button>
        </div>

        {error && (
          <p className="px-3 py-2 rounded-lg bg-error-container text-on-error-container text-body-sm animate-banner-in">
            {error}
          </p>
        )}

        {snap === undefined ? null : snap === null ? (
          <p className="text-body-sm text-on-surface-variant">
            No pull yet — run the first one to see the channel's live state.
          </p>
        ) : (
          <div className="animate-banner-in space-y-3">
            <p className="text-body-sm text-on-surface-variant">
              Last pull {formatTimeAgo(snap.run_at)} · {snap.total} item{snap.total === 1 ? '' : 's'}
            </p>
            <ul className="space-y-1.5">
              {def.counters(snap).map((c) => (
                <li key={c.label} className="flex items-center gap-2 text-body-md text-on-surface">
                  <c.icon className={`w-4 h-4 flex-shrink-0 ${c.tone}`} />
                  {c.label}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-body-sm text-on-surface-variant border-t border-outline-variant pt-3">{def.note}</p>

        <Link
          to={`/listing-health?tab=${def.healthTab}`}
          className="inline-flex items-center gap-1.5 text-body-md text-primary font-semibold hover:underline"
        >
          Per-product health for this channel
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    </section>
  );
}
