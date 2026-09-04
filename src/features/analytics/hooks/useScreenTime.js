import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';

const TICK_MS = 60_000;      // one ping per minute of active screen time
const IDLE_MS = 2 * 60_000;  // no interaction for 2 min = idle, no ping

/**
 * Counts active time in the PIM for the signed-in person: once a minute,
 * while the tab is visible and there was mouse/keyboard/touch activity in
 * the last two minutes, one minute is added to today's row (server-side
 * dedupe keeps a reload from counting twice). Feeds Analytics → Team.
 */
export function useScreenTime(enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    let lastInput = Date.now();
    const mark = () => { lastInput = Date.now(); };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'pointermove'];
    for (const e of events) window.addEventListener(e, mark, { passive: true });

    const ping = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastInput > IDLE_MS) return;
      supabase.rpc('ping_screen_time').then(() => {}, () => {});
    };
    ping();
    const timer = setInterval(ping, TICK_MS);
    return () => {
      clearInterval(timer);
      for (const e of events) window.removeEventListener(e, mark);
    };
  }, [enabled]);
}
