import { useMemo, useState } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight, Clock, CheckCircle2, Radio } from 'lucide-react';
import { PROMO_CHANNELS } from '@/features/pricing/lib/promoChannels';
import { promoWindow, etToday } from '@/features/pricing/lib/promoCalendar';
import { PROMOTION_KINDS } from '@/features/pricing/api/promotions';

// Flash deals / special events at a glance (asked for 2026-10-01): what runs
// on each marketplace today and when it ends, and the history of a month, a
// week or any range. A deal "runs" by its DATES (Eastern time), not by its
// status — flash deals are uploaded to the portals by hand and stay "draft"
// in the PIM while the portal runs them. Only an ended one is over early.

const DAY_MS = 86400000;
const utc = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY_MS);
const addDays = (ymd, n) => new Date(utc(ymd) + n * DAY_MS).toISOString().slice(0, 10);
const fmtDay = (ymd, opts = {}) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC', ...opts });
const fmtRange = (a, b) => (a.slice(0, 4) === b.slice(0, 4) ? `${fmtDay(a)} – ${fmtDay(b)}` : `${fmtDay(a, { year: 'numeric' })} – ${fmtDay(b, { year: 'numeric' })}`);

const channel = (key) => PROMO_CHANNELS.find((c) => c.key === key);
const channelLabel = (key) => channel(key)?.label ?? key;
const MARKET_LABEL = { ca: 'Canada', us: 'USA' };

// The days a deal covers across its portals' markets (one pair for flash
// deals and special events, so in practice the same on both).
function dealWindow(promo) {
  const markets = [...new Set((promo.marketplaces ?? []).map((k) => channel(k)?.market).filter(Boolean))];
  const ws = (markets.length ? markets : ['ca', 'us']).map((m) => promoWindow(promo, m));
  return {
    start: ws.reduce((s, w) => (w.start < s ? w.start : s), ws[0].start),
    end: ws.reduce((e, w) => (w.end > e ? w.end : e), ws[0].end),
  };
}

function dealState(promo, w, today) {
  if (promo.status === 'ended' || w.end < today) return 'ended';
  if (w.start > today) return 'scheduled';
  return 'running';
}

// Each state carries its own word and icon, never color alone.
const STATE_META = {
  running: { label: 'Running', icon: Radio, cls: 'bg-success-container text-on-success-container' },
  scheduled: { label: 'Scheduled', icon: Clock, cls: 'bg-surface-container text-on-surface-variant' },
  ended: { label: 'Ended', icon: CheckCircle2, cls: 'bg-surface-container-high text-on-surface-variant' },
};

