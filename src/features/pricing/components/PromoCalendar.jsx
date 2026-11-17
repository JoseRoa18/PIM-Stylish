import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChartGantt, ChevronLeft, ChevronRight, Flag, Loader2 } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { cn } from '@/lib/cn';
import { listCoupons } from '@/features/pricing/api/coupons';
import { etToday, nextPeriod, prevPeriod, periodOfDay } from '@/features/pricing/lib/promoCalendar';
import {
  CALENDAR_KINDS, MARKETS, calendarItems, channelsIn, daysIndex, entriesOf, filterItems, kindOf, monthRange, monthWeeks, stateOf, timelineOf,
} from '@/features/pricing/lib/promoCalendarItems';

// Pricing's Calendar tab (user, 2026-11-16: "son muchísimas, y sería más
// sencillo llevarlo así" — the team kept one by hand in Asana; "hazlo bien
// bonito"). Every promotion, deal, event and coupon the PIM holds, by its own
// dates, in two views: the month — each one on the day it starts and the day
// it ends, with a strip per day for what is running — and the timeline, a row
// per marketplace with a bar from the first day to the last. Nothing is typed
// here: a click opens the promotion's own card on its tab.

// Each kind's colours (index.css, --color-promo-*): the colour itself for
// what is no text, its container and the text on it. Written out in full —
// Tailwind only makes the classes it can read.
const LOOK = {
  monthly: { dot: 'bg-promo-monthly', chip: 'bg-promo-monthly-container text-on-promo-monthly-container', spine: 'border-l-promo-monthly', line: 'border-promo-monthly/55', ink: 'text-on-promo-monthly-container', icon: 'text-promo-monthly', spineOver: 'border-l-promo-monthly/45', iconOver: 'text-promo-monthly/60', dotOver: 'bg-promo-monthly/45' },
  flash: { dot: 'bg-promo-flash', chip: 'bg-promo-flash-container text-on-promo-flash-container', spine: 'border-l-promo-flash', line: 'border-promo-flash/55', ink: 'text-on-promo-flash-container', icon: 'text-promo-flash', spineOver: 'border-l-promo-flash/45', iconOver: 'text-promo-flash/60', dotOver: 'bg-promo-flash/45' },
  mk_event: { dot: 'bg-promo-mk', chip: 'bg-promo-mk-container text-on-promo-mk-container', spine: 'border-l-promo-mk', line: 'border-promo-mk/55', ink: 'text-on-promo-mk-container', icon: 'text-promo-mk', spineOver: 'border-l-promo-mk/45', iconOver: 'text-promo-mk/60', dotOver: 'bg-promo-mk/45' },
  special: { dot: 'bg-promo-special', chip: 'bg-promo-special-container text-on-promo-special-container', spine: 'border-l-promo-special', line: 'border-promo-special/55', ink: 'text-on-promo-special-container', icon: 'text-promo-special', spineOver: 'border-l-promo-special/45', iconOver: 'text-promo-special/60', dotOver: 'bg-promo-special/45' },
  coupon: { dot: 'bg-promo-coupon', chip: 'bg-promo-coupon-container text-on-promo-coupon-container', spine: 'border-l-promo-coupon', line: 'border-promo-coupon/55', ink: 'text-on-promo-coupon-container', icon: 'text-promo-coupon', spineOver: 'border-l-promo-coupon/45', iconOver: 'text-promo-coupon/60', dotOver: 'bg-promo-coupon/45' },
};
// One that is over is faint, so what is running or coming stands out (user, 2026-11-16: "más tenues … que se note
// la diferencia entre las activas y las no activas"): no fill, a hairline around it, lighter text in the regular
// weight, and its kind's colour dimmed on the spine. The text is a lighter COLOUR, never the chip made see-through:
// it keeps 4.5:1 on every surface of the calendar.
const OVER = 'bg-transparent text-on-surface-variant/80 font-normal ring-1 ring-inset ring-outline-variant/70';
const OVER_END = 'border-outline-variant text-on-surface-variant/80 font-normal';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const fmt = (day, opts) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', ...opts });
const monthTitle = (period) => fmt(period, { month: 'long', year: 'numeric' });
const longDay = (day) => fmt(day, { weekday: 'long', month: 'long', day: 'numeric' });
const shortDay = (day) => fmt(day, { month: 'short', day: 'numeric' });
const rangeText = (a, b) => (a === b ? shortDay(a) : `${shortDay(a)} – ${shortDay(b)}${a.slice(0, 4) === b.slice(0, 4) ? '' : `, ${b.slice(0, 4)}`}`);
const dayNumber = (day) => Number(day.slice(8, 10));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const marketTag = (markets) => (markets.length === 1 ? MARKETS.find((m) => m.key === markets[0])?.tag ?? '' : '');
const marketWords = (markets) => (markets.length === 1 ? MARKETS.find((m) => m.key === markets[0])?.label ?? '' : 'Canada and USA');
const whereText = (item) => (item.kind === 'monthly' ? 'Every marketplace' : item.channels.map((c) => c.label).join(', ') || 'No marketplace yet');

