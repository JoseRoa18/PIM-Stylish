// What a password must be, and what the sign-in service's answers mean in
// words. The service enforces the rules (10 characters at least, and never a
// password found in a known data leak); the browser says them first so a
// person is not sent back for something it could have told them.

/** The project's own minimum (Supabase Auth → password policy; admin-users checks the same). */
export const MIN_PASSWORD_LENGTH = 10;

/** A sign-in this recent is proof enough: the person is not asked for the password they just typed. */
export const RECENT_SIGN_IN_MS = 10 * 60 * 1000;

/** What is wrong with a new password, or null. */
export function passwordProblem(password) {
  const value = String(password ?? '');
  if (!value) return 'Enter a new password.';
  if (value.length < MIN_PASSWORD_LENGTH) {
    const left = MIN_PASSWORD_LENGTH - value.length;
    return `Add ${left} more character${left === 1 ? '' : 's'}: a password has at least ${MIN_PASSWORD_LENGTH}.`;
  }
  if (!value.trim()) return 'A password cannot be only spaces.';
  return null;
}

/** True once the person has chosen a password themselves (they are not on the one an admin generated). */
export function hasOwnPassword(user) {
  return Boolean(user?.user_metadata?.password_set_at);
}

/** True when the last sign-in with a password (or a reset link) was minutes ago. */
export function signedInRecently(user, now = Date.now()) {
  const at = Date.parse(user?.last_sign_in_at ?? '');
  return Number.isFinite(at) && now - at >= -60_000 && now - at < RECENT_SIGN_IN_MS;
}

/**
 * The sign-in service's error, in words a person can act on.
 * `where` says what was being done: 'change' | 'reset' | 'forgot' | 'signin'.
 */
export function authErrorText(err, where = 'change') {
  const code = String(err?.code ?? '');
  const message = String(err?.message ?? '');
  const lower = message.toLowerCase();

  if (code === 'weak_password' || lower.includes('weak')) {
    // A short password comes back with both reasons: its length is the one to say.
    const reasons = Array.isArray(err?.reasons) ? err.reasons : [];
    const leaked = reasons.includes('pwned') || lower.includes('pwned') || lower.includes('known to be weak');
    if (leaked && !reasons.includes('length')) {
      return 'This password appears in a known data leak, so it is easy to guess. Choose a different one.';
    }
    return `Choose a longer password: at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (code === 'same_password' || lower.includes('different from the old password')) {
    return 'That is already your password. Choose a different one.';
  }
  if (code === 'otp_expired' || lower.includes('invalid or has expired') || lower.includes('token has expired')) {
    return 'This link has expired or was already used. Ask for a new one.';
  }
  if (code === 'email_address_not_authorized' || lower.includes('not authorized')) {
    return 'The PIM cannot send email to this address yet. Ask an administrator to reset your password.';
  }
  if (code === 'over_email_send_rate_limit' || lower.includes('email rate limit')) {
    return 'Too many emails were sent in the last hour. Try again later, or ask an administrator to reset your password.';
  }
  if (code === 'over_request_rate_limit' || lower.includes('for security purposes') || lower.includes('rate limit')) {
    return 'Wait a minute before trying again.';
  }
  if (lower.includes('captcha')) {
    return 'Verification failed. Complete the challenge and try again.';
  }
  if (code === 'session_not_found' || lower.includes('session missing') || lower.includes('not authenticated')) {
    return where === 'reset'
      ? 'This link has expired or was already used. Ask for a new one.'
      : 'Your session has ended. Sign in again.';
  }
  if (lower.includes('failed to fetch') || lower.includes('networkerror')) {
    return 'The PIM could not be reached. Check your connection and try again.';
  }
  return message || 'Something went wrong. Try again.';
}
