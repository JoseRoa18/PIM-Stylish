import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, Upload, Check, X, Loader2 } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { getAppSetting } from '@/features/settings/api/appSettings';
import { listTaskPromotions, markPromotionTask, TASK_EVENT } from '@/features/pricing/api/promoTasks';
import { ownedTaskChannels, openTasksFor, taskKey, TASK_LABEL } from '@/features/pricing/lib/promoTasks';
import { etToday } from '@/features/pricing/lib/promoCalendar';

// The file tasks of the channels this person owns (Settings → Promotion file
// owners): Wayfair's promotions file and promo MAP when a promotion starts,
// the price change back to Blue when it ends; Menards' file at both ends.
// Same toast family as PromoNudge,
// but it does NOT auto-hide — it's a deadline. "Later" hides it for a few
// hours; it goes away for good when the PIM fills the file or the person marks
// it done. Checked a few seconds after the app opens and every half hour.
const FIRST_CHECK_MS = 4_000;
const RECHECK_MS = 30 * 60 * 1000;
const LATER_MS = 4 * 60 * 60 * 1000;
const AFTER_OPEN_MS = 30 * 60 * 1000; // hidden while the person uploads
const SHOWN = 3;
let navSeq = 0; // tags each "Upload file" click for the Pricing page

const snoozeKey = (userId) => `pim.promoTasks.snooze.${userId}`;
function readSnooze(userId) {
  try {
    return JSON.parse(localStorage.getItem(snoozeKey(userId)) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function snooze(userId, ids, ms) {
  try {
    const now = Date.now();
    const map = Object.fromEntries(Object.entries(readSnooze(userId)).filter(([, until]) => until > now));
    for (const id of ids) map[id] = now + ms;
    localStorage.setItem(snoozeKey(userId), JSON.stringify(map));
  } catch {
    // worst case the reminder shows again sooner
  }
}

const dayLabel = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// What to do, per channel (promoChannels `taskHow`); Wayfair's wording is the default.
const HOW = {
  promo_file: 'Download the promotions file from Partner Home and upload it here — the PIM fills it.',
  price_start: "Download the pricing file from Partner Home — the PIM lowers the MAP to the promotion's level.",
  price_change: 'Download the pricing file from Partner Home — the PIM puts the products back at Blue.',
};

// The channel's monogram tile, in its brand colour where the theme has one.
const MONOGRAM_CLS = {
  wayfair_ca: 'bg-brand-wayfair/15 text-brand-wayfair',
  wayfair_us: 'bg-brand-wayfair/15 text-brand-wayfair',
  default: 'bg-surface-container-high text-on-surface-variant',
};
// The task's dot: the price level it moves to (Orange / Blue as in Pricing).
const TASK_DOT = { promo_file: 'bg-primary', price_start: 'bg-[#f0b27a]', price_change: 'bg-[#4a8ee6]' };

// "starts Oct 1" / "ended Oct 21" — the promotion's side of the date.
function whenText(t, today) {
  const ending = t.task === 'price_change';
  if (t.due === today) return ending ? 'ends today' : 'starts today';
  if (ending) return `ended ${dayLabel(t.due)}`;
  return t.overdue ? `started ${dayLabel(t.due)}` : `starts ${dayLabel(t.due)}`;
}

// The due chip: red once overdue, warm on the day, neutral before.
function dueChip(t, today) {
  if (t.overdue) return { text: `Overdue · ${dayLabel(t.due)}`, cls: 'bg-error-container text-on-error-container' };
  if (t.due === today) return { text: 'Due today', cls: 'bg-tertiary-container text-on-tertiary-container' };
  return { text: `Due ${dayLabel(t.due)}`, cls: 'bg-surface-container-high text-on-surface-variant' };
}

export default function PromoTaskNudge() {
  const { user, profile, isAdmin, canEdit } = useAuth();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState([]);
  const [today, setToday] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const userId = user?.id ?? null;
  const ready = Boolean(userId && profile && canEdit);

  const check = useCallback(async () => {
    if (!ready) return;
    try {
      const owners = await getAppSetting('promo_channel_owners', {});
      const channels = ownedTaskChannels(owners, userId, isAdmin);
      const promos = channels.length ? await listTaskPromotions() : [];
      const today = etToday();
      const hiddenUntil = readSnooze(userId);
      const now = Date.now();
      const open = [];
      for (const promo of promos) {
        for (const channel of channels) {
          for (const t of openTasksFor(promo, channel, today)) {
            const id = `${promo.id}:${taskKey(channel.key, t.task)}`;
            if ((hiddenUntil[id] ?? 0) > now) continue;
            open.push({ id, promo, channel, ...t });
          }
        }
      }
      open.sort((a, b) => a.due.localeCompare(b.due) || a.channel.label.localeCompare(b.channel.label));
      setToday(today);
      setTasks(open);
    } catch {
      // A failed check just waits for the next one.
    }
  }, [ready, userId, isAdmin]);

  useEffect(() => {
    if (!ready) return;
    const first = setTimeout(check, FIRST_CHECK_MS);
    const every = setInterval(check, RECHECK_MS);
    window.addEventListener(TASK_EVENT, check);
    return () => { clearTimeout(first); clearInterval(every); window.removeEventListener(TASK_EVENT, check); };
  }, [ready, check]);

  // Dev hatch: `promoTasks()` in the console re-checks now, snoozes ignored.
  useEffect(() => {
    if (!import.meta.env.DEV || !userId) return;
    window.promoTasks = () => { try { localStorage.removeItem(snoozeKey(userId)); } catch { /* ignore */ } check(); };
    return () => { delete window.promoTasks; };
  }, [userId, check]);

  if (!tasks.length) return null;
  const shown = tasks.slice(0, SHOWN);

  function later() {
    snooze(userId, tasks.map((t) => t.id), LATER_MS);
    setTasks([]);
  }

  function upload(t) {
    // The whole toast steps aside while the upload dialog is open (dialogs
    // render in the page, under it); the rest come back as soon as the file
    // is done (TASK_EVENT) or at the next check.
    snooze(userId, [t.id], AFTER_OPEN_MS);
    setTasks([]);
    navigate('/pricing', { state: { promoTask: { promoId: t.promo.id, fill: t.filler, nonce: ++navSeq } } });
  }

  async function markDone(t) {
    const ok = await confirm({
      title: `Mark "${TASK_LABEL[t.task]}" as done?`,
      message: `${t.channel.label}, "${t.promo.name}": use this when the file was already uploaded to Partner Home without the PIM. The reminder won't come back for it.`,
      confirmLabel: 'Mark done',
    });
    if (!ok) return;
    setBusyId(t.id);
    setError(null);
    try {
      await markPromotionTask(t.promo.id, taskKey(t.channel.key, t.task), { manual: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const overdue = tasks.filter((t) => t.overdue).length;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-40 w-[24rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-outline-variant/70 bg-surface shadow-xl overflow-hidden animate-menu-in-up"
    >
      {/* Header: what this is and how much is waiting */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <span className="w-10 h-10 rounded-xl bg-primary-container text-on-primary-container flex items-center justify-center flex-shrink-0">
          <CalendarClock className="w-5 h-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-title-md text-on-surface font-semibold leading-tight">Promotion files</p>
          <p className="text-body-sm text-on-surface-variant mt-0.5">
            {tasks.length === 1 ? '1 file due' : `${tasks.length} files due`}
            {overdue ? <span className="text-error font-medium"> · {overdue} overdue</span> : null}
          </p>
        </div>
        <button
          type="button"
          onClick={later}
          aria-label="Remind me later"
          className="p-1.5 -mr-1 rounded-full text-on-surface-variant hover:bg-on-surface/8 transition-colors self-start"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* One card per file */}
      <ul className="px-2 pb-2 space-y-1.5 max-h-[60vh] overflow-y-auto" data-lenis-prevent>
        {shown.map((t) => {
          const due = dueChip(t, today);
          const fromSaved = t.task === 'price_change' && Boolean(t.promo.file_tasks?.[taskKey(t.channel.key, t.channel.savedStart)]?.file);
          return (
            <li key={t.id} className="rounded-xl bg-surface-container-low px-3 py-3">
              <div className="flex items-start gap-3">
                <span className={`w-9 h-9 rounded-lg flex items-center justify-center text-label-md font-bold flex-shrink-0 ${MONOGRAM_CLS[t.channel.key] ?? MONOGRAM_CLS.default}`}>
                  {t.channel.monogram}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-label-lg font-semibold text-on-surface truncate">{t.channel.label}</span>
                    <span className={`ml-auto px-2 py-0.5 rounded-full text-label-sm font-medium whitespace-nowrap ${due.cls}`}>{due.text}</span>
                  </div>
                  <span className="mt-1 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-surface-container-high text-label-sm text-on-surface">
                    <span className={`w-1.5 h-1.5 rounded-full ${TASK_DOT[t.task]}`} />
                    {TASK_LABEL[t.task]}
                  </span>
                  <p className="mt-2 text-body-sm text-on-surface leading-snug">
                    <span className="font-medium">{t.promo.name}</span>
                    <span className="text-on-surface-variant"> · {whenText(t, today)}</span>
                  </p>
                  <p className="mt-0.5 text-body-sm text-on-surface-variant leading-snug">{fromSaved ? 'The file saved when it started is ready — the PIM puts the products back at Blue.' : t.channel.taskHow?.[t.task] ?? HOW[t.task]}</p>
                  <div className="mt-3 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => upload(t)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      {fromSaved ? 'Generate file' : 'Upload file'}
                    </button>
                    <button
                      type="button"
                      onClick={() => markDone(t)}
                      disabled={busyId === t.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-label-md text-on-surface-variant hover:bg-on-surface/8 transition-colors disabled:opacity-50"
                    >
                      {busyId === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      Already done
                    </button>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {error && <p className="mx-4 mb-2 text-body-sm rounded-lg px-3 py-2 bg-error-container/60 text-on-error-container">{error}</p>}

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-outline-variant/60 bg-surface-container-lowest">
        <span className="text-body-sm text-on-surface-variant">
          {tasks.length > SHOWN ? `+${tasks.length - SHOWN} more after these` : 'Stays until the file is done'}
        </span>
        <button
          type="button"
          onClick={later}
          className="px-3 py-1.5 rounded-full text-label-md font-medium text-on-surface-variant hover:bg-on-surface/8 transition-colors"
        >
          Remind me later
        </button>
      </div>
    </div>
  );
}
