import { createClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { logActivity, getActivityActor, setActivityActor } from '@/features/activity/api/activityLog';

// A person's own password (user, 2026-11-23): changed from Settings → Security,
// or chosen again from the link of a "Forgot your password?" email. Both end in
// the same save, which also notes that the password is now the person's own
// (user_metadata.password_set_at) — what retires the "choose your own password"
// reminder. An admin's reset (admin-users) clears that note again.

const stamp = () => ({ password_set_at: new Date().toISOString() });

function noteActor(user) {
  // The reset page saves seconds after the link signed the person in: the
  // audit trail may not know them yet.
  if (user && !getActivityActor()) setActivityActor({ id: user.id, email: user.email, name: null });
}

async function savePassword(password, summary) {
  const { data, error } = await supabase.auth.updateUser({ password, data: stamp() });
  if (error) throw error;
  noteActor(data?.user);
  logActivity({
    action: 'update',
    entityType: 'user',
    entityId: data?.user?.id ?? null,
    summary,
  });
  return data?.user ?? null;
}

/**
 * Is this the account's current password? Asked of the sign-in service on a
 * client of its own, which keeps nothing: the page's session is not touched,
 * and the session this check opens is closed again at once.
 */
async function checkCurrentPassword(email, currentPassword) {
  const probe = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'pim-password-check' },
  });
  const { error } = await probe.auth.signInWithPassword({ email, password: currentPassword });
  if (error) {
    if (String(error.message ?? '').includes('Invalid login credentials')) {
      const wrong = new Error('That is not your current password.');
      wrong.field = 'current';
      throw wrong;
    }
    throw error;
  }
  await probe.auth.signOut({ scope: 'local' }).catch(() => {});
}

/**
 * Settings → Security. `currentPassword` is checked first when it is given
 * (the form asks for it unless the person signed in minutes ago).
 */
export async function changeOwnPassword({ email, password, currentPassword = null }) {
  if (currentPassword !== null) await checkCurrentPassword(email, currentPassword);
  return savePassword(password, 'Changed their own password');
}

/**
 * "Forgot your password?": asks for the email with the link. The answer is the
 * same whether the address has an account or not, so the form cannot be used
 * to find out who has one.
 */
export async function sendPasswordReset(email, { captchaToken } = {}) {
  const { error } = await supabase.auth.resetPasswordForEmail(String(email ?? '').trim(), {
    // The email's button comes back to this address with the link's own token.
    redirectTo: `${window.location.origin}/reset-password`,
    ...(captchaToken ? { captchaToken } : {}),
  });
  if (error) throw error;
}

/**
 * The reset email's link: signs the person in with its one-time token. Done
 * when they press the button, never on arrival — mail scanners open the links
 * of an email, and a link that worked by being opened would be spent by them.
 */
export async function openResetLink(tokenHash) {
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
  if (error) throw error;
  return data?.session ?? null;
}

/** The new password of someone who came through the reset link. */
export async function setPasswordFromLink(password) {
  return savePassword(password, 'Chose a new password from a reset link');
}
