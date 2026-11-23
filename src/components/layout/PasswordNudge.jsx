import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { KeyRound, X } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { hasOwnPassword } from '@/features/auth/lib/passwordRules';

// "Choose your own password" (user, 2026-11-23: a new person should be told at
// once, "usando como el mismo estilo de alertas, por ejemplo, el de las fotos").
// The twin of AvatarNudge, hanging off the same account chip, for anyone still
// on the password an admin generated for them. It comes up right after the
// page settles and waits to be answered — it does not fade by itself, since it
// is the first thing a new person should see — and once answered with Later it
// stays away for a few days. Choosing a password ends it for good.
const APPEAR_DELAY_MS = 1_500;
const REMINDER_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

// Per-user so a shared computer doesn't silence the reminder for everyone.
const storageKey = (userId) => `pim.passwordReminder.${userId}`;

function lastAnsweredAt(userId) {
  try {
    return Number(localStorage.getItem(storageKey(userId))) || 0;
  } catch {
    return 0; // storage blocked (private mode) — behave as "never shown"
  }
}

function markAnswered(userId) {
  try {
    localStorage.setItem(storageKey(userId), String(Date.now()));
  } catch {
    // Not worth surfacing: the worst case is the reminder shows again sooner.
  }
}

/**
 * `suspended`: the account menu is open — it has its own "Change password"
 * row, so opening it answers the reminder. `onVisibleChange` lets the menu
 * hold the photo reminder back while this one is up (they share one place).
 */
export default function PasswordNudge({ suspended = false, onVisibleChange }) {
  const { user, profile } = useAuth();
  const { pathname, search } = useLocation();
  const [visible, setVisible] = useState(false);
  // Dev-only preview (see the console hatch below).
  const [forced, setForced] = useState(false);

  const userId = user?.id ?? null;
  // `profile` is null until it resolves, so nothing shows while the app loads.
  const needsPassword = Boolean(profile) && Boolean(user) && !hasOwnPassword(user);
  // Already where the password is changed: the Security section, or the
  // account menu with its "Change password" row. Being there answers it.
  const onSecurity = pathname === '/settings' && (new URLSearchParams(search).get('section') ?? 'security') === 'security';
  const away = suspended || onSecurity;
  if (visible && away) setVisible(false);
  const open = visible && (needsPassword || forced);

  const answer = useCallback(() => {
    if (userId) markAnswered(userId);
    setVisible(false);
    setForced(false);
  }, [userId]);

  useEffect(() => {
    if (away && userId && needsPassword) markAnswered(userId);
  }, [away, userId, needsPassword]);

  // Arm it for someone still on a generated password, unless it was answered lately.
  useEffect(() => {
    if (!userId || !needsPassword || away) return;
    if (Date.now() - lastAnsweredAt(userId) < REMINDER_INTERVAL_MS) return;
    const timer = setTimeout(() => setVisible(true), APPEAR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [userId, needsPassword, away]);

  useEffect(() => {
    onVisibleChange?.(open);
  }, [open, onVisibleChange]);
  // Leaving the page (sign-out) frees the photo reminder too.
  useEffect(() => () => onVisibleChange?.(false), [onVisibleChange]);

  // Local testing hatch: `passwordNudge()` in the dev console shows it right
  // away, also for someone who already chose their password.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.passwordNudge = () => {
      setForced(true);
      setVisible(true);
    };
    return () => {
      delete window.passwordNudge;
    };
  }, []);

  if (!open) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute right-0 top-full mt-2 z-30 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-outline-variant bg-surface shadow-lg animate-menu-in"
    >
      <button
        type="button"
        onClick={answer}
        aria-label="Dismiss reminder"
        className="absolute top-2 right-2 p-1.5 rounded-full text-on-surface-variant hover:bg-on-surface/8 transition-colors"
      >
        <X className="w-4 h-4" aria-hidden />
      </button>

      <div className="flex items-start gap-3 p-4 pr-9">
        <span className="w-9 h-9 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center flex-shrink-0">
          <KeyRound className="w-4 h-4" aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-title-md text-on-surface">Choose your own password</p>
          <p className="mt-0.5 text-body-sm text-on-surface-variant">
            You are still on the temporary one you were given. Pick one that is easy for you to remember — it takes a minute.
          </p>

          <div className="mt-3 flex items-center gap-2">
            <Link
              to="/settings?section=security"
              onClick={answer}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:bg-primary/90 transition-colors"
            >
              <KeyRound className="w-4 h-4" aria-hidden />
              Update password
            </Link>
            <button
              type="button"
              onClick={answer}
              className="px-3 py-1.5 rounded-full text-label-md text-on-surface-variant hover:bg-on-surface/8 transition-colors"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
