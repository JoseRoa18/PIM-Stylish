import { PROMO_CHANNELS } from './promoChannels';
import { promoWindow, shiftDay, monthEnd, etToday, periodOfDay } from './promoCalendar';

// Pricing's calendar (user, 2026-11-16: the team kept one by hand in Asana —
// "son muchísimas, y sería más sencillo llevarlo así"): every promotion the PIM
// already holds, by its own dates. Nothing is typed for it: a monthly
// promotion, a flash deal, an MK event, a peak season event and a coupon are
// the rows of the other tabs, read through the one rule for a promotion's
// days (promoWindow). Days are Eastern 'YYYY-MM-DD' strings.

/** The calendar as it opens — this month, by month, everything shown. The page keeps it while the person visits another tab. */
export const initialCalendar = () => ({ period: periodOfDay(etToday()), view: 'month', hidden: [], market: null, channel: null });

/** The kinds, in the order the legend and every list name them. */
export const CALENDAR_KINDS = [
  { key: 'monthly', label: 'Monthly promotions', one: 'Monthly promotion' },
  { key: 'flash', label: 'Flash deals', one: 'Flash deal' },
  { key: 'mk_event', label: 'MK events', one: 'MK event' },
  { key: 'special', label: 'Peak season events', one: 'Peak season event' },
  { key: 'coupon', label: 'Coupons', one: 'Coupon' },
];
const KIND_ORDER = new Map(CALENDAR_KINDS.map((k, i) => [k.key, i]));
export const kindOf = (key) => CALENDAR_KINDS.find((k) => k.key === key) ?? CALENDAR_KINDS[0];

export const MARKETS = [
  { key: 'ca', label: 'Canada', tag: 'CA' },
  { key: 'us', label: 'USA', tag: 'US' },
];

const channelByKey = new Map(PROMO_CHANNELS.map((c) => [c.key, c]));
/** Where a monthly promotion goes: every marketplace of its country but the ones kept for one kind (the Stylish stores). */
const MONTHLY_CHANNELS = PROMO_CHANNELS.filter((c) => !c.kinds || c.kinds.includes('monthly'));
/** A deal nobody gave a marketplace yet still has its days: it sits on this row of the timeline. */
export const NO_CHANNEL = { key: '', label: 'No marketplace yet', monogram: '–', market: null };

const etDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
const byKindThenName = (a, b) => (KIND_ORDER.get(a.kind) - KIND_ORDER.get(b.kind)) || a.name.localeCompare(b.name, undefined, { numeric: true });

/**
 * A promotion's days in one country, cut where it was ended early; null when
 * it was ended before it ever began.
 */
function span(market, window, endedDay) {
  const end = endedDay && endedDay < window.end ? endedDay : window.end;
  return end < window.start ? null : { market, start: window.start, end };
}

/**
 * Every promotion and coupon as one calendar item:
 *   { id, source: 'promotion' | 'coupon', kind, name, skus, by, ended,
 *     spans: [{ market, start, end }], channels: [channel], start, end }
 * `spans` are its days per country (a monthly promotion has its own in each;
 * a deal the one pair of its portals' countries); `channels` where it goes.
 */
export function calendarItems(promotions = [], coupons = []) {
  const items = [];
  for (const p of promotions) {
    const kind = p.kind ?? 'monthly';
    const channels = kind === 'monthly' ? MONTHLY_CHANNELS : (p.marketplaces ?? []).map((k) => channelByKey.get(k)).filter(Boolean);
    const markets = kind === 'monthly' || !channels.length ? ['ca', 'us'] : MARKETS.map((m) => m.key).filter((m) => channels.some((c) => c.market === m));
    const endedDay = p.status === 'ended' && p.ended_at ? etDay(p.ended_at) : null;
    const spans = markets.map((m) => span(m, promoWindow(p, m), endedDay)).filter(Boolean);
    if (spans.length) items.push(item({ id: p.id, source: 'promotion', kind, name: p.name, skus: p.sku_count ?? 0, by: p.created_by_name ?? null, ended: p.status === 'ended', spans, channels }));
  }
  for (const c of coupons) {
    const ch = channelByKey.get(c.marketplace);
    if (!ch || !c.starts_on || !c.ends_on) continue;
    const one = span(ch.market, { start: String(c.starts_on).slice(0, 10), end: String(c.ends_on).slice(0, 10) }, c.ended_at ? etDay(c.ended_at) : null);
    if (one) items.push(item({ id: c.id, source: 'coupon', kind: 'coupon', name: c.name, skus: c.sku_count ?? 0, by: c.created_by_name ?? null, ended: Boolean(c.ended_at), spans: [one], channels: [ch] }));
  }
  return items.sort(byKindThenName);
}

function item(base) {
  return {
    ...base,
    start: base.spans.reduce((s, x) => (x.start < s ? x.start : s), base.spans[0].start),
    end: base.spans.reduce((e, x) => (x.end > e ? x.end : e), base.spans[0].end),
  };
}

/**
 * The items a filter keeps, each cut down to what the filter shows:
 *   kinds   Set of kind keys to show (null = all)
 *   market  'ca' | 'us' | null
 *   channel a marketplace's key | null
 */
