import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Loader2, Unlink } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import AuthShell from '@/features/auth/components/AuthShell';
import PasswordField from '@/features/auth/components/PasswordField';
import { openResetLink, setPasswordFromLink } from '@/features/auth/api/password';
import { MIN_PASSWORD_LENGTH, passwordProblem, authErrorText } from '@/features/auth/lib/passwordRules';

const SUBMIT = 'w-full bg-primary enabled:hover:brightness-110 disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed text-on-primary font-semibold text-body-sm py-2.5 rounded-lg transition flex items-center justify-center gap-2';

// Where the button of a "Forgot your password?" email lands:
// /reset-password?token_hash=…&type=recovery. The link's one-time token is
// spent only when the person saves their new password — opening the page does
// nothing, so a mail scanner that follows the links of an email cannot use it
// up. Saving signs the person in and takes them to the Dashboard.
export default function ResetPassword() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tokenHash = params.get('type') === 'recovery' ? params.get('token_hash') : null;

  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  // The link has been taken: from here a retry only saves the password.
  const [opened, setOpened] = useState(false);
  const [fieldError, setFieldError] = useState(null);
  const [error, setError] = useState(null);
  // The link is no good (expired, used, or cut by the mail program).
  const [dead, setDead] = useState(null);
  const passwordRef = useRef(null);
  const deadRef = useRef(null);

  // A refused password sends the person back to its field once the form is
  // enabled again: a disabled field cannot take the focus.
  const refocus = useRef(false);
  useEffect(() => {
    if (busy || !refocus.current) return;
    refocus.current = false;
    passwordRef.current?.focus();
  }, [busy]);

  useEffect(() => { document.title = 'Choose a new password · Stylish PIM'; }, []);
  useEffect(() => { if (dead) deadRef.current?.focus(); }, [dead]);

  const problem = passwordProblem(password);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setTouched(true);
    if (problem) {
      passwordRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      if (!opened) {
        try {
          await openResetLink(tokenHash);
          setOpened(true);
        } catch (err) {
          setDead(authErrorText(err, 'reset'));
          return;
        }
      }
      await setPasswordFromLink(password);
      navigate('/', { replace: true });
    } catch (err) {
      if (err?.code === 'weak_password' || err?.code === 'same_password') {
        setFieldError(authErrorText(err, 'reset'));
        refocus.current = true;
      } else {
        setError(authErrorText(err, 'reset'));
      }
    } finally {
      setBusy(false);
    }
  }

  // No link in the address. Someone who is signed in changes their password in
  // Settings; anyone else is told what to do.
  if (!tokenHash && !opened) {
    if (loading) {
      return (
        <AuthShell>
          <p role="status" className="flex items-center justify-center text-body-sm text-on-surface-variant py-6">
            <Loader2 className="w-4 h-4 animate-spin mr-2" aria-hidden />
            Loading…
          </p>
        </AuthShell>
      );
    }
    if (session) return <Navigate to="/settings?section=security" replace />;
  }

  if (dead || (!tokenHash && !opened)) {
    return (
      <AuthShell>
        <div className="text-center">
          <span className="w-12 h-12 rounded-full bg-error-container text-on-error-container inline-flex items-center justify-center mb-4">
            <Unlink className="w-6 h-6" aria-hidden />
          </span>
          <h2 ref={deadRef} tabIndex={-1} className="text-title-lg text-on-surface mb-2 focus:outline-none">This link can’t be used</h2>
          <p role="alert" className="text-body-sm text-on-surface-variant">
            {dead ?? 'The address is missing its reset link. Open the button of the email again, or ask for a new one.'}
          </p>
          <Link to="/login?forgot=1" replace className={`${SUBMIT} mt-6 hover:brightness-110`}>
            Send me a new link
          </Link>
          <p className="mt-4 text-label-md">
            <Link to="/login" replace className="text-primary underline underline-offset-2">Back to sign in</Link>
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h2 className="text-title-lg text-on-surface mb-1">Choose a new password</h2>
      <p className="text-body-sm text-on-surface-variant mb-6">
        It replaces the one you had. You'll be signed in as soon as it is saved.
      </p>

      {error && (
        <div role="alert" className="mb-4 p-3 rounded-lg bg-error-container border border-error-container flex items-start gap-2 animate-banner-in">
          <AlertCircle className="w-4 h-4 text-error mt-0.5 flex-shrink-0" aria-hidden />
          <p className="text-body-sm text-on-error-container">{error}</p>
        </div>
      )}

      <form onSubmit={submit} noValidate className="space-y-4">
        <PasswordField
          ref={passwordRef}
          id="new-password"
          variant="auth"
          label="New password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. A phrase of a few words is easy to remember.`}
          autoComplete="new-password"
          value={password}
          onChange={(v) => { setPassword(v); setFieldError(null); }}
          onBlur={() => { if (password) setTouched(true); }}
          error={fieldError ?? (touched ? problem : null)}
          disabled={busy}
          enterKeyHint="done"
          autoFocus
        />
        <button type="submit" disabled={busy || !password} aria-busy={busy} className={SUBMIT}>
          {busy ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
              Saving...
            </>
          ) : (
            'Save new password'
          )}
        </button>
      </form>
    </AuthShell>
  );
}