function StateChip({ state }) {
  const meta = STATE_META[state];
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-label-md font-semibold whitespace-nowrap ${meta.cls}`}>
      <Icon className="w-3.5 h-3.5" strokeWidth={2} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function endsText(daysLeft) {
  if (daysLeft <= 0) return 'Ends today';
  if (daysLeft === 1) return 'Ends tomorrow';
  return `Ends in ${daysLeft} days`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * @param kind        'flash' | 'special'
 * @param promotions  this kind's promotions (listPromotions rows)
 * @param onOpen      (promoId) => void — opens the deal's card below
 */
export default function DealsOverview({ kind, promotions, onOpen }) {
  const today = etToday();
  const noun = PROMOTION_KINDS[kind].toLowerCase();

  const deals = useMemo(
    () => promotions.map((promo) => {
      const w = dealWindow(promo);
      return { promo, ...w, state: dealState(promo, w, today) };
    }),
    [promotions, today],
  );

  return (
    <div className="space-y-3">
      <RunningNow deals={deals} today={today} noun={noun} onOpen={onOpen} />
      <DealsHistory deals={deals} today={today} noun={noun} onOpen={onOpen} />
    </div>
  );
}

// ============================== Running now ==============================

function RunningNow({ deals, today, noun, onOpen }) {
  // One tile per marketplace, each with the deals running on it today; the
  // one that ends soonest comes first.
  const tiles = useMemo(() => {
    const byChannel = new Map();
    for (const d of deals) {
      if (d.state !== 'running') continue;
      for (const key of d.promo.marketplaces ?? []) {
        const ch = channel(key);
        const w = ch ? promoWindow(d.promo, ch.market) : d;
        if (w.start > today || w.end < today) continue;
        const list = byChannel.get(key) ?? [];
        list.push({ ...d, start: w.start, end: w.end });
        byChannel.set(key, list);
      }
    }
    return [...byChannel.entries()]
      .map(([key, list]) => ({ key, list: list.sort((a, b) => a.end.localeCompare(b.end)) }))
      .sort((a, b) => a.list[0].end.localeCompare(b.list[0].end) || channelLabel(a.key).localeCompare(channelLabel(b.key)));
  }, [deals, today]);

  const upcoming = useMemo(
    () => deals.filter((d) => d.state === 'scheduled').sort((a, b) => a.start.localeCompare(b.start)).slice(0, 3),
    [deals],
  );

  // Marketplaces this kind has gone to, with nothing on them today.
  const idle = useMemo(() => {
    const running = new Set(tiles.map((t) => t.key));
    const seen = new Set(deals.flatMap((d) => d.promo.marketplaces ?? []));
    return [...seen].filter((k) => !running.has(k)).sort((a, b) => channelLabel(a).localeCompare(channelLabel(b)));
  }, [deals, tiles]);

  return (
    <section aria-labelledby="deals-running-now" className="rounded-2xl bg-surface border border-outline-variant px-5 py-4 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 id="deals-running-now" className="text-title-md text-on-surface font-semibold">Running now</h2>
        <span className="text-body-sm text-on-surface-variant">
          Today, {fmtDay(today, { weekday: 'short' })} · Eastern time
        </span>
      </div>

      {tiles.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tiles.map(({ key, list }) => (
            <li key={key} className="rounded-xl border border-outline-variant bg-surface-container-low p-4 flex flex-col gap-3 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-label-lg text-on-surface font-semibold truncate">{channelLabel(key)}</span>
                <span className="text-label-sm text-on-surface-variant uppercase tracking-wider">{MARKET_LABEL[channel(key)?.market] ?? ''}</span>
              </div>
              {list.map((d) => <RunningDeal key={d.promo.id} deal={d} today={today} onOpen={onOpen} />)}
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-xl bg-surface-container-low px-4 py-6 text-center">
          <p className="text-body-md text-on-surface font-medium">No {noun} is running today</p>
          <p className="text-body-sm text-on-surface-variant mt-1">
            {upcoming.length ? `The next one starts ${fmtDay(upcoming[0].start, { weekday: 'short' })}.` : `Create one with "New ${noun}" — it shows here on its first day.`}
          </p>
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-label-lg text-on-surface-variant font-medium">Coming up</h3>
          <ul className="divide-y divide-outline-variant/60">
            {upcoming.map((d) => {
              const inDays = daysBetween(today, d.start);
              return (
                <li key={d.promo.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(d.promo.id)}
                    className="w-full py-2 flex items-center gap-3 text-left rounded-lg hover:bg-surface-container-low focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
                  >
                    <CalendarClock className="w-4 h-4 text-on-surface-variant flex-shrink-0" strokeWidth={2} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-body-md text-on-surface truncate">{d.promo.name}</span>
                      <span className="block text-body-sm text-on-surface-variant truncate">
                        {(d.promo.marketplaces ?? []).map(channelLabel).join(', ') || 'No portal yet'}
                        {d.promo.created_by_name && <> · scheduled by <span className="text-on-surface">{d.promo.created_by_name}</span></>}
                      </span>
                    </span>
                    <span className="text-right flex-shrink-0">
                      <span className="block text-body-sm text-on-surface tabular-nums">{fmtRange(d.start, d.end)}</span>
                      <span className="block text-label-md text-on-surface-variant">{inDays === 1 ? 'Starts tomorrow' : `Starts in ${inDays} days`}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {idle.length > 0 && (
        <p className="text-body-sm text-on-surface-variant">
          <span className="font-medium text-on-surface">Nothing running on:</span> {idle.map(channelLabel).join(', ')}
        </p>
      )}
    </section>
  );
}

function RunningDeal({ deal, today, onOpen }) {
  const total = daysBetween(deal.start, deal.end) + 1;
  const day = Math.min(total, daysBetween(deal.start, today) + 1);
  const left = daysBetween(today, deal.end);
  const urgent = left <= 1;
  return (
    <button
      type="button"
      onClick={() => onOpen(deal.promo.id)}
      className="-mx-2 px-2 py-2 rounded-lg text-left space-y-2 hover:bg-surface-container focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
    >
      <span className="block">
        <span className="block text-body-md text-on-surface font-medium">{deal.promo.name}</span>
        <span className="block text-body-sm text-on-surface-variant tabular-nums">
          {fmtRange(deal.start, deal.end)} · {plural(deal.promo.sku_count ?? 0, 'SKU')}
        </span>
      </span>
      <span className="flex items-center justify-between gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-label-md font-semibold ${urgent ? 'bg-warning-container text-on-warning-container' : 'bg-surface-container-high text-on-surface'}`}>
          <Clock className="w-3.5 h-3.5" strokeWidth={2} aria-hidden="true" />
          Due {fmtDay(deal.end, { weekday: 'short' })} · {endsText(left)}
        </span>
        <span className="text-label-md text-on-surface-variant tabular-nums">Day {day} of {total}</span>
      </span>
      <span
        className="block h-1.5 rounded-full bg-surface-container-high overflow-hidden"
        role="progressbar"
        aria-label={`${deal.promo.name}: day ${day} of ${total}`}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={day}
      >
        <span className={`block h-full rounded-full ${urgent ? 'bg-warning' : 'bg-success'}`} style={{ width: `${(day / total) * 100}%` }} />
      </span>
    </button>
  );
}

