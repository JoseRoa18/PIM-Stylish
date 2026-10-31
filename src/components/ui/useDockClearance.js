import { useEffect } from 'react';

// A bar fixed to the bottom of the window (the catalog's bulk actions, a
// sticky footer with buttons) registers here so the progress cards
// (TaskProgressDock) sit above it instead of covering its buttons: the
// tallest one is published as --dock-clear-h.
const heights = new Map();
function publish() {
  const h = heights.size ? Math.max(...heights.values()) : 0;
  document.documentElement.style.setProperty('--dock-clear-h', `${h}px`);
}

export function useDockClearance(ref, enabled = true) {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return undefined;
    const key = {};
    const set = () => { heights.set(key, el.offsetHeight + 8); publish(); };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); heights.delete(key); publish(); };
  }, [ref, enabled]);
}
