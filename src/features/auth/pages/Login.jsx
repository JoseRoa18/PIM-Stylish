import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { Lock, Mail, AlertCircle, Loader2 } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';

export default function Login() {
  const { signIn, session } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // If already logged in, redirect away from login
  if (session) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await signIn(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(translateError(err.message));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Brand header */}
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary text-on-primary text-2xl font-bold mb-4">
            S
          </div>
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
            <div className="mb-4 p-3 rounded-lg bg-error-container border border-error-container flex items-start gap-2">
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
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  className="w-full pl-10 pr-3 py-2.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:bg-surface-container-low disabled:text-on-surface-variant"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || !email || !password}
              className="w-full bg-primary hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-on-primary font-semibold text-body-sm py-2.5 rounded-lg transition-opacity flex items-center justify-center gap-2"
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
  return message || 'Something went wrong. Try again.';
}