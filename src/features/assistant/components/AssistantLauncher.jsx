import { lazy, Suspense, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { useAssistantAccess } from '../hooks/useAssistantAccess';
import { toggleAssistantPanel, useAssistantPanel } from '../lib/panel';

// The two small pieces the shell carries for the assistant: the top bar's
// button, and the place the panel is mounted. The panel's own code (the chat,
// its Markdown, its cards) is downloaded the first time it is opened.

const AssistantPanel = lazy(() => import('./AssistantPanel'));

/** The top bar's button — only for the people on the assistant's list, and not on the assistant's own page. */
export function AssistantLauncher() {
  const allowed = useAssistantAccess();
  const open = useAssistantPanel();
  const { pathname } = useLocation();
  if (allowed !== true || pathname === '/assistant') return null;
  return (
    <button
      id="assistant-launcher"
      type="button"
      onClick={toggleAssistantPanel}
      aria-label="Assistant"
      aria-expanded={open}
      title="Ask the assistant"
      className={`p-2 rounded-full transition-colors ${open ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'}`}
    >
      <MessageCircle className="w-5 h-5" aria-hidden="true" />
    </button>
  );
}

/** Where the panel lives (AppShell). Mounted at its first opening, then kept, so a conversation survives closing it and changing page. */
export function AssistantPanelHost() {
  const open = useAssistantPanel();
  const [mounted, setMounted] = useState(false);
  if (open && !mounted) setMounted(true);
  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <AssistantPanel open={open} />
    </Suspense>
  );
}
