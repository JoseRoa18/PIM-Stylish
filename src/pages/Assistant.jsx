import { useSearchParams } from 'react-router-dom';
import { History, Loader2, Plus } from 'lucide-react';
import { useAssistantAccess } from '@/features/assistant/hooks/useAssistantAccess';
import AssistantChat from '@/features/assistant/components/AssistantChat';

// The assistant's own page: the same conversation as the panel that opens
// over any page (AssistantChat), with room to read. The address keeps the
// conversation (?chat=), so a reload or a shared tab opens it again.

export default function Assistant() {
  const allowed = useAssistantAccess();
  const [params, setParams] = useSearchParams();
  const chatId = params.get('chat');

  if (allowed === null) {
    return (
      <div role="status" className="flex items-center justify-center py-24 text-on-surface-variant">
        <Loader2 className="w-5 h-5 animate-spin mr-2" aria-hidden="true" />
        Loading…
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-display-lg text-on-surface">Assistant</h1>
        <p className="text-body-md text-on-surface-variant mt-1">The assistant is not available for your account yet.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <AssistantChat
        variant="page"
        chatId={chatId}
        onChatId={(id) => setParams(id ? { chat: id } : {}, { replace: true })}
        header={({ newChat, openChats, busy, canReset }) => (
          <div className="flex items-end justify-between gap-4 flex-wrap mb-6">
            <div>
              <h1 className="text-display-lg text-on-surface">Assistant</h1>
              <p className="text-body-md text-on-surface-variant mt-1">
                Ask how the PIM works or what its data says. It reads with your permissions; a change it prepares happens only when you confirm it.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={openChats}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors"
              >
                <History className="w-4 h-4" aria-hidden="true" />
                Conversations
              </button>
              <button
                type="button"
                onClick={newChat}
                disabled={busy || !canReset}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                New chat
              </button>
            </div>
          </div>
        )}
      />
    </div>
  );
}
