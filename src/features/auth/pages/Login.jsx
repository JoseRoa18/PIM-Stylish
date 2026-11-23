import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams, Navigate } from 'react-router-dom';
import { Lock, Mail, AlertCircle, Loader2, MailCheck, ArrowLeft } from 'lucide-react';
import { MorphIcon } from 'morphicons/react';
import { Eye, EyeOff } from 'lucide';
import { useAuth } from '@/features/auth/AuthContext';
import AuthShell from '@/features/auth/components/AuthShell';
import TurnstileWidget from '@/features/auth/components/TurnstileWidget';
import { sendPasswordReset } from '@/features/auth/api/password';
import { authErrorText } from '@/features/auth/lib/passwordRules';

// Optional bot protection: set VITE_TURNSTILE_SITE_KEY (here + Vercel) AND the
// matching secret in Supabase Auth → Bot and Abuse Protection. Without the
// var, the login works exactly as before and no third-party script loads.
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;

const FIELD = 'w-full pl-10 py-2.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:bg-surface-container-low disabled:text-on-surface-variant';
const SUBMIT = 'w-full bg-primary enabled:hover:brightness-110 disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed text-on-primary font-semibold text-body-sm py-2.5 rounded-lg transition flex items-center justify-center gap-2';

export default function Login() {
  const { signIn, session } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // 'signin' | 'forgot' (asking for the reset email) | 'sent' (it was asked for).
  // "Forgot your password?" is an address of its own (/login?forgot=1), so the
  // browser's Back returns to the sign-in form, and the reset page sends people
  // there when their link has expired.
  const [sent, setSent] = useState(false);
  const view = sent ? 'sent' : params.get('forgot') ? 'forgot' : 'signin';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Kept with the view it happened in: a sign-in error is not shown over the reset form.
  const [failure, setFailure] = useState(null); // { view, text }
  const error = failure?.view === view ? failure.text : null;
  const setError = (text) => setFailure(text ? { view, text } : null);
  const [captchaToken, setCaptchaToken] = useState(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  // The check couldn't load: don't keep the button disabled forever waiting
  // for its token — the server still enforces the captcha.
  const [captchaFailed, setCaptchaFailed] = useState(false);
  const headingRef = useRef(null);
  const emailRef = useRef(null);

  // A change of view is a new step, and the focus goes where the person goes
  // on: the email box of a form (the reset form's help is read with it), the
  // heading of "Check your email". The first view keeps the page's own start.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    (view === 'sent' ? headingRef : emailRef).current?.focus();
  }, [view]);

  // If already logged in, redirect away from login
  if (session) {
    return <Navigate to="/" replace />;
  }

  // Captcha tokens are single-use — request a fresh challenge for the retry.
  function freshCaptcha() {
    if (!TURNSTILE_SITE_KEY) return;
    setCaptchaToken(null);
    setCaptchaReset((n) => n + 1);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await signIn(email, password, captchaToken ?? undefined);
      navigate('/', { replace: true });
    } catch (err) {
      setError(translateError(err.message));
      freshCaptcha();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleForgot(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await sendPasswordReset(email, { captchaToken: captchaToken ?? undefined });
      setSent(true);
    } catch (err) {
      setError(authErrorText(err, 'forgot'));
    } finally {
      freshCaptcha();
      setSubmitting(false);
    }
  }

  const captcha = TURNSTILE_SITE_KEY && (
    <>
      <TurnstileWidget
        siteKey={TURNSTILE_SITE_KEY}
        onToken={setCaptchaToken}
        onError={() => setCaptchaFailed(true)}
        resetSignal={captchaReset}
      />
      {captchaFailed && !captchaToken && (
        <p role="status" className="text-center text-label-md text-on-surface-variant">
          The security check didn't load. You can still go on — if it's refused, reload the page.
        </p>
      )}
    </>
  );
  const waitingForCaptcha = TURNSTILE_SITE_KEY && !captchaToken && !captchaFailed;

  const errorBanner = error && (
    <div role="alert" className="mb-4 p-3 rounded-lg bg-error-container border border-error-container flex items-start gap-2 animate-banner-in">
      <AlertCircle className="w-4 h-4 text-error mt-0.5 flex-shrink-0" aria-hidden />
      <p id="login-error" className="text-body-sm text-on-error-container">{error}</p>
    </div>
  );

  const emailField = (
    <div>
      <label htmlFor="email" className="block text-body-sm font-medium text-on-surface mb-1.5">
        Email
      </label>
      <div className="relative">
        <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" aria-hidden />
        <input
          ref={emailRef}
          id="email"
          name="email"
          type="email"
          required
          // "username": what a password manager files the sign-in under.
          autoComplete="username"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          aria-invalid={error ? true : undefined}
          aria-describedby={[view === 'forgot' ? 'forgot-help' : null, error ? 'login-error' : null].filter(Boolean).join(' ') || undefined}
          className={`${FIELD} pr-3`}
          placeholder="you@stylishkb.com"
        />
      </div>
    </div>
  );

  if (view === 'sent') {
    return (
      <AuthShell>
        <div className="text-center">
          <span className="w-12 h-12 rounded-full bg-primary-container text-on-primary-container inline-flex items-center justify-center mb-4">
            <MailCheck className="w-6 h-6" aria-hidden />
          </span>
          <h2 ref={headingRef} tabIndex={-1} className="text-title-lg text-on-surface mb-2 focus:outline-none">Check your email</h2>
          <p role="status" className="text-body-sm text-on-surface-variant">
            If there is a PIM account for <span className="text-on-surface font-medium [overflow-wrap:anywhere]">{email}</span>, a link to choose a new password is on its way. It works for 1 hour, and only once.
          </p>
          <p className="mt-3 text-body-sm text-on-surface-variant">
            Nothing after a few minutes? Look in the spam folder, or ask an administrator to reset your password.
          </p>
          <Link to="/login" replace onClick={() => setSent(false)} className={`${SUBMIT} mt-6 hover:brightness-110`}>
            Back to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (view === 'forgot') {
    return (
      <AuthShell>
        <h2 className="text-title-lg text-on-surface mb-1">Reset your password</h2>
        <p id="forgot-help" className="text-body-sm text-on-surface-variant mb-6">
          Enter the email you sign in with. We'll send you a link to choose a new password.
        </p>

        {errorBanner}

        <form onSubmit={handleForgot} className="space-y-4">
          {emailField}
          {captcha}
          <button type="submit" disabled={submitting || !email || waitingForCaptcha} className={SUBMIT}>
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                Sending the link...
              </>
            ) : (
              'Send reset link'
            )}
          </button>
        </form>

        <p className="mt-4 text-center text-label-md">
          <Link to="/login" className="inline-flex items-center gap-1.5 text-primary underline underline-offset-2">
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden />
            Back to sign in
          </Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h2 className="text-title-lg text-on-surface mb-1">Sign in</h2>
      <p className="text-body-sm text-on-surface-variant mb-6">
        Enter your credentials to continue
      </p>

      {errorBanner}

      <form onSubmit={handleSubmit} className="space-y-4">
        {emailField}

        <div>
          <label htmlFor="password" className="block text-body-sm font-medium text-on-surface mb-1.5">
            Password
          </label>
          <div className="relative">
            <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" aria-hidden />
            <input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
              className={`${FIELD} pr-10`}
              placeholder="Enter your password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              // 24px target around the 16px eye: p-1 with right-2 keeps
              // the icon exactly where right-3 put it.
              className="absolute right-2 p-1 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface transition-colors"
            >
              <MorphIcon icon={showPassword ? EyeOff : Eye} size={16} reducedMotion="user" />
            </button>
          </div>
        </div>

        {captcha}

        <button
          type="submit"
          disabled={submitting || !email || !password || waitingForCaptcha}
          className={SUBMIT}
        >
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
              Signing in...
            </>
          ) : (
            'Sign in'
          )}
        </button>
      </form>

      <p className="mt-4 text-center text-label-md">
        <Link to="/login?forgot=1" className="text-primary underline underline-offset-2">
          Forgot your password?
        </Link>
      </p>
    </AuthShell>
  );
}

function translateError(message) {
  // Map common Supabase auth errors to friendly text
  if (message?.includes('Invalid login credentials')) {
    return 'Invalid email or password.';
  }
  if (message?.includes('Email not confirmed')) {
    return 'Email not confirmed. Check your inbox for the confirmation link.';
  }
  if (message?.includes('Email rate limit')) {
    return 'Too many attempts. Wait a moment and try again.';
  }
  if (message?.toLowerCase().includes('captcha')) {
    return 'Verification failed. Complete the challenge and try again.';
  }
  return message || 'Something went wrong. Try again.';
}