// ============================== History ==============================

const MODES = [['month', 'Month'], ['week', 'Week'], ['custom', 'Custom']];

// Monday of the week holding a day.
function weekStart(ymd) {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(ymd, -((dow + 6) % 7));
}
const monthStart = (ymd) => `${ymd.slice(0, 7)}-01`;
const monthEnd = (ymd) => {
  const [y, m] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const shiftMonth = (ymd, n) => {
  const [y, m] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};

function DealsHistory({ deals, today, noun, onOpen }) {
  const [mode, setMode] = useState('month');
  const [anchor, setAnchor] = useState(today); // a day inside the month / week shown
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [portal, setPortal] = useState('all');

  const range = useMemo(() => {
    if (mode === 'month') return { start: monthStart(anchor), end: monthEnd(anchor) };
    if (mode === 'week') { const s = weekStart(anchor); return { start: s, end: addDays(s, 6) }; }
    return from && to && from <= to ? { start: from, end: to } : null;
  }, [mode, anchor, from, to]);

  const inRange = useMemo(
    () => (range ? deals.filter((d) => d.start <= range.end && d.end >= range.start) : []),
    [deals, range],
  );
  const portals = useMemo(() => {
    const m = new Map();
    for (const d of inRange) for (const k of d.promo.marketplaces ?? []) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || channelLabel(a[0]).localeCompare(channelLabel(b[0])));
  }, [inRange]);
  const portalActive = portal !== 'all' && portals.some(([k]) => k === portal);
  const rows = useMemo(
    () => inRange
      .filter((d) => !portalActive || (d.promo.marketplaces ?? []).includes(portal))
      .sort((a, b) => b.start.localeCompare(a.start) || b.end.localeCompare(a.end)),
    [inRange, portal, portalActive],
  );
  const skus = rows.reduce((n, d) => n + (d.promo.sku_count ?? 0), 0);
  const marketplaces = new Set(rows.flatMap((d) => d.promo.marketplaces ?? [])).size;

  const isCurrent = mode === 'month' ? monthStart(anchor) === monthStart(today) : weekStart(anchor) === weekStart(today);
  const step = (n) => setAnchor((a) => (mode === 'month' ? shiftMonth(a, n) : addDays(a, 7 * n)));
  const periodLabel = mode === 'month'
    ? new Date(`${monthStart(anchor)}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : range && fmtRange(range.start, range.end);
  const unit = mode === 'month' ? 'month' : 'week';
  const pill = (on) => `px-3 py-1 rounded-full text-label-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${on ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface hover:bg-surface-container-high'}`;

  return (
    <section aria-labelledby="deals-history" className="rounded-2xl bg-surface border border-outline-variant px-5 py-4 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 id="deals-history" className="text-title-md text-on-surface font-semibold">History</h2>
        <div className="inline-flex rounded-full bg-surface-container p-1" role="group" aria-label="History period">
          {MODES.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={mode === key}
              onClick={() => {
                // Custom starts from the month / week on screen, then adjusts.
                if (key === 'custom' && mode !== 'custom' && range) { setFrom(range.start); setTo(range.end); }
                setMode(key);
              }}
              className={`px-4 py-1.5 rounded-full text-label-md font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${mode === key ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === 'custom' ? (
        <div className="flex items-end gap-3 flex-wrap">
          <label className="flex flex-col gap-1">
            <span className="text-label-md text-on-surface-variant">From</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="px-3 py-2 rounded-lg border border-outline-variant bg-surface-container-lowest text-body-md text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-label-md text-on-surface-variant">To</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="px-3 py-2 rounded-lg border border-outline-variant bg-surface-container-lowest text-body-md text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" />
          </label>
          {!range && <span className="text-body-sm text-error pb-2" role="alert">Pick a first day on or before the last day.</span>}
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={() => step(-1)} aria-label={`Previous ${unit}`} className="w-9 h-9 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors">
            <ChevronLeft className="w-4 h-4" strokeWidth={2} />
          </button>
          <span className="min-w-[11rem] text-center text-body-md text-on-surface font-semibold tabular-nums" aria-live="polite">{periodLabel}</span>
          <button type="button" onClick={() => step(1)} aria-label={`Next ${unit}`} className="w-9 h-9 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors">
            <ChevronRight className="w-4 h-4" strokeWidth={2} />
          </button>
          {!isCurrent && (
            <button type="button" onClick={() => setAnchor(today)} className="text-label-md font-medium text-primary hover:underline ml-1">
              This {unit}
            </button>
          )}
        </div>
      )}

      {range && (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-body-sm text-on-surface-variant">
              <span className="text-on-surface font-medium tabular-nums">{plural(rows.length, noun)}</span>
              {rows.length > 0 && <> · <span className="tabular-nums">{plural(skus, 'SKU')}</span> · <span className="tabular-nums">{plural(marketplaces, 'marketplace')}</span></>}
            </p>
            {portals.length > 1 && (
              <span className="flex items-center gap-1.5 flex-wrap">
                <span className="text-label-md text-on-surface-variant mr-1">Marketplace</span>
                <button type="button" aria-pressed={!portalActive} onClick={() => setPortal('all')} className={pill(!portalActive)}>All</button>
                {portals.map(([k, n]) => (
                  <button key={k} type="button" aria-pressed={portal === k} onClick={() => setPortal(portal === k ? 'all' : k)} className={pill(portal === k)}>
                    {channelLabel(k)} · {n}
                  </button>
                ))}
              </span>
            )}
          </div>

          {rows.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr className="text-label-md text-on-surface-variant border-b border-outline-variant">
                    <th scope="col" className="text-left font-medium py-1.5 pr-4">{noun[0].toUpperCase() + noun.slice(1)}</th>
                    <th scope="col" className="text-left font-medium py-1.5 pr-4">Marketplaces</th>
                    <th scope="col" className="text-left font-medium py-1.5 pr-4">Dates</th>
                    <th scope="col" className="text-right font-medium py-1.5 pr-4">Days</th>
                    <th scope="col" className="text-right font-medium py-1.5 pr-4">SKUs</th>
                    <th scope="col" className="text-left font-medium py-1.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.promo.id} className="border-b border-outline-variant/60 last:border-b-0 align-top">
                      <td className="py-2 pr-4">
                        <button type="button" onClick={() => onOpen(d.promo.id)} className="text-left text-body-md text-on-surface font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded">
                          {d.promo.name}
                        </button>
                        {d.promo.created_by_name && <span className="block text-body-sm text-on-surface-variant">by {d.promo.created_by_name}</span>}
                      </td>
                      <td className="py-2 pr-4">
                        <span className="flex items-center gap-1 flex-wrap">
                          {(d.promo.marketplaces ?? []).length
                            ? d.promo.marketplaces.map((k) => <span key={k} className="px-2 py-0.5 rounded-full text-label-sm bg-surface-container text-on-surface whitespace-nowrap">{channelLabel(k)}</span>)
                            : <span className="text-body-sm text-on-surface-variant">No portal yet</span>}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-body-sm text-on-surface whitespace-nowrap tabular-nums">{fmtRange(d.start, d.end)}</td>
                      <td className="py-2 pr-4 text-right text-body-md text-on-surface tabular-nums">{daysBetween(d.start, d.end) + 1}</td>
                      <td className="py-2 pr-4 text-right text-body-md text-on-surface-variant tabular-nums">{d.promo.sku_count ?? 0}</td>
                      <td className="py-2"><StateChip state={d.state} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-xl bg-surface-container-low px-4 py-6 text-center">
              <p className="text-body-md text-on-surface font-medium">No {noun}s from {fmtDay(range.start)} to {fmtDay(range.end, { year: 'numeric' })}</p>
              <p className="text-body-sm text-on-surface-variant mt-1">{mode === 'custom' ? 'Try wider dates.' : `Use the arrows to see another ${unit}.`}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
