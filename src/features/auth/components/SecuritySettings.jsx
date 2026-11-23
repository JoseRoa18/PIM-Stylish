import { useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import PasswordField from '@/features/auth/components/PasswordField';
import { changeOwnPassword, sendPasswordReset } from '@/features/auth/api/password';
import { MIN_PASSWORD_LENGTH, passwordProblem, hasOwnPassword, signedInRecently, authErrorText } from '@/features/auth/lib/passwordRules';
import { formatDate } from '@/lib/format';

// Settings → Security (user, 2026-11-23: "que le permita a los usuarios poder
// actualizar su contraseña … la contraseña que se crea al inicio es muy difícil
// y muy loca"). Every role: a person changes their own password here.
//
// The current password is asked only when the sign-in is not fresh: someone
// who typed it minutes ago — a new person on their first visit — just chooses
// the new one; a session that has been open for days proves it first, so a
// computer left unlocked is not enough to take the account.
export default function SecuritySettings() {
  const { user } = useAuth();
  // Decided once, when the section opens: the form must not grow a field while it is being filled.
  const [askCurrent] = useState(() => !signedInRecently(user));
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [currentError, setCurrentError] = useState(null);
  const [passwordError, setPasswordError] = useState(null); // the service's own refusal of the new password
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [link, setLink] = useState(null); // null | 'sending' | 'sent' | { error }
  const currentRef = useRef(null);
  const passwordRef = useRef(null);
  // The field a refused save sends the person back to. It takes the focus once
  // the form is enabled again: a disabled field cannot.
  const focusNext = useRef(null);
  useEffect(() => {
    if (busy || !focusNext.current) return;
    focusNext.current.current?.focus();
    focusNext.current = null;
  }, [busy]);

  const email = user?.email ?? '';
  const own = hasOwnPassword(user);
  const problem = passwordProblem(password);
  const shownPasswordError = passwordError ?? (touched ? problem : null);

  async function submit(e) {
    e.preventDefault();
    setDone(false);
    setError(null);
    setTouched(true);
    if (askCurrent && !current) {
      setCurrentError('Enter your current password.');
      currentRef.current?.focus();
      return;
    }
    if (problem) {
      passwordRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await changeOwnPassword({ email, password, currentPassword: askCurrent ? current : null });
      setCurrent('');
      setPassword('');
      setTouched(false);
      setDone(true);
    } catch (err) {
      if (err?.field === 'current') {
        setCurrentError(err.message);
        focusNext.current = currentRef;
      } else if (err?.code === 'weak_password' || err?.code === 'same_password') {
        setPasswordError(authErrorText(err, 'change'));
        focusNext.current = passwordRef;
      } else {
        setError(authErrorText(err, 'change'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function emailLink() {
    setLink('sending');
    try {
      await sendPasswordReset(email);
      setLink('sent');
    } catch (err) {
      setLink({ error: authErrorText(err, 'forgot') });
    }
  }

  return (
    <section aria-labelledby="security-password" className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary-container text-on-primary-container flex items-center justify-center flex-shrink-0">
          <KeyRound className="w-5 h-5" strokeWidth={2} aria-hidden />
        </div>
        <div className="min-w-0">
          <h2 id="security-password" className="text-title-md text-on-surface font-semibold">Password</h2>
          <p className="text-body-sm text-on-surface-variant mt-0.5 max-w-md">
            The password of your PIM account{email ? <>, <span className="text-on-surface [overflow-wrap:anywhere]">{email}</span></> : null}. Choose one that is easy for you to remember — a phrase of a few words works well.
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-surface-container-low/60 p-4">
        <p className="text-body-sm text-on-surface-variant mb-4">
          {own
            ? <>You chose your password on {formatDate(user.user_metadata.password_set_at)}.</>
            : <>You are still on the temporary password you were given. Choose your own here.</>}
        </p>

        <form onSubmit={submit} noValidate className="space-y-4 max-w-sm">
          {/* Not shown, but it tells the browser's password manager which account
              the new password belongs to, so it updates the one it saved. */}
          <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />

          {askCurrent && (
            <div>
              <PasswordField
                ref={currentRef}
                id="current-password"
                label="Current password"
                autoComplete="current-password"
                value={current}
                onChange={(v) => { setCurrent(v); setCurrentError(null); }}
                error={currentError}
                disabled={busy}
                enterKeyHint="next"
              />
              <div className="mt-1.5 text-body-sm text-on-surface-variant">
                {link === 'sent' ? (
                  <p role="status">A link to choose a new password is on its way to {email}. It works for 1 hour.</p>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={emailLink}
                      disabled={link === 'sending' || busy}
                      className="text-primary underline underline-offset-2 disabled:opacity-50"
                    >
                      {link === 'sending' ? 'Sending the link…' : 'Don’t remember it? Email me a link instead'}
                    </button>
                    {link?.error && <p role="alert" className="mt-1 text-error">{link.error}</p>}
                  </>
                )}
              </div>
            </div>
          )}

          <PasswordField
            ref={passwordRef}
            id="new-password"
            label="New password"
            hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
            autoComplete="new-password"
            value={password}
            onChange={(v) => { setPassword(v); setPasswordError(null); setDone(false); }}
            onBlur={() => { if (password) setTouched(true); }}
            error={shownPasswordError}
            disabled={busy}
            enterKeyHint="done"
          />

          <button
            type="submit"
            disabled={busy || !password || (askCurrent && !current)}
            aria-busy={busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />}
            Update password
          </button>
        </form>

        {done && (
          <p role="status" className="mt-4 text-body-sm rounded-lg px-3 py-2 inline-flex items-start gap-2 bg-surface-container text-on-surface-variant">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5 text-success" aria-hidden />
            Your password is updated. Use it the next time you sign in.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 text-body-sm rounded-lg px-3 py-2 inline-flex items-start gap-2 bg-error-container/60 text-on-error-container">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
