import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { setActivityActor } from '@/features/activity/api/activityLog';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
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
      setProfile(null);
      setActivityActor(null);
      return;
    }

    // Set a best-effort actor immediately from the session so any early action
    // is attributed; refine with the display name once the profile resolves.
    setActivityActor({ id: userId, email: session.user.email, name: null });

    let active = true;
    supabase
      .from('profiles')
      .select('id, email, full_name, role')
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

  async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }

  // Default to 'viewer' until the profile resolves so we never over-grant.
  const role = profile?.role ?? 'viewer';

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    role,
    isAdmin: role === 'admin',
    canEdit: role === 'admin' || role === 'editor',
    loading,
    signIn,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
