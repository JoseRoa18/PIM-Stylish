import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, Loader2, X } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { uploadAvatar } from '@/features/users/api/avatar';

// Pacing of the nudge: it waits until the session has settled before showing
// up, stays long enough to be read, and won't come back for a few days once
// it has been shown — a reminder, not a nag.
const APPEAR_DELAY_MS = 8_000;
const AUTO_HIDE_MS = 12_000;
const DONE_HIDE_MS = 2_500;
const REMINDER_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

// Per-user so a shared computer doesn't silence the reminder for everyone.
const storageKey = (userId) => `pim.avatarReminder.${userId}`;

function lastShownAt(userId) {
  try {
    return Number(localStorage.getItem(storageKey(userId))) || 0;
  } catch {
    return 0; // storage blocked (private mode) — behave as "never shown"
  }
}

function markShown(userId) {
  try {
    localStorage.setItem(storageKey(userId), String(Date.now()));
  } catch {
    // Not worth surfacing: the worst case is the reminder shows again sooner.
  }
}

/**
 * A small, self-dismissing reminder for people without a profile photo, which
 * also lets them add one on the spot. Rendered by the AccountMenu so it drops
 * out of the account chip — the same place the photo is managed — instead of
 * floating loose over the page. Never blocks: it auto-hides and sits below
 * dialogs.
 */
export default function AvatarNudge() {
  const { user, profile, refreshProfile } = useAuth();
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState('idle'); // idle | uploading | done
  const [error, setError] = useState(null);
  const [paused, setPaused] = useState(false);
  // Dev-only preview: shows the toast even for a profile that already has a
  // photo (see the console hatch below).
  const [forced, setForced] = useState(false);
  const fileRef = useRef(null);

  const userId = user?.id ?? null;
  // `profile` is null until it resolves, so this stays false during load.
  const needsPhoto = Boolean(profile) && !profile.avatar_url;
  // Keep it up through the "photo added" confirmation even though the profile
  // no longer needs one.
  const open = visible && (needsPhoto || status === 'done' || forced);

  const show = useCallback(() => {
    if (userId) markShown(userId);
    setStatus('idle');
    setError(null);
    setVisible(true);
  }, [userId]);

  // Arm the reminder when the profile has no photo and enough time has passed
  // since the last one.
  useEffect(() => {
    if (!userId || !needsPhoto) return;
    if (Date.now() - lastShownAt(userId) < REMINDER_INTERVAL_MS) return;
    const timer = setTimeout(show, APPEAR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [userId, needsPhoto, show]);

  // Auto-dismiss. Held open while the pointer/keyboard is on the toast, while
  // an upload is in flight, and after an error so the message can be read.
  useEffect(() => {
    if (!open || paused || status === 'uploading' || error) return;
    const timer = setTimeout(
      () => setVisible(false),
      status === 'done' ? DONE_HIDE_MS : AUTO_HIDE_MS,
    );
    return () => clearTimeout(timer);
  }, [open, paused, status, error]);

  // Local testing hatch: `avatarNudge()` in the dev console shows it right
  // away, ignoring both the delay and the every-few-days throttle.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.avatarNudge = () => {
      setStatus('idle');
      setError(null);
      setForced(true);
      setVisible(true);
    };
    return () => {
      delete window.avatarNudge;
    };
  }, []);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file || !user) return;
    setStatus('uploading');
    setError(null);
    try {
      await uploadAvatar(user.id, file, profile?.avatar_url ?? null);
      await refreshProfile();
      setStatus('done');
    } catch (err) {
      setError(err.message ?? 'Upload failed');
      setStatus('idle');
    }
  }

  if (!open) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="absolute right-0 top-full mt-2 z-30 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-outline-variant bg-surface shadow-lg animate-menu-in"
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
        {/* No avatar here: the chip right above already shows it. */}
        <span className="w-9 h-9 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center flex-shrink-0">
          {status === 'uploading' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : status === 'done' ? (
            <Check className="w-4 h-4" />
          ) : (
            <Camera className="w-4 h-4" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          {status === 'done' ? (
            <>
              <p className="text-title-md text-on-surface">Looking good</p>
              <p className="mt-0.5 text-body-sm text-on-surface-variant">
                Your profile photo is set.
              </p>
            </>
          ) : (
            <>
              <p className="text-title-md text-on-surface">Add a profile photo</p>
              <p className="mt-0.5 text-body-sm text-on-surface-variant">
                It helps your teammates recognize your edits across the catalog.
              </p>

              {error && <p className="mt-2 text-body-sm text-error">{error}</p>}

              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={status === 'uploading'}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-on-primary text-label-lg hover:bg-primary/90 transition-colors disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed"
                >
                  <Camera className="w-4 h-4" />
                  Choose photo
                </button>
                <button
                  type="button"
                  onClick={() => setVisible(false)}
                  className="px-3 py-1.5 rounded-lg text-label-lg text-on-surface-variant hover:bg-on-surface/8 transition-colors"
                >
                  Later
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleFile}
      />
    </div>
  );
}
