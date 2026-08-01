import { createContext, useContext, useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { setActivityActor } from '@/features/activity/api/activityLog';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  // undefined = not fetched yet (role unknown), null = fetched but no row.
  // The distinction keeps `loading` true until the role is known, so
  // RequireRole doesn't bounce admins off deep links while the profile loads.
  const [profile, setProfile] = useState(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 1. Initial session check (recupera de localStorage si existe)
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    // 2. Suscribirse a cambios de auth state (login, logout, refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  // Load the app profile (role + display name) whenever the user changes.
  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) {
      // Reset to "unknown", NOT null: this effect also runs before the initial
      // getSession() resolves, and null here would read as "profile fetched,
      // no row" → role drops to viewer for one render and RequireRole bounces
      // admins off deep links.
      setProfile(undefined);
      setActivityActor(null);
      return;
    }

    // Set a best-effort actor immediately from the session so any early action
    // is attributed; refine with the display name once the profile resolves.
    setActivityActor({ id: userId, email: session.user.email, name: null });

    setProfile(undefined);
    let active = true;
    supabase
      .from('profiles')
      .select('id, email, full_name, role, avatar_url')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (active) {
          setProfile(data ?? null);
          setActivityActor({
            id: userId,
            email: data?.email ?? session.user.email,
            name: data?.full_name || null,
          });
        }
      });

    return () => {
      active = false;
    };
  }, [session?.user?.id]);

  // Re-fetch the profile on demand (e.g. right after changing the photo) so
  // every consumer of `profile` updates without a full reload.
  const refreshProfile = useCallback(async () => {
    const userId = session?.user?.id;
    if (!userId) return;
    const { data } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, avatar_url')
      .eq('id', userId)
      .maybeSingle();
    setProfile(data ?? null);
  }, [session?.user?.id]);

  async function signIn(email, password, captchaToken) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
      // Only sent when the login form rendered a captcha (VITE_TURNSTILE_SITE_KEY).
      ...(captchaToken ? { options: { captchaToken } } : {}),
    });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }

  // Default to 'viewer' once the profile has resolved so we never over-grant;
  // while it's still in flight (undefined) `loading` stays true instead.
  const role = profile?.role ?? 'viewer';
  const profileLoading = Boolean(session?.user) && profile === undefined;

  const value = {
    session,
    user: session?.user ?? null,
    profile: profile ?? null,
    role,
    isAdmin: role === 'admin',
    canEdit: role === 'admin' || role === 'editor',
    // Designers can manage media (images/videos/documents) but nothing else.
    canEditMedia: role === 'admin' || role === 'editor' || role === 'designer',
    loading: loading || profileLoading,
    signIn,
    signOut,
    refreshProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Provider + hook is the standard context pairing; splitting the hook into its
// own file only to appease fast-refresh isn't worth the extra module.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
