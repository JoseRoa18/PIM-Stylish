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
// owners): Wayfair's promotions file when a promotion starts, its price change
// when a flash deal or special event ends. Same toast family as PromoNudge,
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

function describe(t, today) {
  const name = `"${t.promo.name}"`;
  if (t.task === 'promo_file') {
    const when = t.due === today ? 'starts today' : t.overdue ? `started ${dayLabel(t.due)}` : `starts ${dayLabel(t.due)}`;
    return `${name} ${when}. Download the promotions file from Partner Home and upload it here — the PIM fills it.`;
  }
  const when = t.due === today ? 'ends today' : `ended ${dayLabel(t.due)}`;
  return `${name} ${when}. Download the pricing file from Partner Home and upload it here — the PIM puts its products back at Blue.`;
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

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-40 w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-outline-variant bg-surface shadow-lg animate-menu-in"
    >
      <button
        type="button"
        onClick={later}
        aria-label="Remind me later"
        className="absolute top-2 right-2 p-1.5 rounded-full text-on-surface-variant hover:bg-on-surface/8 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex items-start gap-3 p-4 pr-9">
        <span className="w-9 h-9 rounded-full bg-tertiary-container text-on-tertiary-container flex items-center justify-center flex-shrink-0">
          <CalendarClock className="w-4 h-4" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-title-md text-on-surface">
            {tasks.length === 1 ? 'A promotion file is due' : `${tasks.length} promotion files are due`}
          </p>

          <ul className="mt-2 space-y-3">
            {shown.map((t) => (
              <li key={t.id}>
                <p className="text-label-lg font-medium text-on-surface">
                  {t.channel.label} · {TASK_LABEL[t.task]}
                  {t.overdue && <span className="ml-1.5 text-label-sm font-medium text-error">overdue</span>}
                </p>
                <p className="mt-0.5 text-body-sm text-on-surface-variant">{describe(t, today)}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => upload(t)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-on-primary text-label-lg hover:bg-primary/90 transition-colors"
                  >
                    <Upload className="w-4 h-4" />
                    Upload file
                  </button>
                  <button
                    type="button"
                    onClick={() => markDone(t)}
                    disabled={busyId === t.id}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-label-lg text-on-surface-variant hover:bg-on-surface/8 transition-colors disabled:opacity-50"
                  >
                    {busyId === t.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Already done
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {tasks.length > SHOWN && (
            <p className="mt-2 text-body-sm text-on-surface-variant">and {tasks.length - SHOWN} more — they show up here as these get done.</p>
          )}
          {error && <p className="mt-2 text-body-sm text-error">{error}</p>}

          <div className="mt-3">
            <button
              type="button"
              onClick={later}
              className="px-3 py-1.5 rounded-lg text-label-lg text-on-surface-variant hover:bg-on-surface/8 transition-colors"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
