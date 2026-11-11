import { useEffect, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { getAssistantSetting, mayUseAssistant } from '../api/assistant';

/**
 * May the signed-in person use the assistant? null while it is not known yet
 * (the menu shows nothing until then), then true / false.
 */
export function useAssistantAccess() {
  const { profile, user, loading } = useAuth();
  const email = profile?.email ?? user?.email ?? null;
  const [allowed, setAllowed] = useState(null);

  useEffect(() => {
    if (loading) return undefined;
    let active = true;
    getAssistantSetting()
      .then((setting) => { if (active) setAllowed(mayUseAssistant(setting, email)); })
      .catch(() => { if (active) setAllowed(false); });
    return () => { active = false; };
  }, [email, loading]);

  return allowed;
}
