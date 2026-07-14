import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, FileSpreadsheet, Loader2 } from 'lucide-react';
import { LIVE_CHANNELS, loadFileChannels, loadTotals } from '@/features/syndication/lib/channels';

// Channel directory: one row per channel with its health at a glance.
// Live connectors open their own workspace (/syndication/:channel);
// file-based channels are generated from templates and link there.
export default function Syndication() {
  const [stats, setStats] = useState({}); // channel id → { value, label }
  const [fileChannels, setFileChannels] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const totals = await loadTotals();
        const entries = await Promise.all(
          LIVE_CHANNELS.map(async (c) => [c.id, await c.stat(totals)]),
        );
        const files = await loadFileChannels();
        if (!cancelled) {
          setStats(Object.fromEntries(entries));
          setFileChannels(files);
        }
      } catch {
        if (!cancelled) setFileChannels([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-display-lg text-on-surface">Syndication</h1>
        <p className="text-body-md text-on-surface-variant mt-1">
          Every sales channel in one place — live connections and file exports.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-label-sm font-semibold uppercase tracking-wider text-on-surface-variant">
          Live connections
        </h2>
        <div className="space-y-3">
          {LIVE_CHANNELS.map((c) => (
            <Link
              key={c.id}
              to={`/syndication/${c.id}`}
              className="flex items-center gap-4 rounded-2xl border border-outline-variant bg-surface-container-lowest px-6 py-5 hover:bg-surface-container-low transition-colors group"
            >
              <div className={`w-11 h-11 rounded-lg flex items-center justify-center font-bold text-title-lg flex-shrink-0 ${c.avatarClass}`}>
                {c.letter}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-title-md text-on-surface font-medium">{c.name}</p>
                  <span className={`px-2 py-0.5 rounded-full text-label-sm ${c.envClass}`}>{c.env}</span>
                </div>
                <p className="text-body-sm text-on-surface-variant truncate">{c.tagline}</p>
              </div>
              <div className="text-right flex-shrink-0 hidden sm:block">
                {stats[c.id] ? (
                  <>
                    <p className="text-title-md text-on-surface font-semibold tabular-nums">{stats[c.id].value}</p>
                    <p className="text-body-sm text-on-surface-variant">{stats[c.id].label}</p>
                  </>
                ) : (
                  <Loader2 className="w-4 h-4 animate-spin text-on-surface-variant" />
                )}
              </div>
              <ChevronRight className="w-5 h-5 text-on-surface-variant flex-shrink-0 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-label-sm font-semibold uppercase tracking-wider text-on-surface-variant">
          File exports
        </h2>
        <p className="text-body-sm text-on-surface-variant -mt-1">
          These channels receive filled template files — generate them from the catalog
          (select products → Export Template) and manage the blank templates in Templates.
        </p>
        {fileChannels === null ? (
          <div className="flex items-center gap-2 text-body-sm text-on-surface-variant py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading channels…
          </div>
        ) : fileChannels.length === 0 ? (
          <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest px-6 py-8 text-center">
            <p className="text-body-md text-on-surface mb-1">No file channels yet</p>
            <p className="text-body-sm text-on-surface-variant">
              Upload a marketplace template in Templates and it will appear here.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {fileChannels.map((f) => (
              <Link
                key={f.marketplace}
                to="/templates"
                className="flex items-center gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-3 hover:bg-surface-container-low transition-colors"
              >
                <div className="w-9 h-9 rounded-lg bg-tertiary-container text-on-tertiary-container flex items-center justify-center flex-shrink-0">
                  <FileSpreadsheet className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-body-md text-on-surface font-medium truncate">{f.marketplace}</p>
                  <p className="text-body-sm text-on-surface-variant">
                    {f.templates} template{f.templates === 1 ? '' : 's'}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
