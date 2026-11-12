import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { History, Maximize2, Plus, X } from 'lucide-react';
import AssistantChat from './AssistantChat';
import { setAssistantPanel } from '../lib/panel';

// The assistant over any page (user, 2026-11-11: "abrirlo desde cualquier
// página"): a panel on the right, under the top bar, opened from the top
// bar's button. It knows which page is open — each question travels with the
// page's address and title — so "this product" needs no SKU. It is not a
// modal: the page behind stays usable, and the conversation stays while the
// person moves between pages (the panel is hidden, not unmounted).

const ICON_BUTTON = 'p-2 rounded-full text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors disabled:opacity-40';

export default function AssistantPanel({ open }) {
  const { pathname } = useLocation();
  const [chatId, setChatId] = useState(null);

  // The assistant's own page is the same conversation with more room: the panel gives way.
  useEffect(() => {
    if (pathname === '/assistant') setAssistantPanel(false);
  }, [pathname]);

  function close() {
    setAssistantPanel(false);
    document.getElementById('assistant-launcher')?.focus();
  }

  return (
    <aside
      id="assistant-panel"
      aria-label="Assistant"
      hidden={!open}
      onKeyDown={(e) => {
        // Escape closes the panel — unless a dialog opened from it is the one answering.
        if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"][aria-modal="true"]:not(#app-sidebar)')) close();
      }}
      className="fixed top-16 right-0 bottom-0 z-30 w-full sm:w-[440px] bg-surface border-l border-outline-variant shadow-xl"
    >
      <AssistantChat
        variant="panel"
        chatId={chatId}
        onChatId={setChatId}
        focusSignal={open ? 1 : 0} // the question box takes the focus each time the panel opens
        pageContext={() => ({ path: `${window.location.pathname}${window.location.search}`, title: document.title.replace(/\s*·\s*Stylish PIM$/, '') })}
        header={({ newChat, openChats, busy, canReset }) => (
          <div className="flex-shrink-0 flex items-center justify-between gap-2 pl-4 pr-2 py-2 border-b border-outline-variant">
            <h2 className="text-title-md text-on-surface">Assistant</h2>
            <div className="flex items-center">
              <button type="button" onClick={newChat} disabled={busy || !canReset} aria-label="New chat" title="New chat" className={ICON_BUTTON}>
                <Plus className="w-4 h-4" aria-hidden="true" />
              </button>
              <button type="button" onClick={openChats} aria-label="Conversations" title="Conversations" className={ICON_BUTTON}>
                <History className="w-4 h-4" aria-hidden="true" />
              </button>
              <Link
                to={chatId ? `/assistant?chat=${chatId}` : '/assistant'}
                aria-label="Open in the full page"
                title="Open in the full page"
                className={ICON_BUTTON}
              >
                <Maximize2 className="w-4 h-4" aria-hidden="true" />
              </Link>
              <button type="button" onClick={close} aria-label="Close the assistant" title="Close" className={ICON_BUTTON}>
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      />
    </aside>
  );
}
