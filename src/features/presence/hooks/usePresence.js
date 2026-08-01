import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/features/auth/AuthContext';

/**
 * Live "who's in the PIM right now" via Realtime presence. Every signed-in
 * client announces its profile on a shared channel — nothing is written to
 * the database and the list updates the moment someone opens or closes the
 * app. Keyed by user id, so several tabs from the same person collapse into
 * one entry.
 */
export function usePresence() {
  const { user, profile } = useAuth();
  const [online, setOnline] = useState([]);

  const userId = user?.id;
  const email = user?.email ?? null;
  const name = profile?.full_name || null;
  const avatarUrl = profile?.avatar_url ?? null;

  useEffect(() => {
    if (!userId) return undefined;

    const channel = supabase.channel('pim-presence', {
      config: { presence: { key: userId } },
    });

    const refresh = () => {
      const state = channel.presenceState();
      setOnline(
        Object.entries(state).map(([id, metas]) => ({
          id,
          name: metas[0]?.name ?? null,
          email: metas[0]?.email ?? null,
          avatar_url: metas[0]?.avatar_url ?? null,
        })),
      );
    };

    channel.on('presence', { event: 'sync' }, refresh).subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ name, email, avatar_url: avatarUrl });
      }
    });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, email, name, avatarUrl]);

  return online;
}
