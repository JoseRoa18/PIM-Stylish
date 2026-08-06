import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, Trash2, AlertCircle } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import Avatar from '@/components/ui/Avatar';
import AvatarNudge from '@/components/layout/AvatarNudge';
import { uploadAvatar, removeAvatar } from '@/features/users/api/avatar';
import { nameFromEmail } from '@/lib/format';

const ROLE_LABELS = {
  admin: 'Admin',
  editor: 'Editor',
  designer: 'Designer',
  viewer: 'Viewer',
};

/**
 * Topbar account menu: shows who is signed in and lets them manage their own
 * profile photo. Photo changes go through features/users/api/avatar.js and
 * refresh the shared profile so every Avatar in the app updates at once.
 */
export default function AccountMenu() {
  const { user, profile, role, refreshProfile } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const displayName = profile?.full_name?.trim() || nameFromEmail(user?.email);
  const avatarUrl = profile?.avatar_url ?? null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file || !user) return;
    setBusy(true);
    setError(null);
    try {
      await uploadAvatar(user.id, file, avatarUrl);
      await refreshProfile();
    } catch (err) {
      setError(err.message ?? 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!user || !avatarUrl) return;
    setBusy(true);
    setError(null);
    try {
      await removeAvatar(user.id, avatarUrl);
      await refreshProfile();
    } catch (err) {
      setError(err.message ?? 'Could not remove the photo');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        aria-expanded={open}
        title={user?.email}
        className="flex items-center gap-2 p-1 pr-3 rounded-full hover:bg-surface-container-high transition-colors"
      >
        <Avatar name={profile?.full_name} email={user?.email} src={avatarUrl} size="sm" />
        {/* The name reads better than the address here; the full email is still
            in the panel below and on hover. */}
        <span className="text-label-md text-on-surface hidden sm:inline max-w-[12rem] truncate">
          {displayName}
        </span>
      </button>

      {/* The "add a photo" reminder hangs off this same chip. Opening the menu
          retires it — they're already where the photo is managed. */}
      {!open && <AvatarNudge />}

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-30 w-72 rounded-xl border border-outline-variant bg-surface shadow-lg animate-menu-in">
            <div className="px-5 pt-5 pb-4 flex flex-col items-center text-center">
              <div className="relative">
                <Avatar name={profile?.full_name} email={user?.email} src={avatarUrl} size="xl" />
                {/* Fixed dark scrim over the photo in both themes (overlay exception). */}
                {busy && (
                  <span className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center">
                    <Loader2 className="w-5 h-5 animate-spin text-white" />
                  </span>
                )}
              </div>
              <p className="mt-3 text-title-md text-on-surface">{displayName}</p>
              <p className="text-body-sm text-on-surface-variant break-all">{user?.email}</p>
              <span className="mt-2 px-2 py-0.5 rounded-full bg-secondary-container text-on-secondary-container text-label-sm font-medium">
                {ROLE_LABELS[role] ?? role}
              </span>
            </div>

            {error && (
              <p className="mx-4 mb-2 px-3 py-2 rounded-lg bg-error-container/50 text-error text-body-sm flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </p>
            )}

            <div className="border-t border-outline-variant py-1">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                className="w-full flex items-center gap-2.5 px-5 py-2.5 text-body-sm text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
              >
                <Camera className="w-4 h-4 text-on-surface-variant" />
                {avatarUrl ? 'Change photo' : 'Upload photo'}
              </button>
              {avatarUrl && (
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={busy}
                  className="w-full flex items-center gap-2.5 px-5 py-2.5 text-body-sm text-error hover:bg-error-container/40 transition-colors disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" />
                  Remove photo
                </button>
              )}
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handleFile}
            />
          </div>
        </>
      )}
    </div>
  );
}