export function filterItems(items, { kinds = null, market = null, channel = null } = {}) {
  const out = [];
  for (const it of items) {
    if (kinds && !kinds.has(it.kind)) continue;
    let channels = it.channels;
    let spans = it.spans;
    if (channel) {
      channels = channels.filter((c) => c.key === channel);
      if (!channels.length) continue;
      spans = spans.filter((s) => s.market === channels[0].market);
    }
    if (market) {
      spans = spans.filter((s) => s.market === market);
      channels = channels.filter((c) => c.market === market);
    }
    if (!spans.length) continue;
    out.push(item({ ...it, spans, channels }));
  }
  return out;
}

/**
 * An item as the month shows it: one entry per run of days. A deal whose two
 * countries share their days is one entry; a monthly promotion, whose days
 * differ by country, is one per country.
 */
export function entriesOf(items) {
  const out = [];
  for (const it of items) {
    const runs = new Map();
    for (const s of it.spans) {
      const key = `${s.start}|${s.end}`;
      const run = runs.get(key) ?? { item: it, start: s.start, end: s.end, markets: [] };
      run.markets.push(s.market);
      runs.set(key, run);
    }
    out.push(...runs.values());
  }
  return out;
}

/** 'running' | 'scheduled' | 'ended' for a run of days, today. */
export const stateOf = (run, today) => (run.item?.ended || run.end < today ? 'ended' : run.start > today ? 'scheduled' : 'running');

/** The first day ('YYYY-MM-01') and the last of a month. */
export const monthRange = (period) => ({ start: period, end: monthEnd(period) });
const weekdayOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 Sunday

/** The weeks a month's grid shows, Sunday to Saturday: [[{ day, inMonth }]]. */
export function monthWeeks(period) {
  const { start, end } = monthRange(period);
  const first = shiftDay(start, -weekdayOf(start));
  const last = shiftDay(end, 6 - weekdayOf(end));
  const weeks = [];
  for (let day = first; day <= last;) {
    const week = [];
    for (let i = 0; i < 7; i++, day = shiftDay(day, 1)) week.push({ day, inMonth: day >= start && day <= end });
    weeks.push(week);
  }
  return weeks;
}

/**
 * What each of `days` holds: Map(day → { starts, ends, running, byKind }).
 *   starts / ends   the entries beginning / finishing that day
 *   running         the items live that day (each once, whatever its countries)
 *   byKind          how many of each kind are live, for the day's strip
 */
export function daysIndex(items, days) {
  const entries = entriesOf(items);
  const index = new Map();
  for (const day of days) {
    const running = items.filter((it) => it.spans.some((s) => s.start <= day && day <= s.end));
    const byKind = {};
    for (const it of running) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
    index.set(day, {
      starts: entries.filter((e) => e.start === day),
      ends: entries.filter((e) => e.end === day),
      running,
      byKind,
    });
  }
  return index;
}

/**
 * The timeline of a month: per country, a row per marketplace with its bars
 * laid in lanes (two promotions on the same days take two lanes).
 *   [{ market, rows: [{ channel, lanes: [[{ item, start, end, from, to, cutStart, cutEnd }]] }] }]
 * `from` / `to` are 1-based day columns inside the month; `cutStart` /
 * `cutEnd` say the bar goes on before / after it.
 */
export function timelineOf(items, period) {
  const { start, end } = monthRange(period);
  const column = (day) => Number(day.slice(8, 10));
  const byChannel = new Map();
  for (const it of items) {
    const channels = it.channels.length ? it.channels : [NO_CHANNEL];
    for (const ch of channels) {
      // A marketplace runs a promotion on its own country's days.
      const spans = ch.market ? it.spans.filter((s) => s.market === ch.market) : [{ start: it.start, end: it.end }];
      for (const s of spans) {
        if (s.end < start || s.start > end) continue;
        const bar = {
          item: it,
          start: s.start,
          end: s.end,
          from: column(s.start < start ? start : s.start),
          to: column(s.end > end ? end : s.end),
          cutStart: s.start < start,
          cutEnd: s.end > end,
        };
        const list = byChannel.get(ch.key) ?? [];
        list.push(bar);
        byChannel.set(ch.key, list);
      }
    }
  }
  const row = (channel) => {
    const bars = (byChannel.get(channel.key) ?? []).sort((a, b) => a.from - b.from || b.to - a.to || byKindThenName(a.item, b.item));
    const lanes = [];
    for (const bar of bars) {
      const lane = lanes.find((l) => l.at(-1).to < bar.from);
      if (lane) lane.push(bar); else lanes.push([bar]);
    }
    return { channel, lanes };
  };
  const groups = MARKETS.map((m) => ({
    market: m,
    rows: PROMO_CHANNELS.filter((c) => c.market === m.key && byChannel.has(c.key)).map(row),
  })).filter((g) => g.rows.length);
  if (byChannel.has(NO_CHANNEL.key)) groups.push({ market: { key: 'none', label: 'Not placed yet', tag: '' }, rows: [row(NO_CHANNEL)] });
  return groups;
}

/** The marketplaces any of the items goes to, in the app's own order. */
export const channelsIn = (items) => {
  const seen = new Set(items.flatMap((it) => it.channels.map((c) => c.key)));
  return PROMO_CHANNELS.filter((c) => seen.has(c.key));
};
