import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Tag, X, ArrowRight } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { supabase } from '@/lib/supabase';

// Same pacing philosophy as AvatarNudge: waits for the session to settle,
// auto-hides, and snoozes for a couple of days once shown — a reminder, not
// a nag. It only arms during the LAST 10 DAYS of the month, when next
// month's promotion should be getting loaded.
const APPEAR_DELAY_MS = 10_000;
const AUTO_HIDE_MS = 15_000;
const REMINDER_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 10;

const storageKey = (userId, period) => `pim.promoReminder.${userId}.${period}`;

function lastShownAt(userId, period) {
  try {
    return Number(localStorage.getItem(storageKey(userId, period))) || 0;
  } catch {
    return 0;
  }
}

function markShown(userId, period) {
  try {
    localStorage.setItem(storageKey(userId, period), String(Date.now()));
  } catch {
    // worst case the reminder shows again sooner
  }
}

/** First day of next month as the promotions.period value (YYYY-MM-01). */
function nextPromoPeriod(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const label = d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return { iso, label };
}

function inReminderWindow(now = new Date()) {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return now.getDate() > daysInMonth - WINDOW_DAYS;
}

/**
 * End-of-month reminder to load next month's promotion, in the same toast
 * style as the profile-photo nudge. Shows only to editors/admins, only in
 * the last days of the month, and only while next month's promo is missing
 * or incomplete (one market's prices not loaded yet).
 */
export default function PromoNudge() {
  const { user, canEdit } = useAuth();
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState(null);
  const [paused, setPaused] = useState(false);
  const { iso: period, label: monthLabel } = nextPromoPeriod();

  const userId = user?.id ?? null;

  const arm = useCallback(async () => {
    // What's next month's promo missing? Nothing → stay quiet.
    const { data, error } = await supabase
      .from('promotions')
      .select('id, promotion_prices(promo_price_cad, promo_price_usd)')
      .eq('period', period)
      .limit(1)
      .maybeSingle();
    if (error) return null;
    if (!data) return `The ${monthLabel} promotion isn't in the PIM yet. Load it so the price lists are ready before the month starts.`;
    const rows = data.promotion_prices ?? [];
    const hasCad = rows.some((r) => r.promo_price_cad != null);
    const hasUsd = rows.some((r) => r.promo_price_usd != null);
    if (!hasCad && !hasUsd) return `The ${monthLabel} promotion has no prices yet. Import its price lists before the month starts.`;
    if (!hasUsd) return `The ${monthLabel} promotion is missing its USA prices — only Canada is loaded so far.`;
    if (!hasCad) return `The ${monthLabel} promotion is missing its Canada prices — only USA is loaded so far.`;
    return null;
  }, [period, monthLabel]);

  useEffect(() => {
    if (!userId || !canEdit || !inReminderWindow()) return;
    if (Date.now() - lastShownAt(userId, period) < REMINDER_INTERVAL_MS) return;
    let active = true;
    const timer = setTimeout(async () => {
      const msg = await arm();
      if (!active || !msg) return;
      markShown(userId, period);
      setMessage(msg);
      setVisible(true);
    }, APPEAR_DELAY_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [userId, canEdit, period, arm]);

  // Auto-dismiss, held open while the pointer/keyboard is on the toast.
  useEffect(() => {
    if (!visible || paused) return;
    const timer = setTimeout(() => setVisible(false), AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [visible, paused]);

  // Dev hatch: `promoNudge()` in the console previews it immediately.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.promoNudge = async () => {
      const msg = await arm();
      setMessage(msg ?? `(complete) The ${monthLabel} promotion is fully loaded.`);
      setVisible(true);
    };
    return () => { delete window.promoNudge; };
  }, [arm, monthLabel]);

  if (!visible || !message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="fixed right-4 top-16 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-outline-variant bg-surface shadow-lg animate-menu-in"
    >
      <button
        type="button"
        onClick={() => setVisible(false)}
        aria-label="Dismiss reminder"
        className="absolute top-2 right-2 p-1.5 rounded-full text-on-surface-variant hover:bg-on-surface/8 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex items-start gap-3 p-4 pr-9">
        <span className="w-9 h-9 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center flex-shrink-0">
          <Tag className="w-4 h-4" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-title-md text-on-surface">Next month's promotion</p>
          <p className="mt-0.5 text-body-sm text-on-surface-variant">{message}</p>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setVisible(false); navigate('/pricing'); }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-on-primary text-label-lg hover:bg-primary/90 transition-colors"
            >
              <Tag className="w-4 h-4" />
              Go to Pricing
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setVisible(false)}
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