const segment = (on) => cn('inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full text-body-sm whitespace-nowrap transition-colors', on ? 'bg-on-surface text-surface font-semibold' : 'text-on-surface-variant hover:text-on-surface');
const roundButton = 'inline-flex items-center justify-center w-9 h-9 rounded-full border border-outline-variant text-on-surface hover:bg-surface-container-low transition-colors';

/**
 * @param promotions  listPromotions rows (every kind), or null while they load
 * @param state       { period, view, hidden, market, channel } — kept by the page
 * @param onState     (next) => void
 * @param onOpen      (item) => void — opens the promotion's or the coupon's card on its tab
 */
export default function PromoCalendar({ promotions, state, onState, onOpen }) {
  const titleId = useId();
  const today = etToday();
  const { period, view, hidden, market, channel } = state;
  const set = (patch) => onState({ ...state, ...patch });

  const [coupons, setCoupons] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    listCoupons().then((list) => { if (alive) setCoupons(list); }).catch((err) => { if (alive) { setCoupons([]); setError(err.message); } });
    return () => { alive = false; };
  }, []);

  const [openDay, setOpenDay] = useState(null); // the day whose list is open

  const all = useMemo(() => calendarItems(promotions ?? [], coupons ?? []), [promotions, coupons]);
  const month = monthRange(period);
  const inMonth = (it) => it.spans.some((s) => s.start <= month.end && s.end >= month.start);
  // The country and marketplace filters first: the legend counts what they leave of each kind.
  const placed = useMemo(() => filterItems(all, { market, channel }), [all, market, channel]);
  const shown = useMemo(() => placed.filter((it) => !hidden.includes(it.kind)), [placed, hidden]);
  const monthItems = shown.filter(inMonth);
  const countOf = (kind) => placed.filter((it) => it.kind === kind && inMonth(it)).length;
  const runningToday = shown.filter((it) => !it.ended && it.spans.some((s) => s.start <= today && today <= s.end)).length;
  const channels = useMemo(() => channelsIn(filterItems(all, { market })), [all, market]);
  const filtered = hidden.length > 0 || market || channel;

  const loading = promotions === null || coupons === null;
  const toggleKind = (key) => set({ hidden: hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key] });
  const open = (item) => { setOpenDay(null); onOpen(item); };

  return (
    // `@container`: the month and the timeline adapt to this card's own width, not the window's. `overflow-clip`, not
    // hidden: it rounds the corners without making a scroll box, so the headers inside can stick to the page's top.
    <section aria-labelledby={titleId} className="@container rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-clip">
      <div className="px-4 sm:px-5 pt-4 pb-3.5 space-y-3.5 border-b border-outline-variant">
        <div className="flex items-center justify-between gap-x-4 gap-y-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={() => set({ period: prevPeriod(period) })} aria-label="Previous month" title="Previous month" className={roundButton}>
              <ChevronLeft className="w-4 h-4" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => set({ period: nextPeriod(period) })} aria-label="Next month" title="Next month" className={roundButton}>
              <ChevronRight className="w-4 h-4" aria-hidden="true" />
            </button>
            <h2 id={titleId} className="text-headline-sm text-on-surface ml-1.5">{monthTitle(period)}</h2>
            {period !== periodOfDay(today) && (
              <button type="button" onClick={() => set({ period: periodOfDay(today) })} className="ml-1 px-3 py-1.5 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">
                Today
              </button>
            )}
          </div>
          <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
            {!loading && (
              <p className="text-body-sm text-on-surface-variant" role="status">
                <span className="text-on-surface font-medium">{monthItems.length}</span> this month
                {period === periodOfDay(today) && <> · <span className="text-on-surface font-medium">{runningToday}</span> running today</>}
              </p>
            )}
            <div role="group" aria-label="View" className="flex rounded-full border border-outline-variant p-0.5">
              <button type="button" aria-pressed={view === 'month'} onClick={() => set({ view: 'month' })} className={segment(view === 'month')}>
                <CalendarDays className="w-3.5 h-3.5" aria-hidden="true" /> Month
              </button>
              <button type="button" aria-pressed={view === 'timeline'} onClick={() => set({ view: 'timeline' })} className={segment(view === 'timeline')}>
                <ChartGantt className="w-3.5 h-3.5" aria-hidden="true" /> Timeline
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-x-4 gap-y-2.5 flex-wrap">
          <div role="group" aria-label="Kinds shown" className="flex items-center gap-1.5 flex-wrap">
            {CALENDAR_KINDS.map((k) => {
              const on = !hidden.includes(k.key);
              return (
                <button
                  key={k.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleKind(k.key)}
                  title={on ? `Hide the ${k.label.toLowerCase()}` : `Show the ${k.label.toLowerCase()}`}
                  className={cn(
                    'inline-flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full text-label-md whitespace-nowrap border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                    on ? cn(LOOK[k.key].chip, 'border-transparent') : 'border-outline-variant text-on-surface-variant hover:text-on-surface',
                  )}
                >
                  <span aria-hidden="true" className={cn('w-2 h-2 rounded-full', on ? LOOK[k.key].dot : 'ring-1 ring-inset ring-outline')} />
                  {k.label}
                  <span className="tabular-nums font-semibold">{countOf(k.key)}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div role="group" aria-label="Country" className="flex rounded-full border border-outline-variant p-0.5">
              {[{ key: null, label: 'All' }, ...MARKETS].map((m) => (
                <button key={m.label} type="button" aria-pressed={market === m.key} onClick={() => set({ market: m.key, channel: null })} className={segment(market === m.key)}>
                  {m.label}
                </button>
              ))}
            </div>
            <label className="relative">
              <span className="sr-only">Marketplace</span>
              <select
                value={channel ?? ''}
                onChange={(e) => set({ channel: e.target.value || null })}
                className="appearance-none pl-3.5 pr-8 py-[0.4rem] rounded-full border border-outline-variant bg-surface text-body-sm text-on-surface hover:bg-surface-container-low focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/30 transition-colors"
              >
                <option value="">Every marketplace</option>
                {MARKETS.map((m) => {
                  const list = channels.filter((c) => c.market === m.key);
                  return list.length ? (
                    <optgroup key={m.key} label={m.label}>
                      {list.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </optgroup>
                  ) : null;
                })}
              </select>
              <ChevronRight className="w-3.5 h-3.5 rotate-90 absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" aria-hidden="true" />
            </label>
          </div>
        </div>
      </div>

      {error && <p role="alert" className="mx-4 sm:mx-5 mt-3 rounded-xl bg-error-container/60 text-on-error-container px-4 py-2.5 text-body-sm">The coupons could not be read: {error}</p>}

      {loading ? (
        <div className="px-6 py-16 text-center text-on-surface-variant text-body-md">
          <Loader2 className="w-5 h-5 animate-spin inline-block mr-2 align-middle" aria-hidden="true" />
          Loading the calendar…
        </div>
      ) : view === 'month' ? (
        <MonthView period={period} items={shown} today={today} onOpen={open} onDay={setOpenDay} />
      ) : (
        <TimelineView period={period} items={shown} today={today} onOpen={open} />
      )}

      {!loading && monthItems.length === 0 && (
        <div className="px-6 py-8 text-center border-t border-outline-variant" role="status">
          <p className="text-body-md text-on-surface font-medium">Nothing in {monthTitle(period)}{filtered ? ' with these filters' : ''}</p>
          {filtered && (
            <button type="button" onClick={() => set({ hidden: [], market: null, channel: null })} className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">
              Show everything
            </button>
          )}
        </div>
      )}

      <div className="px-4 sm:px-5 py-3 border-t border-outline-variant bg-surface-container-low/60 text-body-sm text-on-surface-variant flex items-center gap-x-3 gap-y-2 flex-wrap">
        {view === 'month' && (
          <span className="inline-flex items-center gap-1.5 flex-shrink-0" aria-hidden="true">
            <span className="inline-flex items-center h-6 px-2 rounded-md border-l-[3px] border-l-outline bg-surface-container-high text-label-md text-on-surface">Starts</span>
            <span className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-dashed border-outline text-label-md text-on-surface"><Flag className="w-3 h-3" strokeWidth={2.25} />Ends</span>
            <span className={cn('inline-flex items-center h-6 px-2 rounded-md border-l-[3px] border-l-outline/45 text-label-md', OVER)}>Over</span>
          </span>
        )}
        <p className="min-w-0">
          {view === 'month'
            ? 'A promotion shows on the day it starts and on the day it ends (the one with the flag); one that is over is faint. The strip at the foot of a day is what is running then; its number opens the list.'
            : 'A row per marketplace, a bar from the first day to the last; one that is over is faint. A monthly promotion runs on each country’s own days.'}
          {' '}Days are Eastern time. Click a promotion to open it.
        </p>
      </div>

      {openDay && <DayDialog day={openDay} items={shown} today={today} onOpen={open} onClose={() => setOpenDay(null)} />}
    </section>
  );
}

// ================================ Month ================================

const MAX_CHIPS = 3;

function MonthView({ period, items, today, onOpen, onDay }) {
  const weeks = useMemo(() => monthWeeks(period), [period]);
  const index = useMemo(() => daysIndex(items, weeks.flat().map((c) => c.day)), [items, weeks]);
  const busiest = Math.max(1, ...[...index.values()].map((d) => d.running.length));

  return (
    <table className="w-full table-fixed border-separate border-spacing-0 [&>tbody>tr:last-child>td]:border-b-0">
      <caption className="sr-only">{monthTitle(period)}: what starts, ends and runs each day</caption>
      <thead>
        <tr>
          {WEEKDAYS.map((d, i) => (
            <th key={d} scope="col" className={cn('sticky top-0 z-10 px-1.5 @2xl:px-2.5 py-2 text-left text-label-md font-medium text-on-surface-variant border-b border-outline-variant', i === 0 || i === 6 ? 'bg-surface-container-low' : 'bg-surface-container-lowest')}>
              <span aria-hidden="true"><span className="@2xl:hidden">{d.slice(0, 1)}</span><span className="hidden @2xl:inline">{d.slice(0, 3)}</span></span>
              <span className="sr-only">{d}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week) => (
          <tr key={week[0].day}>
            {week.map((cell, i) => (
              <DayCell key={cell.day} cell={cell} weekend={i === 0 || i === 6} info={index.get(cell.day)} today={today} busiest={busiest} onOpen={onOpen} onDay={onDay} />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DayCell({ cell, weekend, info, today, busiest, onOpen, onDay }) {
  const { day, inMonth } = cell;
  const isToday = day === today;
  const chips = [
    ...info.starts.map((e) => ({ entry: e, ends: false })),
    // One that starts and ends the same day is said once, as a start.
    ...info.ends.filter((e) => e.start !== day).map((e) => ({ entry: e, ends: true })),
  ];
  const visible = chips.length > MAX_CHIPS ? chips.slice(0, MAX_CHIPS - 1) : chips;
  const more = chips.length - visible.length;
  const total = info.running.length;

  return (
    <td className={cn(
      'relative align-top p-0 border-b border-r border-outline-variant last:border-r-0',
      isToday ? 'bg-primary-container/25' : !inMonth ? 'bg-surface-container-low' : weekend && 'bg-surface-container-low/50',
    )}
    >
      <div className="flex flex-col gap-1 p-1 @2xl:p-1.5 pb-4 @2xl:pb-5 min-h-[4.25rem] @2xl:min-h-[8.5rem]">
        <div className="flex items-center justify-between gap-1">
          <span className={cn(
            'inline-flex items-center justify-center min-w-6 h-6 px-1.5 rounded-full text-label-lg tabular-nums',
            isToday ? 'bg-primary text-on-primary font-semibold' : inMonth ? 'text-on-surface' : 'text-on-surface-variant',
          )}
          >
            <span aria-hidden="true">{dayNumber(day) === 1 && <span className="hidden @2xl:inline">{fmt(day, { month: 'short' })}&nbsp;</span>}{dayNumber(day)}</span>
            <span className="sr-only">{longDay(day)}{isToday ? ', today' : ''}</span>
          </span>
          {total > 0 && (
            <button
              type="button"
              onClick={() => onDay(day)}
              aria-label={`${total} running on ${longDay(day)}: show the list`}
              title={`${total} running — show the list`}
              className="inline-flex items-center justify-center min-w-6 h-6 p-1 -m-0.5 rounded-full text-label-sm tabular-nums text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
            >
              {total}<span className="hidden @5xl:inline">&nbsp;running</span>
            </button>
          )}
        </div>

        {/* A phone has no room for names: a dot per start (filled) and per end (a ring), the list one tap away. */}
        {chips.length > 0 && (
          <div className="@2xl:hidden flex flex-wrap gap-0.5 px-0.5" aria-hidden="true">
            {chips.slice(0, 8).map(({ entry, ends }, i) => (
              <span key={i} className={cn('w-1.5 h-1.5 rounded-full', ends ? cn('border', LOOK[entry.item.kind].line) : stateOf(entry, today) === 'ended' ? LOOK[entry.item.kind].dotOver : LOOK[entry.item.kind].dot)} />
            ))}
          </div>
        )}

        <ul className="hidden @2xl:flex flex-col gap-1 min-w-0">
          {visible.map(({ entry, ends }) => (
            <li key={`${entry.item.id}:${entry.start}:${ends ? 'e' : 's'}`} className="min-w-0">
              <DayChip entry={entry} ends={ends} today={today} onOpen={onOpen} />
            </li>
          ))}
          {more > 0 && (
            <li>
              <button type="button" onClick={() => onDay(day)} className="px-1.5 py-0.5 rounded-md text-label-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors">
                {more} more
              </button>
            </li>
          )}
        </ul>
      </div>

      {/* The day's strip: as tall as the day is busy, a segment per kind. */}
      {total > 0 && (
        <div aria-hidden="true" className={cn('absolute inset-x-1 @2xl:inset-x-1.5 bottom-1 @2xl:bottom-1.5 flex items-end gap-px overflow-hidden rounded-full', day < today && 'opacity-40')} style={{ height: 3 + Math.round((7 * total) / busiest) }}>
          {CALENDAR_KINDS.filter((k) => info.byKind[k.key]).map((k) => (
            <span key={k.key} className={cn('h-full', LOOK[k.key].dot)} style={{ flexGrow: info.byKind[k.key] }} />
          ))}
        </div>
      )}
    </td>
  );
}

function DayChip({ entry, ends, today, onOpen }) {
  const { item } = entry;
  const look = LOOK[item.kind];
  const over = stateOf(entry, today) === 'ended';
  const tag = marketTag(entry.markets);
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      title={`${ends ? 'Ends: ' : ''}${item.name} · ${rangeText(entry.start, entry.end)} · ${whereText(item)}`}
      data-chip={ends ? 'end' : 'start'}
      className={cn(
        'w-full min-w-0 h-6 flex items-center gap-1 rounded-md pr-1.5 text-left text-label-md transition-[filter] hover:brightness-95 [.dark_&]:hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        ends
          ? cn('pl-1.5 border border-dashed', over ? OVER_END : cn(look.line, look.ink))
          : cn('pl-1.5 border-l-[3px]', over ? cn(look.spineOver, OVER) : cn(look.spine, look.chip)),
      )}
    >
      {ends && <Flag className={cn('w-3 h-3 flex-shrink-0', over ? look.iconOver : look.icon)} strokeWidth={2.25} aria-hidden="true" />}
      <span className="truncate">{item.name}</span>
      {tag && <span className={cn('ml-auto pl-1 flex-shrink-0 text-[0.625rem] leading-none font-semibold tracking-wider', !over && 'opacity-80')}>{tag}</span>}
      {/* What the look says, in words (the name a screen reader hears starts with what is on screen). */}
      <span className="sr-only">, {kindOf(item.kind).one}{entry.markets.length === 1 ? `, ${marketWords(entry.markets)}` : ''}, {ends ? 'ends' : 'starts'} this day, {rangeText(entry.start, entry.end)}{over ? ', over' : ''}</span>
    </button>
  );
}

// ================================ A day's list ================================

function DayDialog({ day, items, today, onOpen, onClose }) {
  const info = useMemo(() => daysIndex(items, [day]).get(day), [items, day]);
  const moving = new Set([...info.starts, ...info.ends].map((e) => e.item.id));
  const groups = [
    { title: 'Starting', rows: info.starts },
    { title: 'Ending', rows: info.ends.filter((e) => e.start !== day) },
    { title: 'Also running', rows: entriesOf(info.running.filter((it) => !moving.has(it.id))).filter((e) => e.start <= day && day <= e.end) },
  ].filter((g) => g.rows.length);
  const counts = [plural(info.running.length, 'promotion') + ' running', info.starts.length && `${info.starts.length} starting`, groups.find((g) => g.title === 'Ending')?.rows.length && `${groups.find((g) => g.title === 'Ending').rows.length} ending`].filter(Boolean);

  return (
    <Dialog onClose={onClose} title={`${longDay(day)}${day === today ? ' · today' : ''}`} subtitle={counts.join(' · ')} maxWidth="max-w-xl">
      <div className="space-y-5">
        {groups.map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h3 className="text-label-md uppercase tracking-wider text-on-surface-variant mb-1.5">{g.title} <span className="tabular-nums">· {g.rows.length}</span></h3>
            <ul className="rounded-xl border border-outline-variant divide-y divide-outline-variant overflow-hidden">
              {g.rows.map((e) => (
                <li key={`${e.item.id}:${e.start}`}>
                  <button
                    type="button"
                    onClick={() => onOpen(e.item)}
                    className={cn('w-full flex items-start gap-3 pl-3 pr-4 py-2.5 text-left border-l-[3px] hover:bg-surface-container-low focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 transition-colors', stateOf(e, today) === 'ended' ? LOOK[e.item.kind].spineOver : LOOK[e.item.kind].spine)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-body-md font-normal [overflow-wrap:anywhere]', stateOf(e, today) === 'ended' ? 'text-on-surface-variant' : 'text-on-surface')}>{e.item.name}</span>
                      <span className="block text-body-sm text-on-surface-variant">
                        {kindOf(e.item.kind).one}{e.markets.length === 1 ? ` · ${marketWords(e.markets)}` : ''} · {whereText(e.item)}
                        {e.item.skus > 0 && <> · {plural(e.item.skus, 'SKU')}</>}
                      </span>
                    </span>
                    <span className="flex-shrink-0 text-right">
                      <span className="block text-body-sm text-on-surface tabular-nums whitespace-nowrap">{rangeText(e.start, e.end)}</span>
                      <span className="block text-label-md text-on-surface-variant">{stateOf(e, today) === 'ended' ? 'Ended' : stateOf(e, today) === 'scheduled' ? 'Scheduled' : 'Running'}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

// ================================ Timeline ================================

function TimelineView({ period, items, today, onOpen }) {
  const groups = useMemo(() => timelineOf(items, period), [items, period]);
  const { start, end } = monthRange(period);
  const count = dayNumber(end);
  const days = Array.from({ length: count }, (_, i) => `${start.slice(0, 8)}${String(i + 1).padStart(2, '0')}`);
  const weekend = (day) => { const w = new Date(`${day}T12:00:00Z`).getUTCDay(); return w === 0 || w === 6; };
  const columns = { gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` };
  // The name column: narrow on a phone (the name on two lines, no monogram), so the days keep the room.
  const rowShape = 'grid grid-cols-[6.75rem_minmax(0,1fr)] @2xl:grid-cols-[13.5rem_minmax(0,1fr)]';

  // Whether the month fits the card. When it does, nothing scrolls sideways and the box is no scroll box, so each
  // country's band (its name and its days) sticks to the top of the page while its rows go by. When it does not (a
  // phone), the box scrolls sideways, takes the keyboard's focus, and opens with today in view instead of the 1st.
  const scroller = useRef(null);
  const [fits, setFits] = useState(true);
  const has = groups.length > 0;
  useEffect(() => {
    const box = scroller.current;
    if (!box) return undefined;
    const watch = new ResizeObserver(() => setFits((box.firstElementChild?.offsetWidth ?? 0) <= box.clientWidth + 1));
    watch.observe(box);
    return () => watch.disconnect();
  }, [has]);
  useEffect(() => {
    const box = scroller.current;
    if (!box || fits) return;
    const label = box.querySelector('[data-name-column]')?.getBoundingClientRect().width ?? 0;
    const column = (box.scrollWidth - label) / count;
    box.scrollLeft = today >= start && today <= end ? Math.max(0, (dayNumber(today) - 2) * column) : 0;
  }, [fits, period, today, start, end, count, has]);

  if (!groups.length) return null;
  return (
    // `relative`: the bars' screen-reader names stay inside this box; it takes the keyboard's focus while it scrolls sideways.
    <div ref={scroller} className={cn('relative', fits ? 'overflow-x-clip' : 'overflow-x-auto')} tabIndex={fits ? undefined : 0} role="region" aria-label={`Timeline of ${monthTitle(period)} by marketplace`}>
      <div className="min-w-[58rem] [&>section:last-child>ul>li:last-child]:border-b-0">
        {groups.map((g) => (
          <section key={g.market.key} aria-label={g.market.label}>
            {/* Each country's band is also the ruler of its rows: the days are never far from a bar. */}
            <div className={cn(rowShape, 'sticky top-0 z-20 border-b border-outline-variant bg-surface-container-low')}>
              <h3 data-name-column className="sticky left-0 z-20 bg-surface-container-low border-r border-outline-variant px-3 @2xl:px-4 flex items-center text-label-md uppercase tracking-wider text-on-surface-variant">{g.market.label}</h3>
              <div className="grid" style={columns} aria-hidden="true">
                {days.map((day) => (
                  <div key={day} className={cn('py-1.5 text-center', weekend(day) && 'bg-surface-container/80')}>
                    <div className="text-[0.625rem] leading-none uppercase tracking-wider text-on-surface-variant">{WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()].slice(0, 1)}</div>
                    <div className={cn('mt-1 mx-auto inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full text-label-md tabular-nums', day === today ? 'bg-primary text-on-primary font-semibold' : 'text-on-surface')}>{dayNumber(day)}</div>
                  </div>
                ))}
              </div>
            </div>
            <ul>
              {g.rows.map(({ channel, lanes }) => (
                <li key={channel.key} className={cn(rowShape, 'border-b border-outline-variant/70')}>
                  <div className="sticky left-0 z-10 bg-surface-container-lowest border-r border-outline-variant px-3 @2xl:px-4 py-2 flex items-center gap-2.5 min-w-0">
                    <span aria-hidden="true" className="hidden @2xl:flex w-7 h-7 rounded-lg bg-surface-container-high text-on-surface-variant text-[0.625rem] font-semibold tracking-wide items-center justify-center flex-shrink-0">{channel.monogram}</span>
                    <span className="text-label-md @2xl:text-body-sm text-on-surface font-normal line-clamp-2 @2xl:line-clamp-1" title={channel.label}>{channel.label}</span>
                  </div>
                  <div className="relative py-1.5">
                    <div className="absolute inset-0 grid" style={columns} aria-hidden="true">
                      {days.map((day) => (
                        <div key={day} className={cn('border-l border-outline-variant/40 first:border-l-0', day === today ? 'bg-primary-container/35' : weekend(day) && 'bg-surface-container-low/70')} />
                      ))}
                    </div>
                    <ul className="relative space-y-1">
                      {lanes.map((lane, i) => (
                        <li key={i} className="grid h-6" style={columns}>
                          {lane.map((bar) => <TimelineBar key={`${bar.item.id}:${bar.start}`} bar={bar} channel={channel} today={today} onOpen={onOpen} />)}
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function TimelineBar({ bar, channel, today, onOpen }) {
  const { item } = bar;
  const look = LOOK[item.kind];
  const over = stateOf(bar, today) === 'ended';
  const days = bar.to - bar.from + 1;
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      style={{ gridColumn: `${bar.from} / ${bar.to + 1}` }}
      aria-label={`${kindOf(item.kind).one}: ${item.name}, ${rangeText(bar.start, bar.end)}, ${channel.label}`}
      title={`${item.name} · ${rangeText(bar.start, bar.end)}${item.skus ? ` · ${plural(item.skus, 'SKU')}` : ''}`}
      className={cn(
        'mx-px min-w-0 h-6 flex items-center px-1.5 text-left text-label-md border-l-[3px] transition-[filter] hover:brightness-95 [.dark_&]:hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60 focus-visible:z-10',
        over ? cn(look.spineOver, OVER) : cn(look.spine, look.chip),
        // A bar that goes on before or after the month ends square on that side.
        bar.cutStart ? 'rounded-l-none' : 'rounded-l-md',
        bar.cutEnd ? 'rounded-r-none' : 'rounded-r-md',
      )}
    >
      {/* The name follows the scroll, so a long bar still says what it is once its first days are out of view. */}
      {days >= 2 && <span className="truncate sticky left-[7.25rem] @2xl:left-[14rem]">{item.name}</span>}
    </button>
  );
}
