import { PROMO_CHANNELS } from './promoChannels';
import { promoWindow, etToday } from './promoCalendar';

/**
 * Reminders for the channels whose promotion files come from their own portal
 * and go back through it (Wayfair Canada / USA since 2026-09-28, Menards since
 * 2026-09-29 — its file at the start and back to Blue at the end). Per
 * promotion and channel:
 *   promo_file    the promotions file — from a week before the window opens
 *                 until it closes, while it hasn't been filled
 *   price_start   the pricing file that lowers the MAP to the promotion's
 *                 level — due the day the window opens (never earlier: the
 *                 file has no dates, Wayfair applies it on import), until it closes
 *   price_change  the pricing file that puts the products back at Blue — due
 *                 on the last day of the window, reminded for two weeks after
 * Every kind of promotion, monthly included (user answers 2026-09-28).
 * The owner of each channel is app_settings.promo_channel_owners; a channel
 * without an owner reminds every admin.
 */

export const TASK_CHANNELS = PROMO_CHANNELS.filter((c) => c.priceChange);
export const TASK_LABEL = { promo_file: 'Promotions file', price_start: 'Promo MAP', price_change: 'Back to Blue' };
export const taskKey = (channelKey, task) => `${channelKey}:${task}`;

const LEAD_DAYS = 7;
// Reminders start with this feature: windows that opened (promotions file) or
// closed (price change) before it were handled without the PIM tracking them.
const TASKS_SINCE = '2026-09-28';
const GRACE_DAYS = 14;
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** A promotion made for chosen marketplaces reaches only those; a monthly one reaches every channel. */
export function channelAppliesTo(channel, promo) {
  const picked = promo.marketplaces ?? [];
  return picked.length ? picked.includes(channel.key) : true;
}

/** What `promo` still owes `channel` on `today`: [{ task, due, overdue, filler }]. */
export function openTasksFor(promo, channel, today = etToday()) {
  if (!channelAppliesTo(channel, promo)) return [];
  const w = promoWindow(promo, channel.market);
  if (!w?.start || !w?.end) return [];
  const done = promo.file_tasks ?? {};
  const out = [];
  if (!done[taskKey(channel.key, 'promo_file')] && promo.status !== 'ended'
    && w.start >= TASKS_SINCE && today >= addDays(w.start, -LEAD_DAYS) && today <= w.end) {
    out.push({ task: 'promo_file', due: w.start, overdue: today > w.start, filler: channel.filler });
  }
  if (channel.priceStart && !done[taskKey(channel.key, 'price_start')] && promo.status !== 'ended'
    && w.start >= TASKS_SINCE && today >= w.start && today <= w.end) {
    out.push({ task: 'price_start', due: w.start, overdue: today > w.start, filler: channel.priceStart });
  }
  if (!done[taskKey(channel.key, 'price_change')]
    && w.end >= TASKS_SINCE && today >= w.end && today <= addDays(w.end, GRACE_DAYS)) {
    out.push({ task: 'price_change', due: w.end, overdue: today > w.end, filler: channel.priceChange });
  }
  return out;
}

/** The task channels `userId` answers for. */
export function ownedTaskChannels(owners, userId, isAdmin) {
  return TASK_CHANNELS.filter((c) => (owners?.[c.key] ? owners[c.key] === userId : isAdmin));
}
