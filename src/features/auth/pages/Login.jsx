import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { Lock, Mail, AlertCircle, Loader2 } from 'lucide-react';
import { MorphIcon } from 'morphicons/react';
import { Eye, EyeOff } from 'lucide';
import { useAuth } from '@/features/auth/AuthContext';
import ThemeToggle from '@/components/ui/ThemeToggle';
import TurnstileWidget from '@/features/auth/components/TurnstileWidget';

// Optional bot protection: set VITE_TURNSTILE_SITE_KEY (here + Vercel) AND the
// matching secret in Supabase Auth → Bot and Abuse Protection. Without the
// var, the login works exactly as before and no third-party script loads.
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;

export default function Login() {
  const { signIn, session } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [captchaToken, setCaptchaToken] = useState(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  // If already logged in, redirect away from login
  if (session) {
    return <Navigate to="/" replace />;
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
      // Captcha tokens are single-use — request a fresh challenge for the retry.
      if (TURNSTILE_SITE_KEY) {
        setCaptchaToken(null);
        setCaptchaReset((n) => n + 1);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative min-h-screen bg-background flex items-center justify-center p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        {/* Brand header */}
        <div className="mb-8 text-center">
          {/* Icon pair toggled via the app's .dark class — the `dark:` variant
              tracks the OS scheme here, not the in-app theme toggle. */}
          <img src="/brand/icon.svg" alt="" className="w-16 h-16 mx-auto mb-3 [.dark_&]:hidden" />
          <img src="/brand/icon-dark.svg" alt="" className="w-16 h-16 mx-auto mb-3 hidden [.dark_&]:block" />
          <h1 className="text-headline-md text-on-surface">Stylish PIM</h1>
          <p className="text-on-surface-variant text-body-sm mt-1">
            Centralized Product Management
          </p>
        </div>

        {/* Login card */}
        <div className="bg-surface rounded-2xl shadow-sm border border-outline-variant p-8">
          <h2 className="text-title-lg text-on-surface mb-1">Sign in</h2>
          <p className="text-body-sm text-on-surface-variant mb-6">
            Enter your credentials to continue
          </p>

          {error && (
            <div className="mb-4 p-3 rounded-lg bg-error-container border border-error-container flex items-start gap-2 animate-banner-in">
              <AlertCircle className="w-4 h-4 text-error mt-0.5 flex-shrink-0" />
              <p className="text-body-sm text-on-error-container">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-body-sm font-medium text-on-surface mb-1.5">
                Email
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={submitting}
                  className="w-full pl-10 pr-3 py-2.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:bg-surface-container-low disabled:text-on-surface-variant"
                  placeholder="you@stylishkb.com"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-body-sm font-medium text-on-surface mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  className="w-full pl-10 pr-10 py-2.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:bg-surface-container-low disabled:text-on-surface-variant"
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface transition-colors"
                >
                  <MorphIcon icon={showPassword ? EyeOff : Eye} size={16} reducedMotion="user" />
                </button>
              </div>
            </div>

            {TURNSTILE_SITE_KEY && (
              <TurnstileWidget
                siteKey={TURNSTILE_SITE_KEY}
                onToken={setCaptchaToken}
                resetSignal={captchaReset}
              />
            )}

            <button
              type="submit"
              disabled={submitting || !email || !password || (TURNSTILE_SITE_KEY && !captchaToken)}
              className="w-full bg-primary enabled:hover:brightness-110 disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed text-on-primary font-semibold text-body-sm py-2.5 rounded-lg transition flex items-center justify-center gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>

          <p className="mt-4 text-center text-label-md text-on-surface-variant">
            Forgot your password? Ask an administrator to reset it.
          </p>
        </div>

        {/* Footer */}
        <p className="text-center text-label-md text-on-surface-variant mt-6">
          Stylish International Inc. · Internal product management system
        </p>
      </div>
    </div>
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