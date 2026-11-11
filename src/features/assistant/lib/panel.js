import { useSyncExternalStore } from 'react';

// Is the assistant's panel open? A plain store, so the top bar's button and
// the panel itself (mounted in AppShell) agree without a context around the
// whole app.

let open = false;
const listeners = new Set();

export function setAssistantPanel(next) {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}
export const toggleAssistantPanel = () => setAssistantPanel(!open);

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useAssistantPanel = () => useSyncExternalStore(subscribe, () => open);
